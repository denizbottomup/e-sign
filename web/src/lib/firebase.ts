import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ── Phone Auth OTP via Identity Toolkit REST API ──
// Uses Firebase Identity Toolkit directly to avoid reCAPTCHA Enterprise issues

const API_KEY = import.meta.env.VITE_FIREBASE_API_KEY || "";
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
