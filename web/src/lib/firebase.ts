import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAiH_ymd1xifNgWRLF_FqFSJloVOkn7whE",
  authDomain: "bottomup-1cb62.firebaseapp.com",
  projectId: "bottomup-1cb62",
  storageBucket: "bottomup-1cb62.appspot.com",
  messagingSenderId: "233935259074",
  appId: "1:233935259074:web:129d929bd2926f97d1c25b",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Gmail token stub (kept for backwards compat with email sending)
export async function getFreshGmailToken(): Promise<string | null> {
  return sessionStorage.getItem("gmail_token");
}

export function getGmailToken(): string | null {
  return sessionStorage.getItem("gmail_token");
}

// ── Phone Auth OTP via Identity Toolkit REST API ──
// Uses Firebase Identity Toolkit directly to avoid reCAPTCHA Enterprise issues

const API_KEY = firebaseConfig.apiKey;
let sessionInfo: string | null = null;

export async function sendPhoneOtp(phoneNumber: string): Promise<boolean> {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber }),
    }
  );
  const data = await resp.json();
  if (data.error) {
    throw new Error(data.error.message || "OTP gönderilemedi");
  }
  sessionInfo = data.sessionInfo;
  return true;
}

export async function verifyPhoneOtp(code: string): Promise<boolean> {
  if (!sessionInfo) {
    throw new Error("Önce OTP gönderin");
  }
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionInfo, code }),
    }
  );
  const data = await resp.json();
  if (data.error) {
    throw new Error(data.error.message === "INVALID_CODE" ? "Geçersiz doğrulama kodu" : (data.error.message || "Doğrulama başarısız"));
  }
  return true;
}

// No-ops for compatibility
export function setupRecaptcha(_containerId: string) {}
export function clearRecaptcha() { sessionInfo = null; }
