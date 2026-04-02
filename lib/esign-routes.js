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
  } catch (e) { console.warn("[ESIGN] Load error:", e.message); }
  return [];
}

function saveDocs(docs) {
  fs.writeFileSync(ESIGN_FILE, JSON.stringify(docs, null, 2));
}

// ── Deep PDF Scan — extract all text with exact coordinates ──
async function scanPdfTextPositions(pdfBuffer) {
  // Write PDF to temp file and use Python pdfplumber for precise coordinates
  const tmpPdf = path.join(require("os").tmpdir(), `esign-scan-${Date.now()}.pdf`);
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
        console.warn("[ESIGN] Python scan failed:", err.message);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        console.warn("[ESIGN] Python scan parse failed");
        resolve(null);
      }
    });
  });
}

// ── Smart Signature Area Detection ──
async function detectSignatureAreas(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const pageH = lastPage.getHeight();

  // Step 1: Deep scan — get all text with exact coordinates
  const scan = await scanPdfTextPositions(pdfBuffer);

  if (scan && scan.words.length > 0) {
    // Step 2: Find "By:" positions on last page(s)
    const lastPageNum = scan.pages;
    const byPositions = scan.words.filter(w => w.text === "By:" && w.page >= lastPageNum - 1);

    console.log("[ESIGN] Found 'By:' positions:", byPositions.map(b => `page=${b.page} x=${b.x} y=${b.y}`));

    if (byPositions.length >= 2) {
      // First "By:" = founder, second "By:" = investor
      const founderBy = byPositions[0];
      const investorBy = byPositions[1];

      // Check context: is there "INVESTOR" before the second By:?
      const investorLabel = scan.words.find(w =>
        w.page === investorBy.page &&
        (w.text === "INVESTOR:" || w.text === "INVESTOR") &&
        w.y > investorBy.y && w.y < investorBy.y + 50
      );

      return [
        {
          page: founderBy.page,
          x: founderBy.x,      // Raw "By:" x position
          y: founderBy.y,      // Raw "By:" y position
          label: "Company / Founder",
          role: "founder"
        },
        {
          page: investorBy.page,
          x: investorBy.x,
          y: investorBy.y,
          label: investorLabel ? "Investor" : "Counterparty",
          role: "signer"
        },
      ];
    } else if (byPositions.length === 1) {
      // Single signature — use AI to determine role
      const by = byPositions[0];
      // Check nearby text for context
      const nearbyWords = scan.words.filter(w =>
        w.page === by.page && Math.abs(w.y - by.y) < 80
      ).map(w => w.text).join(" ").toLowerCase();

      const isFounder = nearbyWords.includes("company") || nearbyWords.includes("bottomup");
      return [{
        page: by.page,
        x: by.x,
        y: by.y + 5,
        label: isFounder ? "Company" : "Signer",
        role: isFounder ? "founder" : "signer",
      }];
    }

    // No "By:" found — look for "(Signature" or "Sign" or "___"
    const sigWords = scan.words.filter(w =>
      w.text.toLowerCase().includes("signature") ||
      w.text.includes("____") ||
      w.text.toLowerCase() === "sign"
    );

    if (sigWords.length > 0) {
      console.log("[ESIGN] Found signature markers:", sigWords.map(s => `"${s.text}" page=${s.page} x=${s.x} y=${s.y}`));
      // Use AI to determine which is founder vs signer
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const contextWords = scan.words.filter(w => w.page >= scan.pages - 1).map(w => `x=${w.x} y=${w.y} "${w.text}"`).join("\n");
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001", max_tokens: 300, temperature: 0,
              messages: [{ role: "user", content: `Given these text positions from a PDF signature page (y=0 is bottom):
${contextWords}

Find where signatures should go. Return JSON array:
[{"page": <num>, "x": <number>, "y": <number>, "label": "<text>", "role": "founder|signer"}]
Signature images go just above signature lines/markers.` }],
            }),
          });
          const data = await resp.json();
          const match = (data.content?.[0]?.text || "").match(/\[[\s\S]*\]/);
          if (match) return JSON.parse(match[0]);
        } catch {}
      }
    }
  }

  // Fallback: standard positions
  console.log("[ESIGN] Using fallback signature positions");
  return [
    { page: pages.length, x: 324, y: pageH - 160, label: "Company", role: "founder" },
    { page: pages.length, x: 324, y: pageH - 310, label: "Investor", role: "signer" },
  ];
}

