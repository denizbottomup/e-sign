import { initializeApp } from "firebase/app";
import { getAuth, RecaptchaVerifier, signInWithPhoneNumber, ConfirmationResult } from "firebase/auth";

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
auth.useDeviceLanguage();

// ── Firebase Phone Auth OTP ──

let recaptchaVerifier: RecaptchaVerifier | null = null;
let confirmationResult: ConfirmationResult | null = null;

export function setupRecaptcha(containerId: string) {
  if (recaptchaVerifier) {
    try { recaptchaVerifier.clear(); } catch {}
  }
  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: "invisible",
  });
}

export async function sendPhoneOtp(phoneNumber: string): Promise<boolean> {
  if (!recaptchaVerifier) {
    throw new Error("RecaptchaVerifier henüz hazır değil");
  }
  try {
    confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, recaptchaVerifier);
    return true;
  } catch (e: unknown) {
    console.error("[Firebase] OTP gönderim hatası:", e);
    // Reset for retry
    try { recaptchaVerifier.clear(); } catch {}
    recaptchaVerifier = null;
    throw e;
  }
}

export async function verifyPhoneOtp(code: string): Promise<boolean> {
  if (!confirmationResult) {
    throw new Error("Önce OTP gönderin");
  }
  try {
    await confirmationResult.confirm(code);
    return true;
  } catch {
    throw new Error("Geçersiz doğrulama kodu");
  }
}

export function clearRecaptcha() {
  if (recaptchaVerifier) {
    try { recaptchaVerifier.clear(); } catch {}
    recaptchaVerifier = null;
  }
  confirmationResult = null;
}
