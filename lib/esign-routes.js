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
async function detectSignatureArea(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const pageH = lastPage.getHeight();

  const scan = await scanPdfTextPositions(pdfBuffer);

  if (scan && scan.words.length > 0) {
    const lastPageNum = scan.pages;
    const byPositions = scan.words.filter(w => w.text === "By:" && w.page >= lastPageNum - 1);

    console.log("[VEKALET] 'By:' pozisyonları:", byPositions.map(b => `page=${b.page} x=${b.x} y=${b.y}`));

    if (byPositions.length >= 1) {
      const by = byPositions[byPositions.length - 1]; // Use last "By:" for signer
      return {
        page: by.page,
        x: by.x,
        y: by.y,
        label: "İmza",
        role: "signer",
      };
    }

    // Look for signature markers
    const sigWords = scan.words.filter(w =>
      w.text.toLowerCase().includes("signature") ||
      w.text.toLowerCase().includes("imza") ||
      w.text.includes("____") ||
      w.text.toLowerCase() === "sign"
    );

    if (sigWords.length > 0) {
      console.log("[VEKALET] İmza işaretleri bulundu:", sigWords.map(s => `"${s.text}" page=${s.page} x=${s.x} y=${s.y}`));
      const sig = sigWords[sigWords.length - 1];
      return {
        page: sig.page,
        x: sig.x,
        y: sig.y + 5,
        label: "İmza",
        role: "signer",
      };
    }
  }

  // Fallback: standard position
  console.log("[VEKALET] Varsayılan imza pozisyonu kullanılıyor");
  return { page: pages.length, x: 324, y: pageH - 310, label: "İmza", role: "signer" };
}

// ── Embed Signature into PDF ──
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

  const byX = targetArea.x || 324;
  const byY = targetArea.y || 632;

  const imgDims = sigImage.size();
  const origW = imgDims.width;
  const origH = imgDims.height;
  const ratio = origW / origH;

  const sigHeight = 32;
  const sigWidth = sigHeight * ratio;

  page.drawImage(sigImage, {
    x: byX + 36,
    y: byY - 10,
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

// POST /api/esign/sign/:token — imza gönder (herkese açık)
router.post("/sign/:token", async (req, res) => {
  try {
    const { signature, signatureType } = req.body;
    if (!signature) return res.status(400).json({ error: "İmza gerekli" });

    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.signingToken === req.params.token);
    if (docIdx === -1) return res.status(404).json({ error: "İmza bağlantısı geçersiz veya süresi dolmuş" });
    if (docs[docIdx].signerSigned) return res.status(400).json({ error: "Zaten imzalanmış" });

    const sigBuffer = Buffer.from(signature.replace(/^data:image\/\w+;base64,/, ""), "base64");
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-signer-sig.png`), sigBuffer);

    // Embed signer signature into PDF
    const pdfPath = path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-original.pdf`);
    if (fs.existsSync(pdfPath)) {
      try {
        const currentPdf = fs.readFileSync(pdfPath);
        const signedPdf = await embedSignatureInPDF(currentPdf, sigBuffer, docs[docIdx].signerName);
        fs.writeFileSync(pdfPath, signedPdf);
        console.log("[VEKALET] İmza PDF'e yerleştirildi");
      } catch (e) { console.warn("[VEKALET] İmza yerleştirme başarısız:", e.message); }
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