// ── Embed Signature into PDF ──
async function embedSignatureInPDF(pdfBuffer, signatureImageBuffer, role, signerName) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();

  // Detect signature areas
  const areas = await detectSignatureAreas(pdfBuffer);
  const targetArea = areas.find(a => a.role === role) || areas[0];

  if (!targetArea) {
    console.warn("[ESIGN] No signature area found, using default");
    return pdfBuffer; // Return original if no area found
  }

  const pageIdx = (targetArea.page || pages.length) - 1;
  const page = pages[Math.min(pageIdx, pages.length - 1)];

  // Embed signature image
  let sigImage;
  try {
    sigImage = await pdfDoc.embedPng(signatureImageBuffer);
  } catch {
    try {
      sigImage = await pdfDoc.embedJpg(signatureImageBuffer);
    } catch (e) {
      console.warn("[ESIGN] Failed to embed signature image:", e.message);
      return pdfBuffer;
    }
  }

  // Signature layout (DocuSign style):
  //
  //   BOTTOMUP INC.                    ← header text (y ≈ 658)
  //        Signed by:                  ← small label we add
  //        [Cursive Signature]         ← signature image BETWEEN header and By: line
  //   By: ___________________________  ← By: line (y ≈ 632), signature sits ABOVE this
  //        Deniz Saglam               ← printed name (already in doc)
  //
  // targetArea.y = y coordinate of "By:" text (from bottom of page)
  // targetArea.x = x coordinate of "By:" text
  //
  const byX = targetArea.x || 324;
  const byY = targetArea.y || 632;

  // Preserve original aspect ratio of signature image
  const imgDims = sigImage.size();
  const origW = imgDims.width;
  const origH = imgDims.height;
  const ratio = origW / origH;

  // Target height ~32px, width scales proportionally
  const sigHeight = 32;
  const sigWidth = sigHeight * ratio;

  // Signature starts at "Deniz" D position (x = By.x + 36)
  // "Deniz" is at byX + 36, By: line is at byY
  page.drawImage(sigImage, {
    x: byX + 36,              // Aligned with "Deniz" text start
    y: byY - 10,              // Bottom edge slightly below By: line
    width: sigWidth,
    height: sigHeight,
  });

  const signedPdfBytes = await pdfDoc.save();
  return Buffer.from(signedPdfBytes);
}

