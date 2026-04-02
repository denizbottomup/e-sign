// Stub — no auth in standalone e-sign app
export async function getFreshGmailToken(): Promise<string | null> {
  return sessionStorage.getItem("gmail_token");
}

export function getGmailToken(): string | null {
  return sessionStorage.getItem("gmail_token");
}
