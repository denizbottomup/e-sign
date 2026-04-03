const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const DATA_DIR = path.join(__dirname, "..", "data");
const ESIGN_FILE = path.join(DATA_DIR, "esign-documents.json");
const ESIGN_PDF_DIR = path.join(DATA_DIR, "esign-pdfs");

// Ensure dirs
if (!fs.existsSync(ESIGN_PDF_DIR)) fs.mkdirSync(ESIGN_PDF_DIR, { recursive: true });

function loadDocs() {
  try {
    if (fs.existsSync(ESIGN_FILE)) return JSON.parse(fs.readFileSync(ESIGN_FILE, "utf8"));
  } catch (e) { console.warn("[VEKALET] Yükleme hatası:", e.message); }
  return [];
}

function saveDocs(docs) {
  fs.writeFileSync(ESIGN_FILE, JSON.stringify(docs, null, 2));
}

// ── Deep PDF Scan — extract all text with exact coordinates ──
async function scanPdfTextPositions(pdfBuffer) {
  const tmpPdf = path.join(require("os").tmpdir(), `vekalet-scan-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPdf, pdfBuffer);

  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    const pythonScript = `
import pdfplumber, json, sys
pdf = pdfplumber.open(sys.argv[1])
result = {"pages": len(pdf.pages), "width": pdf.pages[-1].width, "height": pdf.pages[-1].height, "words": []}
# Scan last 2 pages (signature pages)
for pageIdx in range(max(0, len(pdf.pages)-2), len(pdf.pages)):
    page = pdf.pages[pageIdx]
    for w in page.extract_words():
        y_from_bottom = round(page.height - w["top"])
        result["words"].append({"page": pageIdx+1, "text": w["text"], "x": round(w["x0"]), "y": y_from_bottom, "x1": round(w["x1"]), "y_top": round(w["top"]), "y_bottom": round(w["bottom"])})
print(json.dumps(result))
`;
    execFile("python3", ["-c", pythonScript, tmpPdf], { timeout: 10000 }, (err, stdout) => {
      try { fs.unlinkSync(tmpPdf); } catch {}
      if (err) {
        console.warn("[VEKALET] Python tarama başarısız:", err.message);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        console.warn("[VEKALET] Python tarama ayrıştırma başarısız");
        resolve(null);
      }
    });
  });
}

// ── Coordinate System Notes ──
// pdfplumber: y=0 is TOP of page, y increases downward
//   w["top"] = distance from page top to text top edge
//   w["bottom"] = distance from page top to text bottom edge
// pdf-lib: y=0 is BOTTOM of page, y increases upward
//   To convert: pdf_lib_y = pageHeight - pdfplumber_y
//
// In our scan data:
//   word.y = pageHeight - w["top"]   = text top edge in pdf-lib coords
//   word.y_top = w["top"]            = text top edge from page top (pdfplumber)
//   word.y_bottom = w["bottom"]      = text bottom edge from page top (pdfplumber)

// ── Smart Signature Area Detection ──
async function detectSignatureArea(pdfBuffer, pageHeight) {
  const scan = await scanPdfTextPositions(pdfBuffer);

  if (scan && scan.words.length > 0) {
    // Search for "İmza" or "Imza" text
    const imzaWords = scan.words.filter(w =>
      w.text.toLowerCase() === "imza" ||
      w.text === "İmza"
    );

    if (imzaWords.length > 0) {
      const imza = imzaWords[imzaWords.length - 1];
      // Convert to pdf-lib coords: text bottom edge
      const textBottomPdfLib = (pageHeight || scan.height) - imza.y_bottom;
      console.log(`[VEKALET] "İmza" bulundu: page=${imza.page} x=${imza.x} y_top_pdflib=${(pageHeight || scan.height) - imza.y_top} y_bottom_pdflib=${textBottomPdfLib}`);
      return {
        page: imza.page,
        x: imza.x,
        textBottomY: textBottomPdfLib,  // pdf-lib y of text bottom edge
      };
    }

    // Fallback: "By:", "signature", underscores
    const sigWords = scan.words.filter(w =>
      w.text === "By:" ||
      w.text.toLowerCase().includes("signature") ||
      w.text.includes("____") ||
      w.text.toLowerCase() === "sign"
    );

    if (sigWords.length > 0) {
      const sig = sigWords[sigWords.length - 1];
      const textBottomPdfLib = (pageHeight || scan.height) - sig.y_bottom;
      console.log(`[VEKALET] İmza işareti: "${sig.text}" page=${sig.page} textBottomY=${textBottomPdfLib}`);
      return {
        page: sig.page,
        x: sig.x,
        textBottomY: textBottomPdfLib,
      };
    }
  }

  console.log("[VEKALET] Varsayılan imza pozisyonu kullanılıyor");
  return { page: null, x: 72, textBottomY: (pageHeight || 842) * 0.2 };
}

// ── Embed Signature into PDF ──
async function embedSignatureInPDF(pdfBuffer, signatureImageBuffer, signerName) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const pageH = lastPage.getHeight();

  const targetArea = await detectSignatureArea(pdfBuffer, pageH);

  if (!targetArea) {
    console.warn("[VEKALET] İmza alanı bulunamadı");
    return pdfBuffer;
  }

  const pageIdx = (targetArea.page || pages.length) - 1;
  const page = pages[Math.min(pageIdx, pages.length - 1)];

  let sigImage;
  try {
    sigImage = await pdfDoc.embedPng(signatureImageBuffer);
  } catch {
    try {
      sigImage = await pdfDoc.embedJpg(signatureImageBuffer);
    } catch (e) {
      console.warn("[VEKALET] İmza görseli yerleştirilemedi:", e.message);
      return pdfBuffer;
    }
  }

  const imgDims = sigImage.size();
  const ratio = imgDims.width / imgDims.height;

  // Signature size: 50pt tall, width proportional (capped at 200)
  const sigHeight = 50;
  const sigWidth = Math.min(sigHeight * ratio, 200);

  // Place signature just below the "İmza" text
  // textBottomY = pdf-lib y coordinate of the text's bottom edge
  // signature top edge should be ~5pt below text bottom
  const gap = 5;
  const sigX = targetArea.x;
  const sigY = targetArea.textBottomY - gap - sigHeight;

  console.log(`[VEKALET] İmza yerleştiriliyor: x=${sigX} y=${sigY} w=${sigWidth} h=${sigHeight} (textBottom=${targetArea.textBottomY})`);

  page.drawImage(sigImage, {
    x: sigX,
    y: sigY,
    width: sigWidth,
    height: sigHeight,
  });

  const signedPdfBytes = await pdfDoc.save();
  return Buffer.from(signedPdfBytes);
}

// POST /api/esign/create — vekalet belgesi yükle + imza talebi oluştur
router.post("/create", async (req, res) => {
  try {
    const { fileBase64, fileName, signerName, signerPhone, tcKimlikNo } = req.body;
    if (!fileBase64 || !fileName) return res.status(400).json({ error: "PDF belgesi gerekli" });
    if (!signerName) return res.status(400).json({ error: "İmzacı adı gerekli" });
    if (!signerPhone) return res.status(400).json({ error: "Telefon numarası gerekli" });

    const buffer = Buffer.from(fileBase64, "base64");
    const docId = `vekalet-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

    // Save pristine original
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docId}-pristine.pdf`), buffer);

    // Save current PDF (no founder signature step)
    const pdfPath = path.join(ESIGN_PDF_DIR, `${docId}-original.pdf`);
    fs.writeFileSync(pdfPath, buffer);

    const signingToken = crypto.randomBytes(32).toString("hex");

    const doc = {
      id: docId,
      fileName: safeName,
      originalName: fileName,
      signerName,
      signerPhone,
      tcKimlikNo: tcKimlikNo || "",
      status: "awaiting_signer",
      signerSigned: false,
      signerSignedAt: null,
      signerSignature: null,
      signingToken,
      signingUrl: `/sign/${signingToken}`,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    const docs = loadDocs();
    docs.unshift(doc);
    saveDocs(docs);

    res.json({ ok: true, document: doc });
  } catch (err) {
    console.error("[VEKALET] Oluşturma hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esign/list — tüm vekalet belgeleri
router.get("/list", (_req, res) => {
  try {
    const docs = loadDocs();
    res.json({ ok: true, documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esign/doc/:id — tek belge getir
router.get("/doc/:id", (req, res) => {
  try {
    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Belge bulunamadı" });
    res.json({ ok: true, document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esign/pdf/:id — PDF dosyasını sun
router.get("/pdf/:id", (req, res) => {
  try {
    const pdfPath = path.join(ESIGN_PDF_DIR, `${req.params.id}-original.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF bulunamadı" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.id}.pdf"`);
    res.send(fs.readFileSync(pdfPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ PUBLIC SIGNING ENDPOINTS (kimlik doğrulama gerekmez) ══

// GET /api/esign/sign/:token — imza için belge getir (herkese açık)
router.get("/sign/:token", (req, res) => {
  try {
    const docs = loadDocs();
    const doc = docs.find(d => d.signingToken === req.params.token);
    if (!doc) return res.status(404).json({ error: "İmza bağlantısı geçersiz veya süresi dolmuş" });
    if (doc.signerSigned) return res.json({ ok: true, document: doc, alreadySigned: true });

    res.json({
      ok: true,
      document: {
        id: doc.id,
        fileName: doc.originalName,
        signerName: doc.signerName,
        signerPhone: doc.signerPhone || "",
        tcKimlikNo: doc.tcKimlikNo,
        status: doc.status,
        signerSigned: doc.signerSigned,
        createdAt: doc.createdAt,
        requiresOtp: !!doc.signerPhone,
      },
      pdfUrl: `/api/esign/pdf/${doc.id}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fill form fields into PDF ──
async function fillFormFieldsInPDF(pdfBuffer, formFields) {
  if (!formFields) return pdfBuffer;
  const { adSoyad, bolumNo, tarih } = formFields;
  if (!adSoyad && !bolumNo && !tarih) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const scan = await scanPdfTextPositions(pdfBuffer);
  if (!scan || scan.words.length === 0) return pdfBuffer;

  const pages = pdfDoc.getPages();
  const pageH = scan.height; // page height from pdfplumber

  // Find field labels and write values after the ":" on the same line
  const fieldMap = [
    { labels: ["Adı", "Adi"], value: adSoyad },
    { labels: ["Bağımsız", "Bagimsiz"], value: bolumNo },
    { labels: ["Tarih"], value: tarih },
  ];

  for (const field of fieldMap) {
    if (!field.value) continue;
    const labelWord = scan.words.find(w =>
      field.labels.some(l => w.text.includes(l))
    );
    if (!labelWord) continue;

    // Find ":" on same line (same y_top within 5pt tolerance)
    const colon = scan.words.find(w =>
      w.text === ":" &&
      w.page === labelWord.page &&
      Math.abs(w.y_top - labelWord.y_top) < 8
    );

    const pageIdx = (labelWord.page || 1) - 1;
    const page = pages[Math.min(pageIdx, pages.length - 1)];

    // writeX: after the colon, or after the label
    const writeX = colon ? colon.x1 + 8 : labelWord.x1 + 8;

    // writeY in pdf-lib coords: align with the label text baseline
    // label baseline ≈ pageHeight - label.y_bottom + 2 (small offset for baseline vs bottom)
    const writeY = pageH - labelWord.y_bottom + 2;

    page.drawText(field.value, {
      x: writeX,
      y: writeY,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    });

    console.log(`[VEKALET] Form: "${field.labels[0]}" = "${field.value}" @ x=${writeX} y=${writeY} (label_y_top=${labelWord.y_top} label_y_bottom=${labelWord.y_bottom})`);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// POST /api/esign/sign/:token — imza gönder (herkese açık)
router.post("/sign/:token", async (req, res) => {
  try {
    const { signature, signatureType, formFields } = req.body;
    if (!signature) return res.status(400).json({ error: "İmza gerekli" });

    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.signingToken === req.params.token);
    if (docIdx === -1) return res.status(404).json({ error: "İmza bağlantısı geçersiz veya süresi dolmuş" });
    if (docs[docIdx].signerSigned) return res.status(400).json({ error: "Zaten imzalanmış" });

    const sigBuffer = Buffer.from(signature.replace(/^data:image\/\w+;base64,/, ""), "base64");
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-signer-sig.png`), sigBuffer);

    // Fill form fields into PDF first, then embed signature
    const pdfPath = path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-original.pdf`);
    if (fs.existsSync(pdfPath)) {
      try {
        let currentPdf = fs.readFileSync(pdfPath);
        // Step 1: Fill form fields (Ad Soyad, Bölüm No, Tarih)
        currentPdf = await fillFormFieldsInPDF(currentPdf, formFields);
        // Step 2: Embed signature image
        const signedPdf = await embedSignatureInPDF(currentPdf, sigBuffer, docs[docIdx].signerName);
        fs.writeFileSync(pdfPath, signedPdf);
        console.log("[VEKALET] Form alanları ve imza PDF'e yerleştirildi");
      } catch (e) { console.warn("[VEKALET] PDF işleme başarısız:", e.message); }
    }

    docs[docIdx].signerSigned = true;
    docs[docIdx].signerSignedAt = new Date().toISOString();
    docs[docIdx].signerSignature = signatureType || "drawn";
    docs[docIdx].status = "completed";
    docs[docIdx].completedAt = new Date().toISOString();

    saveDocs(docs);

    res.json({ ok: true, message: "Belge başarıyla imzalandı!" });
  } catch (err) {
    console.error("[VEKALET] İmza hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/esign/:id — belge sil
router.delete("/:id", (req, res) => {
  try {
    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx === -1) return res.status(404).json({ error: "Belge bulunamadı" });

    const doc = docs.splice(docIdx, 1)[0];
    saveDocs(docs);

    // Cleanup files
    const files = [`${doc.id}-original.pdf`, `${doc.id}-pristine.pdf`, `${doc.id}-signer-sig.png`];
    for (const f of files) {
      const fp = path.join(ESIGN_PDF_DIR, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    res.json({ ok: true, deleted: doc.originalName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