// POST /api/esign/create — upload PDF + create signing request
router.post("/create", async (req, res) => {
  try {
    const { fileBase64, fileName, signerName, signerEmail, founderSignature, gmailToken } = req.body;
    if (!fileBase64 || !fileName) return res.status(400).json({ error: "PDF file is required" });
    if (!signerName || !signerEmail) return res.status(400).json({ error: "Signer name and email are required" });

    // Save original PDF
    let buffer = Buffer.from(fileBase64, "base64");
    const docId = `esign-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

    // Save pristine original (before any signatures)
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docId}-pristine.pdf`), buffer);

    // Embed founder signature into PDF
    // Use provided signature OR default Deniz Saglam signature
    const DEFAULT_SIG_PATH = path.join(__dirname, "..", "data", "deniz-signature.png");
    let sigBuffer = null;

    if (founderSignature) {
      sigBuffer = Buffer.from(founderSignature.replace(/^data:image\/\w+;base64,/, ""), "base64");
    } else if (fs.existsSync(DEFAULT_SIG_PATH)) {
      sigBuffer = fs.readFileSync(DEFAULT_SIG_PATH);
      console.log("[ESIGN] Using default Deniz Saglam signature");
    }

    if (sigBuffer) {
      fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docId}-founder-sig.png`), sigBuffer);
      try {
        buffer = await embedSignatureInPDF(buffer, sigBuffer, "founder", "Deniz Saglam");
        console.log("[ESIGN] Founder signature embedded into PDF");
      } catch (e) { console.warn("[ESIGN] Failed to embed founder sig:", e.message); }
    }

    // Save current PDF (with founder sig if applied)
    const pdfPath = path.join(ESIGN_PDF_DIR, `${docId}-original.pdf`);
    fs.writeFileSync(pdfPath, buffer);

    // Generate signing token (public access)
    const signingToken = crypto.randomBytes(32).toString("hex");

    const doc = {
      id: docId,
      fileName: safeName,
      originalName: fileName,
      signerName,
      signerEmail,
      status: founderSignature ? "awaiting_signer" : "awaiting_founder",
      founderSigned: !!founderSignature,
      founderSignedAt: founderSignature ? new Date().toISOString() : null,
      signerSigned: false,
      signerSignedAt: null,
      signerSignature: null,
      signingToken,
      signingUrl: `/sign/${signingToken}`,
      createdAt: new Date().toISOString(),
      completedAt: null,
      movedToDueDiligence: false,
    };

    const docs = loadDocs();
    docs.unshift(doc);
    saveDocs(docs);

    // Send AI-generated invite email to signer
    let emailSent = false;
    if (gmailToken && signerEmail) {
      try {
        const signingLink = `${req.protocol}://${req.get("host")}${doc.signingUrl}`;

        // AI generates contextual email based on document name
        let emailSubject = `Action Required: Please sign "${fileName}"`;
        let emailIntro = `Deniz Saglam from <strong>BottomUP Inc.</strong> has sent you a document that requires your signature.`;
        let emailContext = "";

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
                messages: [{ role: "user", content: `You are writing a professional, warm email to ask someone to sign a document electronically.

Document name: "${fileName}"
Signer name: "${signerName}"
Sender: Deniz Saglam, Co-Founder & CEO, BottomUP Inc.

Based on the document name, write:
1. A short email subject line (max 60 chars)
2. A 1-2 sentence contextual intro explaining what this document is about
3. A brief 1 sentence note about why it needs their signature

Return ONLY valid JSON: {"subject": "...", "intro": "...", "context": "..."}
Keep it professional but friendly. Do NOT use placeholder brackets.` }],
              }),
            });
            const aiData = await aiResp.json();
            const aiText = aiData.content?.[0]?.text || "";
            const match = aiText.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (parsed.subject) emailSubject = parsed.subject;
              if (parsed.intro) emailIntro = parsed.intro;
              if (parsed.context) emailContext = `<p style="color:#555;line-height:1.6;">${parsed.context}</p>`;
            }
          } catch (e) { console.warn("[ESIGN] AI email gen failed:", e.message); }
        }

        const htmlBody = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
            <div style="background:#0B0C14;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
              <img src="${req.protocol}://${req.get("host")}/logo.png" alt="BottomUP" style="height:28px;" />
            </div>
            <div style="background:#ffffff;padding:30px;border:1px solid #eee;border-radius:0 0 12px 12px;">
              <h2 style="color:#1a1a1a;margin:0 0 15px;">Document Requires Your Signature</h2>
              <p style="color:#555;line-height:1.6;">
                Hi <strong>${signerName}</strong>,
              </p>
              <p style="color:#555;line-height:1.6;">
                ${emailIntro}
              </p>
              ${emailContext}
              <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;border-left:4px solid #F97316;">
                <p style="margin:0;color:#333;font-weight:600;font-size:15px;">📄 ${fileName}</p>
                <p style="margin:4px 0 0;color:#888;font-size:13px;">Sent by Deniz Saglam · BottomUP Inc.</p>
              </div>
              <p style="color:#555;line-height:1.6;">
                Please review the document and add your signature by clicking the button below:
              </p>
              <div style="text-align:center;margin:25px 0;">
                <a href="${signingLink}" style="display:inline-block;background:#F97316;color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:10px;font-size:16px;font-weight:600;">
                  Review & Sign Document
                </a>
              </div>
              <p style="color:#999;font-size:12px;line-height:1.6;">
                This is a secure signing link. Do not share it with others.
              </p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
              <p style="color:#999;font-size:12px;text-align:center;">BottomUP Inc. · E-Sign · <a href="https://bottomup.app" style="color:#F97316;">bottomup.app</a></p>
            </div>
          </div>
        `;

        const emailLines = [
          `From: Deniz Saglam | BottomUP <deniz@bottomup.app>`,
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
        if (!resp.ok) console.warn("[ESIGN] Invite email failed:", await resp.text());
      } catch (e) { console.warn("[ESIGN] Invite email error:", e.message); }
    }

    doc.inviteEmailSent = emailSent;
    if (emailSent) {
      // Update saved doc
      const allDocs = loadDocs();
      const idx = allDocs.findIndex(d => d.id === doc.id);
      if (idx >= 0) { allDocs[idx].inviteEmailSent = true; saveDocs(allDocs); }
    }

    res.json({ ok: true, document: doc, emailSent });
  } catch (err) {
    console.error("[ESIGN] Create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esign/list — all e-sign documents
router.get("/list", (_req, res) => {
  try {
    const docs = loadDocs();
    res.json({ ok: true, documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esign/doc/:id — get single document
router.get("/doc/:id", (req, res) => {
  try {
    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    res.json({ ok: true, document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/esign/pdf/:id — serve original PDF
router.get("/pdf/:id", (req, res) => {
  try {
    const pdfPath = path.join(ESIGN_PDF_DIR, `${req.params.id}-original.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF not found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.id}.pdf"`);
    res.send(fs.readFileSync(pdfPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/esign/:id/resend-invite — resend signing invitation email
router.post("/:id/resend-invite", async (req, res) => {
  try {
    const { gmailToken } = req.body;
    if (!gmailToken) return res.status(400).json({ error: "Gmail token required" });

    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.status === "completed") return res.status(400).json({ error: "Already completed" });

    const signingLink = `${req.protocol}://${req.get("host")}${doc.signingUrl}`;
    let subject = `Reminder: Please sign "${doc.originalName}"`;
    let emailIntro = `This is a friendly reminder that a document from <strong>BottomUP Inc.</strong> is awaiting your signature.`;

    // AI contextual email
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 200, temperature: 0.3,
            messages: [{ role: "user", content: `Write a short, friendly reminder email subject and intro for a document signing request.
Document: "${doc.originalName}", Signer: "${doc.signerName}", From: Deniz Saglam, BottomUP Inc.
Return JSON: {"subject": "...", "intro": "..."}` }],
          }),
        });
        const aiData = await aiResp.json();
        const match = (aiData.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
        if (match) { const p = JSON.parse(match[0]); if (p.subject) subject = p.subject; if (p.intro) emailIntro = p.intro; }
      } catch {}
    }

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#0B0C14;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
          <img src="${req.protocol}://${req.get("host")}/logo.png" alt="BottomUP" style="height:28px;" />
        </div>
        <div style="background:#ffffff;padding:30px;border:1px solid #eee;border-radius:0 0 12px 12px;">
          <h2 style="color:#1a1a1a;margin:0 0 15px;">Document Awaiting Your Signature</h2>
          <p style="color:#555;line-height:1.6;">Hi <strong>${doc.signerName}</strong>,</p>
          <p style="color:#555;line-height:1.6;">${emailIntro}</p>
          <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:20px 0;border-left:4px solid #F97316;">
            <p style="margin:0;color:#333;font-weight:600;font-size:15px;">📄 ${doc.originalName}</p>
            <p style="margin:4px 0 0;color:#888;font-size:13px;">Sent by Deniz Saglam · BottomUP Inc.</p>
          </div>
          <div style="text-align:center;margin:25px 0;">
            <a href="${signingLink}" style="display:inline-block;background:#F97316;color:#ffffff;text-decoration:none;padding:14px 40px;border-radius:10px;font-size:16px;font-weight:600;">Review & Sign Document</a>
          </div>
          <p style="color:#999;font-size:12px;">This is a secure signing link. Do not share it with others.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
          <p style="color:#999;font-size:12px;text-align:center;">BottomUP Inc. · E-Sign</p>
        </div>
      </div>
    `;

    const emailLines = [
      `From: Deniz Saglam | BottomUP <deniz@bottomup.app>`,
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
      console.warn("[ESIGN] Resend invite failed:", errText);
      return res.status(500).json({ error: "Failed to send email" });
    }

    // Update doc
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx >= 0) { docs[docIdx].inviteEmailSent = true; saveDocs(docs); }

    res.json({ ok: true, message: `Invitation sent to ${doc.signerEmail}` });
  } catch (err) {
    console.error("[ESIGN] Resend invite error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ PUBLIC SIGNING ENDPOINTS (no auth required) ══

// GET /api/esign/sign/:token — get document for signing (public)
router.get("/sign/:token", (req, res) => {
  try {
    const docs = loadDocs();
    const doc = docs.find(d => d.signingToken === req.params.token);
    if (!doc) return res.status(404).json({ error: "Signing link expired or invalid" });
    if (doc.signerSigned) return res.json({ ok: true, document: doc, alreadySigned: true });

    // Return doc info (not the token itself for security)
    res.json({
      ok: true,
      document: {
        id: doc.id,
        fileName: doc.originalName,
        signerName: doc.signerName,
        status: doc.status,
        founderSigned: doc.founderSigned,
        signerSigned: doc.signerSigned,
        createdAt: doc.createdAt,
      },
      pdfUrl: `/api/esign/pdf/${doc.id}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/esign/sign/:token — submit signer's signature (public)
