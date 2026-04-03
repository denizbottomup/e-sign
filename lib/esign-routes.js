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

// ── Smart Signature Area Detection (single signer only) ──
// pdfplumber returns y_from_bottom (y=0 is bottom of page)
// pdf-lib also uses y=0 at bottom, so coordinates match directly
async function detectSignatureArea(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const pageH = lastPage.getHeight();

  const scan = await scanPdfTextPositions(pdfBuffer);

  if (scan && scan.words.length > 0) {
    // Search ALL pages for "İmza" or "Imza" text (case-insensitive)
    const imzaWords = scan.words.filter(w =>
      w.text.toLowerCase() === "imza" ||
      w.text.toLowerCase() === "İmza" ||
      w.text === "İmza"
    );

    if (imzaWords.length > 0) {
      // Use the LAST "İmza" occurrence (most likely the signature field)
      const imza = imzaWords[imzaWords.length - 1];
      console.log(`[VEKALET] "İmza" bulundu: page=${imza.page} x=${imza.x} y=${imza.y} (y_top=${imza.y_top})`);
      return {
        page: imza.page,
        x: imza.x,
        y: imza.y,           // y from bottom (pdfplumber format)
        y_top: imza.y_top,   // y from top (for reference)
        label: "İmza",
      };
    }

    // Fallback: look for "By:", "signature", "sign", or underscores
    const sigWords = scan.words.filter(w =>
      w.text === "By:" ||
      w.text.toLowerCase().includes("signature") ||
      w.text.includes("____") ||
      w.text.toLowerCase() === "sign"
    );

    if (sigWords.length > 0) {
      const sig = sigWords[sigWords.length - 1];
      console.log(`[VEKALET] İmza işareti bulundu: "${sig.text}" page=${sig.page} x=${sig.x} y=${sig.y}`);
      return {
        page: sig.page,
        x: sig.x,
        y: sig.y,
        y_top: sig.y_top,
        label: sig.text,
      };
    }
  }

  // Fallback: lower quarter of last page
  console.log("[VEKALET] Varsayılan imza pozisyonu kullanılıyor");
  return { page: pages.length, x: 72, y: pageH * 0.25, label: "fallback" };
}

// ── Embed Signature into PDF ──
// Places signature image BELOW the detected "İmza" text, at a prominent size
async function embedSignatureInPDF(pdfBuffer, signatureImageBuffer, signerName) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();

  const targetArea = await detectSignatureArea(pdfBuffer);

  if (!targetArea) {
    console.warn("[VEKALET] İmza alanı bulunamadı, varsayılan kullanılıyor");
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

  // Prominent signature size: 60px tall, width scales with aspect ratio
  const sigHeight = 60;
  const sigWidth = Math.min(sigHeight * ratio, 250); // cap width at 250

  // Place signature BELOW the "İmza" text
  // targetArea.y is distance from BOTTOM of page (pdfplumber format)
  // In pdf-lib, y=0 is also bottom, so we subtract to go below
  const sigX = targetArea.x;
  const sigY = targetArea.y - sigHeight - 10; // 10px gap below "İmza" text

  console.log(`[VEKALET] İmza yerleştiriliyor: x=${sigX} y=${sigY} w=${sigWidth} h=${sigHeight}`);

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

  // Find field labels and write values after the ":" on the same line
  const fieldMap = [
    { labels: ["Adı", "Adi"], value: adSoyad },
    { labels: ["Bağımsız", "Bagimsiz"], value: bolumNo },
    { labels: ["Tarih"], value: tarih },
  ];

  for (const field of fieldMap) {
    if (!field.value) continue;
    // Find the label word
    const labelWord = scan.words.find(w =>
      field.labels.some(l => w.text.includes(l))
    );
    if (!labelWord) continue;

    // Find the ":" on the same line (within 5px y tolerance)
    const colon = scan.words.find(w =>
      w.text === ":" &&
      w.page === labelWord.page &&
      Math.abs(w.y - labelWord.y) < 10
    );

    const pageIdx = (labelWord.page || 1) - 1;
    const page = pages[Math.min(pageIdx, pages.length - 1)];

    // Write value after the colon, or after the label if no colon
    const writeX = colon ? colon.x1 + 8 : labelWord.x1 + 8;
    const writeY = labelWord.y - 4; // y from bottom (pdf-lib coordinate)

    page.drawText(field.value, {
      x: writeX,
      y: writeY,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    });

    console.log(`[VEKALET] Form alanı dolduruldu: "${field.labels[0]}" = "${field.value}" @ x=${writeX} y=${writeY}`);
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
