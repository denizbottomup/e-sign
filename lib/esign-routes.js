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

// ── PDF Text Extraction (Node.js only, no Python) ──
// Uses pdfjs-dist to extract text with coordinates
// Returns: { pageHeight, words: [{ text, x, y_top, y_bottom, x1, page }] }
// y_top/y_bottom are distance from TOP of page (like pdfplumber)
async function scanPdfText(pdfBuffer) {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
    const totalPages = doc.numPages;
    const words = [];
    let pageHeight = 842;

    // Scan last 2 pages (where signature usually is)
    const startPage = Math.max(1, totalPages - 1);
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      pageHeight = viewport.height;
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        if (!item.str || !item.str.trim()) continue;
        const tx = item.transform;
        // tx[4] = x, tx[5] = y (from bottom, pdf coords)
        const x = tx[4];
        const yBottom_fromTop = pageHeight - tx[5]; // text baseline from top
        const textHeight = item.height || 12;
        const yTop_fromTop = yBottom_fromTop - textHeight;

        // Split into individual words
        for (const word of item.str.split(/\s+/).filter(w => w)) {
          words.push({
            text: word,
            page: pageNum,
            x: Math.round(x),
            x1: Math.round(x + (item.width || word.length * 6)),
            y_top: Math.round(yTop_fromTop),
            y_bottom: Math.round(yBottom_fromTop),
          });
        }
      }
    }

    await doc.destroy();
    console.log(`[VEKALET] PDF scan: ${words.length} kelime, pageHeight=${pageHeight}`);
    return { pageHeight, words };
  } catch (e) {
    console.warn("[VEKALET] PDF scan başarısız:", e.message);
    return null;
  }
}

// ── Coordinate System ──
// scanPdfText returns y_top/y_bottom from TOP of page
// pdf-lib uses y from BOTTOM of page
// Convert: pdflib_y = pageHeight - y_from_top

// ── Smart Signature Area Detection ──
async function detectSignatureArea(pdfBuffer, pageHeight) {
  const scan = await scanPdfText(pdfBuffer);
  if (!scan || scan.words.length === 0) {
    console.log("[VEKALET] Scan başarısız, fallback pozisyon");
    return { page: null, x: 72, textBottomY: (pageHeight || 842) * 0.2 };
  }

  const pH = scan.pageHeight;

  // Search for "İmza" or "Imza"
  const imzaWords = scan.words.filter(w =>
    w.text.toLowerCase() === "imza" || w.text === "İmza"
  );

  if (imzaWords.length > 0) {
    const imza = imzaWords[imzaWords.length - 1];
    const textBottomY = pH - imza.y_bottom; // pdf-lib y of text bottom
    console.log(`[VEKALET] "İmza" bulundu: page=${imza.page} x=${imza.x} y_top=${imza.y_top} y_bottom=${imza.y_bottom} → textBottomY=${textBottomY}`);
    return { page: imza.page, x: imza.x, textBottomY, pageHeight: pH };
  }

  // Fallback markers
  const sigWords = scan.words.filter(w =>
    w.text === "By:" || w.text.toLowerCase().includes("signature") ||
    w.text.includes("____") || w.text.toLowerCase() === "sign"
  );

  if (sigWords.length > 0) {
    const sig = sigWords[sigWords.length - 1];
    const textBottomY = pH - sig.y_bottom;
    console.log(`[VEKALET] İmza işareti: "${sig.text}" → textBottomY=${textBottomY}`);
    return { page: sig.page, x: sig.x, textBottomY, pageHeight: pH };
  }

  console.log("[VEKALET] İmza alanı bulunamadı, fallback");
  return { page: null, x: 72, textBottomY: pH * 0.2, pageHeight: pH };
}

// ── Embed Signature into PDF ──
async function embedSignatureInPDF(pdfBuffer, signatureImageBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const pageH = lastPage.getHeight();

  const target = await detectSignatureArea(pdfBuffer, pageH);

  const pageIdx = (target.page || pages.length) - 1;
  const page = pages[Math.min(pageIdx, pages.length - 1)];

  let sigImage;
  try {
    sigImage = await pdfDoc.embedPng(signatureImageBuffer);
  } catch {
    try { sigImage = await pdfDoc.embedJpg(signatureImageBuffer); }
    catch (e) { console.warn("[VEKALET] İmza görseli yerleştirilemedi:", e.message); return pdfBuffer; }
  }

  const dims = sigImage.size();
  const ratio = dims.width / dims.height;
  const sigHeight = 50;
  const sigWidth = Math.min(sigHeight * ratio, 200);

  // Place just below the "İmza" text
  const gap = 5;
  const sigX = target.x;
  const sigY = target.textBottomY - gap - sigHeight;

  console.log(`[VEKALET] İmza: x=${sigX} y=${sigY} w=${sigWidth} h=${sigHeight} (textBottom=${target.textBottomY})`);

  page.drawImage(sigImage, { x: sigX, y: sigY, width: sigWidth, height: sigHeight });

  return Buffer.from(await pdfDoc.save());
}