router.post("/sign/:token", async (req, res) => {
  try {
    const { signature, signatureType } = req.body; // signature: base64 image, signatureType: "drawn" | "typed"
    if (!signature) return res.status(400).json({ error: "Signature is required" });

    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.signingToken === req.params.token);
    if (docIdx === -1) return res.status(404).json({ error: "Signing link expired or invalid" });
    if (docs[docIdx].signerSigned) return res.status(400).json({ error: "Already signed" });

    // Save signer signature image
    const sigBuffer = Buffer.from(signature.replace(/^data:image\/\w+;base64,/, ""), "base64");
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-signer-sig.png`), sigBuffer);

    // Embed signer signature into PDF
    const pdfPath = path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-original.pdf`);
    if (fs.existsSync(pdfPath)) {
      try {
        const currentPdf = fs.readFileSync(pdfPath);
        const signedPdf = await embedSignatureInPDF(currentPdf, sigBuffer, "signer", docs[docIdx].signerName);
        fs.writeFileSync(pdfPath, signedPdf);
        console.log("[ESIGN] Signer signature embedded into PDF");
      } catch (e) { console.warn("[ESIGN] Failed to embed signer sig:", e.message); }
    }

    docs[docIdx].signerSigned = true;
    docs[docIdx].signerSignedAt = new Date().toISOString();
    docs[docIdx].signerSignature = signatureType || "drawn";
    docs[docIdx].status = "completed";
    docs[docIdx].completedAt = new Date().toISOString();
    docs[docIdx].completionEmailPending = true;

    saveDocs(docs);

    res.json({ ok: true, message: "Document signed successfully!" });
  } catch (err) {
    console.error("[ESIGN] Sign error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/esign/founder-sign/:id — founder signs their part
router.post("/founder-sign/:id", (req, res) => {
  try {
    const { signature } = req.body;
    if (!signature) return res.status(400).json({ error: "Signature is required" });

    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx === -1) return res.status(404).json({ error: "Document not found" });

    const sigBuffer = Buffer.from(signature.replace(/^data:image\/\w+;base64,/, ""), "base64");
    fs.writeFileSync(path.join(ESIGN_PDF_DIR, `${docs[docIdx].id}-founder-sig.png`), sigBuffer);

    docs[docIdx].founderSigned = true;
    docs[docIdx].founderSignedAt = new Date().toISOString();
    docs[docIdx].status = "awaiting_signer";

    saveDocs(docs);
    res.json({ ok: true, document: docs[docIdx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/esign/:id/send-completion — send signed doc to both parties via Gmail
router.post("/:id/send-completion", async (req, res) => {
  try {
    const { gmailToken } = req.body;
    if (!gmailToken) return res.status(400).json({ error: "Gmail token required" });

    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.status !== "completed") return res.status(400).json({ error: "Document not yet completed" });

    // Read PDF
    const pdfPath = path.join(ESIGN_PDF_DIR, `${doc.id}-original.pdf`);
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "PDF file not found" });
    const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

    const subject = `Signed: ${doc.originalName}`;
    const recipients = [doc.signerEmail, "deniz@bottomup.app"];

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#0B0C14;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
          <img src="https://profound-upliftment-production-7ed2.up.railway.app/logo.png" alt="BottomUP" style="height:28px;" />
        </div>
        <div style="background:#ffffff;padding:30px;border:1px solid #eee;border-radius:0 0 12px 12px;">
          <h2 style="color:#1a1a1a;margin:0 0 15px;">Document Signed Successfully ✅</h2>
          <p style="color:#555;line-height:1.6;">
            The document <strong>${doc.originalName}</strong> has been signed by all parties.
          </p>
          <table style="width:100%;margin:20px 0;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#888;width:120px;">Document</td><td style="padding:8px 0;color:#333;font-weight:600;">${doc.originalName}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Signer</td><td style="padding:8px 0;color:#333;">${doc.signerName} (${doc.signerEmail})</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Signed Date</td><td style="padding:8px 0;color:#333;">${new Date(doc.completedAt).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" })}</td></tr>
            <tr><td style="padding:8px 0;color:#888;">Status</td><td style="padding:8px 0;color:#16a34a;font-weight:600;">✅ Completed</td></tr>
          </table>
          <p style="color:#555;line-height:1.6;">The signed document is attached to this email.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
          <p style="color:#999;font-size:12px;text-align:center;">BottomUP Inc. · E-Sign</p>
        </div>
      </div>
    `;

    let sent = 0;
    for (const to of recipients) {
      try {
        // Build MIME email with PDF attachment
        const boundary = `boundary_${Date.now()}`;
        const emailParts = [
          `From: Deniz Saglam | BottomUP <deniz@bottomup.app>`,
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
        else console.warn(`[ESIGN] Email to ${to} failed:`, await resp.text());
      } catch (e) { console.warn(`[ESIGN] Email to ${to} error:`, e.message); }
    }

    // Mark email sent
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx >= 0) {
      docs[docIdx].completionEmailPending = false;
      docs[docIdx].completionEmailSent = true;
      docs[docIdx].completionEmailSentAt = new Date().toISOString();
      saveDocs(docs);
    }

    res.json({ ok: true, sent, total: recipients.length });
  } catch (err) {
    console.error("[ESIGN] Send completion email error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/esign/:id/move-to-dd — move completed doc to Due Diligence
router.post("/:id/move-to-dd", (req, res) => {
  try {
    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx === -1) return res.status(404).json({ error: "Document not found" });

    docs[docIdx].movedToDueDiligence = true;
    saveDocs(docs);

    // Also add to DD documents
    const ddFile = path.join(DATA_DIR, "dd-documents.json");
    let ddDocs = [];
    try { ddDocs = JSON.parse(fs.readFileSync(ddFile, "utf8")); } catch {}
    ddDocs.unshift({
      name: docs[docIdx].fileName,
      type: `Signed Agreement — ${docs[docIdx].signerName}`,
      category: "Legal",
      date: docs[docIdx].completedAt || new Date().toISOString(),
      url: `/api/esign/pdf/${docs[docIdx].id}`,
      uploadedAt: new Date().toISOString(),
    });
    fs.writeFileSync(ddFile, JSON.stringify(ddDocs, null, 2));

    res.json({ ok: true, message: "Moved to Due Diligence" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/esign/:id — delete document
router.delete("/:id", (req, res) => {
  try {
    const docs = loadDocs();
    const docIdx = docs.findIndex(d => d.id === req.params.id);
    if (docIdx === -1) return res.status(404).json({ error: "Document not found" });

    const doc = docs.splice(docIdx, 1)[0];
    saveDocs(docs);

    // Cleanup files
    const files = [`${doc.id}-original.pdf`, `${doc.id}-founder-sig.png`, `${doc.id}-signer-sig.png`];
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
