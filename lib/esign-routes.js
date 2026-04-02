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
    const { fileBase64, fileName, signerName, signerEmail, signerPhone, tcKimlikNo, gmailToken } = req.body;
    if (!fileBase64 || !fileName) return res.status(400).json({ error: "PDF belgesi gerekli" });
    if (!signerName) return res.status(400).json({ error: "İmzacı adı gerekli" });
    if (!signerPhone && !signerEmail) return res.status(400).json({ error: "Telefon numarası veya e-posta gerekli" });

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
      signerEmail: signerEmail || "",
      signerPhone: signerPhone || "",
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

    // Send invite email to signer
    let emailSent = false;
    if (gmailToken && signerEmail) {
      try {
        const signingLink = `${req.protocol}://${req.get("host")}${doc.signingUrl}`;

        let subject = `İmzanız Bekleniyor: ${fileName}`;
        let emailIntro = `Seçim vekaleti belgeniz imzanızı beklemektedir.`;

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          try {
            const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
              body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 300,
                temperature: 0.3,
                messages: [{ role: "user", content: `Bir seçim vekaleti belgesi için profesyonel ve samimi bir Türkçe e-posta yaz.

Belge adı: "${fileName}"
İmzacı adı: "${signerName}"

Belge adına göre şunları yaz:
1. Kısa bir e-posta konu satırı (max 60 karakter)
2. 1-2 cümlelik bağlamsal açıklama

Sadece geçerli JSON döndür: {"subject": "...", "intro": "..."}
Profesyonel ama samimi tut. Yer tutucu parantez KULLANMA.` }],
              }),
            });
            const aiData = await aiResp.json();
            const aiText = aiData.content?.[0]?.text || "";
            const match = aiText.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (parsed.subject) subject = parsed.subject;
              if (parsed.intro) emailIntro = parsed.intro;
            }
          } catch (e) { console.warn("[VEKALET] AI e-posta oluşturma başarısız:", e.message); }
        }

        const htmlBody = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <div style="background:#1e3a5f;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#ffffff;font-size:20px;margin:0;">Seçim Vekaleti İmza Sistemi</h1>
            </div>
            <div style="background:#ffffff;padding:30px;border:1px solid #eee;border-radius:0 0 12px 12px;">
              <h2 style="color:#1a1a1a;margin:0 0 15px;">Belgeniz İmzanızı Bekliyor</h2>
              <p style="color:#555;line-height:1.6;">
                Sayın <strong>${signerName}</strong>,
              </p>
              <p style="color:#555;line-height:1.6;">
                ${emailIntro}
              </p>
              <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;border-left:4px solid #1e3a5f;">
                <p style="margin:0;color:#333;font-weight:600;font-size:15px;">📄 ${fileName}</p>
                <p style="margin:4px 0 0;color:#888;font-size:13px;">Seçim Vekaleti Belgesi</p>
              </div>
              <p style="color:#555;line-height:1.6;">
                Lütfen belgeyi inceleyip aşağıdaki butona tıklayarak imzanızı ekleyin:
              </p>
              <div style="text-align:center;margin:25px 0;">
                <a href="${signingLink}" style="display:inline-block;background:#1e3a5f;color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:10px;font-size:16px;font-weight:600;">
                  Belgeyi İncele ve İmzala
                </a>
              </div>
              <p style="color:#999;font-size:12px;line-height:1.6;">
                Bu güvenli bir imza bağlantısıdır. Başkalarıyla paylaşmayın.
              </p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
              <p style="color:#999;font-size:12px;text-align:center;">Seçim Vekaleti İmza Sistemi</p>
            </div>
          </div>
        `;

        const emailLines = [
          `From: Seçim Vekaleti <deniz@bottomup.app>`,
          `To: ${signerEmail}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset=UTF-8`,
          ``,
          htmlBody,
        ];

        const raw = Buffer.from(emailLines.join("\r\n")).toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${gmailToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }),
        });

        emailSent = resp.ok;
        if (!resp.ok) console.warn("[VEKALET] Davet e-postası başarısız:", await resp.text());
      } catch (e) { console.warn("[VEKALET] Davet e-postası hatası:", e.message); }
    }

    doc.inviteEmailSent = emailSent;
    if (emailSent) {
      const allDocs = loadDocs();
      const idx = allDocs.findIndex(d => d.id === doc.id);
      if (idx >= 0) { allDocs[idx].inviteEmailSent = true; saveDocs(allDocs); }
    }

    res.json({ ok: true, document: doc, emailSent });
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

// POST /api/esign/:id/resend-invite — imza davetini tekrar gönder
router.post("/:id/resend-invite", async (req, res) => {
  try {
    const { gmailToken } = req.body;
    if (!gmailToken) return res.status(400).json({ error: "Gmail token gerekli" });

    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Belge bulunamadı" });
    if (doc.status === "completed") return res.status(400).json({ error: "Zaten tamamlanmış" });

    const signingLink = `${req.protocol}://${req.get("host")}${doc.signingUrl}`;
    let subject = `Hatırlatma: "${doc.originalName}" belgesini imzalayın`;
    let emailIntro = `Seçim vekaleti belgeniz hâlâ imzanızı beklemektedir.`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 200, temperature: 0.3,
            messages: [{ role: "user", content: `Bir seçim vekaleti belgesi için kısa ve samimi bir hatırlatma e-postası konu satırı ve açılış cümlesi yaz.
Belge: "${doc.originalName}", İmzacı: "${doc.signerName}"
JSON döndür: {"subject": "...", "intro": "..."}` }],
          }),
        });
        const aiData = await aiResp.json();
        const match = (aiData.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
        if (match) { const p = JSON.parse(match[0]); if (p.subject) subject = p.subject; if (p.intro) emailIntro = p.intro; }
      } catch {}
    }

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#1e3a5f;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="color:#ffffff;font-size:20px;margin:0;">Seçim Vekaleti İmza Sistemi</h1>
        </div>
        <div style="background:#ffffff;padding:30px;border:1px solid #eee;border-radius:0 0 12px 12px;">
          <h2 style="color:#1a1a1a;margin:0 0 15px;">Belgeniz İmzanızı Bekliyor</h2>
          <p style="color:#555;line-height:1.6;">Sayın <strong>${doc.signerName}</strong>,</p>
          <p style="color:#555;line-height:1.6;">${emailIntro}</p>
          <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;border-left:4px solid #1e3a5f;">
            <p style="margin:0;color:#333;font-weight:600;font-size:15px;">📄 ${doc.originalName}</p>
            <p style="margin:4px 0 0;color:#888;font-size:13px;">Seçim Vekaleti Belgesi</p>
          </div>
          <div style="text-align:center;margin:25px 0;">
            <a href="${signingLink}" style="display:inline-block;background:#1e3a5f;color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:10px;font-size:16px;font-weight:600;">Belgeyi İncele ve İmzala</a>
          </div>
          <p style="color:#999;font-size:12px;">Bu güvenli bir imza bağlantısıdır. Başkalarıyla paylaşmayın.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
          <p style="color:#999;font-size:12px;text-align:center;">Seçim Vekaleti İmza Sistemi</p>
        </div>
      </div>
    `;

    const emailLines = [
      `From: Seçim Vekaleti <deniz@bottomup.app>`,
      `To: ${doc.signerEmail}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      htmlBody,
    ];

    const raw = Buffer.from(emailLines.join("\r\n")).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const emailResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${gmailToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });

    if (!emailResp.ok) {
      const errText = await emailResp.text();
      console.warn("[VEKALET] Davet tekrar gönderimi başarısız:", errText);
      return res.status(500).json({ error: "E-posta gönderilemedi" });
    }

    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx >= 0) { docs[docIdx].inviteEmailSent = true; saveDocs(docs); }

    res.json({ ok: true, message: `Davet ${doc.signerEmail} adresine gönderildi` });
  } catch (err) {
    console.error("[VEKALET] Davet tekrar gönderim hatası:", err.message);
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
    docs[docIdx].completionEmailPending = true;

    saveDocs(docs);

    res.json({ ok: true, message: "Belge başarıyla imzalandı!" });
  } catch (err) {
    console.error("[VEKALET] İmza hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/esign/:id/send-completion — imzalı belgeyi taraflara gönder
router.post("/:id/send-completion", async (req, res) => {
  try {
    const { gmailToken } = req.body;
    if (!gmailToken) return res.status(400).json({ error: "Gmail token gerekli" });

    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Belge bulunamadı" });
    if (doc.status !== "completed") return res.status(400).json({ error: "Belge henüz tamamlanmadı" });

    const pdfPath = path.join(ESIGN_PDF_DIR, `${doc.id}-original.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF dosyası bulunamadı" });
    const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

    const subject = `İmzalandı: ${doc.originalName}`;
    const recipients = [doc.signerEmail, "deniz@bottomup.app"];

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#1e3a5f;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="color:#ffffff;font-size:20px;margin:0;">Seçim Vekaleti İmza Sistemi</h1>
        </div>
        <div style="background:#ffffff;padding:30px;border:1px solid #eee;border-radius:0 0 12px 12px;">
          <h2 style="color:#1a1a1a;margin:0 0 15px;">Belge Başarıyla İmzalandı ✅</h2>
          <p style="color:#555;line-height:1.6;">
            <strong>${doc.originalName}</strong> belgesi imzalanmıştır.
          </p>
          <table style="width:100%;margin:20px 0;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#888;width:120px;">Belge</td><td style="padding:8px 0;color:#333;font-weight:600;">${doc.originalName}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">İmzacı</td><td style="padding:8px 0;color:#333;">${doc.signerName} (${doc.signerEmail})</td></tr>
            ${doc.tcKimlikNo ? `<tr><td style="padding:8px 0;color:#888;">TC Kimlik No</td><td style="padding:8px 0;color:#333;">${doc.tcKimlikNo}</td></tr>` : ""}
            <tr><td style="padding:8px 0;color:#888;">İmza Tarihi</td><td style="padding:8px 0;color:#333;">${new Date(doc.completedAt).toLocaleDateString("tr-TR", { year:"numeric", month:"long", day:"numeric" })}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Durum</td><td style="padding:8px 0;color:#16a34a;font-weight:600;">✅ Tamamlandı</td></tr>
          </table>
          <p style="color:#555;line-height:1.6;">İmzalı belge bu e-postaya eklenmiştir.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
          <p style="color:#999;font-size:12px;text-align:center;">Seçim Vekaleti İmza Sistemi</p>
        </div>
      </div>
    `;

    let sent = 0;
    for (const to of recipients) {
      try {
        const boundary = `boundary_${Date.now()}`;
        const emailParts = [
          `From: Seçim Vekaleti <deniz@bottomup.app>`,
          `To: ${to}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          ``,
          htmlBody,
          `--${boundary}`,
          `Content-Type: application/pdf; name="${doc.originalName}"`,
          `Content-Disposition: attachment; filename="${doc.originalName}"`,
          `Content-Transfer-Encoding: base64`,
          ``,
          pdfBase64,
          `--${boundary}--`,
        ];

        const raw = Buffer.from(emailParts.join("\r\n")).toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

        const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${gmailToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw }),
        });

        if (resp.ok) sent++;
        else console.warn(`[VEKALET] ${to} adresine e-posta başarısız:`, await resp.text());
      } catch (e) { console.warn(`[VEKALET] ${to} adresine e-posta hatası:`, e.message); }
    }

    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx >= 0) {
      docs[docIdx].completionEmailPending = false;
      docs[docIdx].completionEmailSent = true;
      docs[docIdx].completionEmailSentAt = new Date().toISOString();
      saveDocs(docs);
    }

    res.json({ ok: true, sent, total: recipients.length });
  } catch (err) {
    console.error("[VEKALET] Tamamlama e-postası hatası:", err.message);
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
