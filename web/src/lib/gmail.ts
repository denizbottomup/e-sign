// ══════════════════════════════════════════════════════════════════════
//  Gmail API — Send emails via user's Gmail account
//  Uses OAuth access_token from Google login (gmail.send scope)
// ══════════════════════════════════════════════════════════════════════

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function base64urlEncode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildRawEmail({
  from,
  to,
  bcc,
  subject,
  body,
  htmlBody,
}: {
  from: string;
  to: string;
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
}): string {
  const boundary = "boundary_" + Date.now();
  const replyTo = "deniz@bottomup.app";
  const headers = [
    `From: Deniz Saglam | BottomUP <${from}>`,
    `Reply-To: ${replyTo}`,
    `To: ${to}`,
  ];
  if (bcc && bcc.length > 0) {
    headers.push(`Bcc: ${bcc.join(", ")}`);
  }
  headers.push(
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  );

  // If no explicit HTML, convert plain text
  const finalHtml = htmlBody || body
    .replace(/\n/g, "<br>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#F97316;">$1</a>');

  const raw = [
    ...headers,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    body,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    finalHtml,
    ``,
    `--${boundary}--`,
  ].join("\r\n");

  return base64urlEncode(raw);
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// Send single email
export async function sendGmailEmail(
  token: string,
  to: string,
  subject: string,
  body: string,
  from: string = "deniz@bottomup.app",
  htmlBody?: string
): Promise<SendEmailResult> {
  if (!token) {
    return { success: false, error: "Gmail token yok — tekrar login ol" };
  }
  if (!to || !to.includes("@")) {
    return { success: false, error: "Gecersiz email adresi" };
  }

  const raw = buildRawEmail({ from, to, subject, body, htmlBody });

  try {
    const res = await fetch(GMAIL_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        sessionStorage.removeItem("gmail_token");
        return { success: false, error: "Gmail token expired — tekrar login ol" };
      }
      return { success: false, error: err.error?.message || `Gmail API error: ${res.status}` };
    }

    const data = await res.json();
    return { success: true, messageId: data.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Gmail gonderim hatasi" };
  }
}

// Send BCC batch email (max ~90 per batch for Gmail safety)
const BCC_BATCH_SIZE = 90;

export interface BulkSendProgress {
  totalBatches: number;
  completedBatches: number;
  totalEmails: number;
  sentEmails: number;
  failedBatches: number;
  errors: string[];
  done: boolean;
}

export async function sendBulkBccEmail(
  token: string,
  emails: string[],
  subject: string,
  body: string,
  from: string = "deniz@bottomup.app",
  onProgress?: (progress: BulkSendProgress) => void,
  htmlBody?: string
): Promise<BulkSendProgress> {
  // Filter valid emails and deduplicate
  const validEmails = [...new Set(emails.filter(e => e && e.includes("@") && e !== from))];

  const batches: string[][] = [];
  for (let i = 0; i < validEmails.length; i += BCC_BATCH_SIZE) {
    batches.push(validEmails.slice(i, i + BCC_BATCH_SIZE));
  }

  const progress: BulkSendProgress = {
    totalBatches: batches.length,
    completedBatches: 0,
    totalEmails: validEmails.length,
    sentEmails: 0,
    failedBatches: 0,
    errors: [],
    done: false,
  };

  for (const batch of batches) {
    const raw = buildRawEmail({
      from,
      to: from, // Send to self
      bcc: batch,
      subject,
      body,
      htmlBody,
    });

    try {
      const res = await fetch(GMAIL_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401) {
          sessionStorage.removeItem("gmail_token");
          progress.errors.push("Gmail token expired — tekrar login ol");
          progress.done = true;
          onProgress?.(progress);
          return progress;
        }
        progress.failedBatches++;
        progress.errors.push(err.error?.message || `Batch failed: ${res.status}`);
      } else {
        progress.sentEmails += batch.length;
      }
    } catch (err) {
      progress.failedBatches++;
      progress.errors.push(err instanceof Error ? err.message : "Batch error");
    }

    progress.completedBatches++;
    onProgress?.({ ...progress });

    // Rate limit: wait 2 seconds between batches
    if (progress.completedBatches < batches.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  progress.done = true;
  onProgress?.({ ...progress });
  return progress;
}