// ── Fill form fields into PDF ──
async function fillFormFieldsInPDF(pdfBuffer, formFields) {
  if (!formFields) return pdfBuffer;
  const { adSoyad, bolumNo, tarih } = formFields;
  if (!adSoyad && !bolumNo && !tarih) return pdfBuffer;

  const scan = await scanPdfText(pdfBuffer);
  if (!scan || scan.words.length === 0) return pdfBuffer;

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const pH = scan.pageHeight;

  const fieldMap = [
    { labels: ["Adı", "Adi"], value: adSoyad },
    { labels: ["Bağımsız", "Bagimsiz"], value: bolumNo },
    { labels: ["Tarih"], value: tarih },
  ];

  for (const field of fieldMap) {
    if (!field.value) continue;
    const labelWord = scan.words.find(w => field.labels.some(l => w.text.includes(l)));
    if (!labelWord) continue;

    // Find ":" on same line
    const colon = scan.words.find(w =>
      w.text === ":" && w.page === labelWord.page &&
      Math.abs(w.y_top - labelWord.y_top) < 8
    );

    const pageIdx = (labelWord.page || 1) - 1;
    const page = pages[Math.min(pageIdx, pages.length - 1)];

    const writeX = colon ? colon.x1 + 8 : labelWord.x1 + 8;
    // Align with label baseline: convert y_bottom (from top) to pdf-lib y, add small offset
    const writeY = pH - labelWord.y_bottom + 2;

    page.drawText(field.value, { x: writeX, y: writeY, size: 11, font, color: rgb(0, 0, 0) });
    console.log(`[VEKALET] Form: "${field.labels[0]}" = "${field.value}" @ x=${writeX} y=${writeY}`);
  }

  return Buffer.from(await pdfDoc.save());
}

// ══ API ROUTES ══

// POST /api/esign/create
router.post("/create", async (req, res) => {
  try {
    const { fileBase64, fileName, signerName, signerPhone, tcKimlikNo } = req.body;
    if (!fileBase64 || !fileName) return res.status(400).json({ error: "PDF belgesi gerekli" });
    if (!signerName) return res.status(400).json({ error: "İmzacı adı gerekli" });
    if (!signerPhone) return res.status(400).json({ error: "Telefon numarası gerekli" });

    const buffer = Buffer.from(fileBase64, "base64");
    const docId = `vekalet-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docId}-pristine.pdf`), buffer);
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docId}-original.pdf`), buffer);

    const signingToken = crypto.randomBytes(32).toString("hex");
    const doc = {
      id: docId, fileName: safeName, originalName: fileName,
      signerName, signerPhone, tcKimlikNo: tcKimlikNo || "",
      status: "awaiting_signer", signerSigned: false, signerSignedAt: null,
      signerSignature: null, signingToken, signingUrl: `/sign/${signingToken}`,
      createdAt: new Date().toISOString(), completedAt: null,
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

// GET /api/esign/list
router.get("/list", (_req, res) => {
  try { res.json({ ok: true, documents: loadDocs() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/esign/doc/:id
router.get("/doc/:id", (req, res) => {
  try {
    const doc = loadDocs().find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Belge bulunamadı" });
    res.json({ ok: true, document: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/esign/pdf/:id
router.get("/pdf/:id", (req, res) => {
  try {
    const pdfPath = path.join(ESIGN_PDF_DIR, `${req.params.id}-original.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF bulunamadı" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.id}.pdf"`);
    res.send(fs.readFileSync(pdfPath));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/esign/sign/:token — get doc for signing (public)
router.get("/sign/:token", (req, res) => {
  try {
    const docs = loadDocs();
    const doc = docs.find(d => d.signingToken === req.params.token);
    if (!doc) return res.status(404).json({ error: "İmza bağlantısı geçersiz veya süresi dolmuş" });
    if (doc.signerSigned) return res.json({ ok: true, document: doc, alreadySigned: true });

    res.json({
      ok: true,
      document: {
        id: doc.id, fileName: doc.originalName, signerName: doc.signerName,
        signerPhone: doc.signerPhone || "", tcKimlikNo: doc.tcKimlikNo,
        status: doc.status, signerSigned: doc.signerSigned,
        createdAt: doc.createdAt, requiresOtp: !!doc.signerPhone,
      },
      pdfUrl: `/api/esign/pdf/${doc.id}`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/esign/sign/:token — submit signature (public)
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

    const pdfPath = path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-original.pdf`);
    if (fs.existsSync(pdfPath)) {
      try {
        let currentPdf = fs.readFileSync(pdfPath);
        currentPdf = await fillFormFieldsInPDF(currentPdf, formFields);
        const signedPdf = await embedSignatureInPDF(currentPdf, sigBuffer);
        fs.writeFileSync(pdfPath, signedPdf);
        console.log("[VEKALET] Form + imza PDF'e yerleştirildi");
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

// DELETE /api/esign/:id
router.delete("/:id", (req, res) => {
  try {
    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx === -1) return res.status(404).json({ error: "Belge bulunamadı" });
    const doc = docs.splice(docIdx, 1)[0];
    saveDocs(docs);
    for (const f of [`${doc.id}-original.pdf`, `${doc.id}-pristine.pdf`, `${doc.id}-signer-sig.png`]) {
      const fp = path.join(ESIGN_PDF_DIR, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    res.json({ ok: true, deleted: doc.originalName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
