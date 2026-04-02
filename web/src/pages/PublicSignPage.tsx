import { useState, useRef, useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FileSignature, Check, RefreshCw, ChevronDown, ShieldCheck, Phone } from "lucide-react";
import { setupRecaptcha, sendPhoneOtp, verifyPhoneOtp, clearRecaptcha } from "@/lib/firebase";

// Load Google Fonts for signature
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;600;700&family=Great+Vibes&family=Marck+Script&display=swap";

type PageState = "loading" | "otp_pending" | "otp_verified" | "error" | "already_signed" | "submitted";

export default function PublicSignPage() {
  const { token } = useParams<{ token: string }>();
  const [doc, setDoc] = useState<{
    id: string; fileName: string; signerName: string; signerPhone?: string;
    tcKimlikNo?: string; status: string; signerSigned: boolean; requiresOtp?: boolean;
  } | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [pageState, setPageState] = useState<PageState>("loading");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // OTP
  const [otpCode, setOtpCode] = useState(["", "", "", "", "", ""]);
  const [otpError, setOtpError] = useState("");
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const recaptchaReady = useRef(false);

  // Signature
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [useTypedSig, setUseTypedSig] = useState(false);
  const [signerDisplayName, setSignerDisplayName] = useState("");
  const [sigFont, setSigFont] = useState<"Dancing Script" | "Great Vibes" | "Marck Script">("Dancing Script");

  const sigAreaRef = useRef<HTMLDivElement>(null);

  // Load Google Fonts
  useEffect(() => {
    if (!document.querySelector(`link[href*="Dancing+Script"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = FONT_LINK;
      document.head.appendChild(link);
    }
  }, []);

  // Load document
  useEffect(() => {
    if (!token) return;
    fetch(`/api/esign/sign/${token}`)
      .then(r => r.json())
      .then(data => {
        if (!data.ok) { setError(data.error || "Geçersiz bağlantı"); setPageState("error"); return; }
        setDoc(data.document);
        setPdfUrl(data.pdfUrl || "");
        setSignerDisplayName(data.document.signerName);
        if (data.alreadySigned) { setPageState("already_signed"); return; }

        if (data.document.requiresOtp) {
          setPageState("otp_pending");
        } else {
          setPageState("otp_verified");
        }
      })
      .catch(() => { setError("Belge yüklenemedi"); setPageState("error"); });
  }, [token]);

  // Setup recaptcha when OTP page shown
  useEffect(() => {
    if (pageState === "otp_pending" && !recaptchaReady.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        try {
          setupRecaptcha("recaptcha-container");
          recaptchaReady.current = true;
        } catch (e) {
          console.error("Recaptcha setup error:", e);
        }
      }, 500);
    }
    return () => {
      if (pageState !== "otp_pending") {
        clearRecaptcha();
        recaptchaReady.current = false;
      }
    };
  }, [pageState]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => setResendCooldown(c => c - 1), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const handleSendOtp = useCallback(async () => {
    if (!doc?.signerPhone || otpSending) return;
    setOtpSending(true);
    setOtpError("");
    try {
      if (!recaptchaReady.current) {
        setupRecaptcha("recaptcha-container");
        recaptchaReady.current = true;
      }
      await sendPhoneOtp(doc.signerPhone);
      setResendCooldown(30);
      setOtpCode(["", "", "", "", "", ""]);
      setTimeout(() => otpInputsRef.current[0]?.focus(), 100);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "OTP gönderilemedi";
      setOtpError(msg);
      // Re-setup recaptcha for retry
      recaptchaReady.current = false;
      setTimeout(() => {
        try {
          setupRecaptcha("recaptcha-container");
          recaptchaReady.current = true;
        } catch {}
      }, 1000);
    } finally {
      setOtpSending(false);
    }
  }, [doc, otpSending]);

  const handleOtpChange = useCallback((index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newCode = [...otpCode];
    newCode[index] = value.slice(-1);
    setOtpCode(newCode);
    setOtpError("");
    if (value && index < 5) {
      otpInputsRef.current[index + 1]?.focus();
    }
  }, [otpCode]);

  const handleOtpKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otpCode[index] && index > 0) {
      otpInputsRef.current[index - 1]?.focus();
    }
  }, [otpCode]);

  const handleOtpPaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 0) return;
    const newCode = [...otpCode];
    for (let i = 0; i < pasted.length && i < 6; i++) {
      newCode[i] = pasted[i];
    }
    setOtpCode(newCode);
    const nextIdx = Math.min(pasted.length, 5);
    otpInputsRef.current[nextIdx]?.focus();
  }, [otpCode]);

  const handleVerifyOtp = useCallback(async () => {
    const code = otpCode.join("");
    if (code.length !== 6) { setOtpError("6 haneli kodu girin"); return; }

    setOtpVerifying(true);
    try {
      await verifyPhoneOtp(code);
      setPageState("otp_verified");
    } catch (e: unknown) {
      setOtpError(e instanceof Error ? e.message : "Doğrulama başarısız");
    } finally {
      setOtpVerifying(false);
    }
  }, [otpCode]);

  // Auto-scroll to signature area after OTP verified
  useEffect(() => {
    if (pageState === "otp_verified" && doc && sigAreaRef.current) {
      setTimeout(() => {
        sigAreaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 1500);
    }
  }, [pageState, doc]);

  // Canvas helpers
  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      const touch = e.touches[0] || e.changedTouches[0];
      return { x: (touch.clientX - rect.left) * scaleX, y: (touch.clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }, []);

  const startDraw = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (useTypedSig) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    setIsDrawing(true);
    setHasDrawn(true);
    const pos = getCanvasPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  }, [useTypedSig, getCanvasPos]);

  const drawMove = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing || useTypedSig) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pos = getCanvasPos(e);
    ctx.strokeStyle = "#1a56db";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }, [isDrawing, useTypedSig, getCanvasPos]);

  const stopDraw = useCallback(() => setIsDrawing(false), []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setUseTypedSig(false);
    setHasDrawn(false);
  }, []);

  const generateTypedSig = useCallback((fontOverride?: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const font = fontOverride || sigFont;
    const w = canvas.width;
    const h = canvas.height;
    const now = new Date();
    const dateStr = now.toLocaleDateString("tr-TR", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("tr-TR", { hour: "numeric", minute: "2-digit", hour12: false });
    ctx.clearRect(0, 0, w, h);
    const fontSize = Math.min(72, w / (signerDisplayName.length * 0.5));
    ctx.font = `700 ${fontSize}px '${font}', cursive`;
    ctx.fillStyle = "#1a56db";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(signerDisplayName, w / 2, h * 0.33);
    const lineWidth = Math.min(500, w * 0.75);
    const lineY = h * 0.56;
    ctx.beginPath();
    ctx.moveTo((w - lineWidth) / 2, lineY);
    ctx.lineTo((w + lineWidth) / 2, lineY);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = "16px 'DM Sans', 'Segoe UI', Arial, sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.textBaseline = "top";
    ctx.fillText(signerDisplayName, w / 2, lineY + 8);
    ctx.font = "13px 'DM Sans', 'Segoe UI', Arial, sans-serif";
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(`${dateStr} | ${timeStr}`, w / 2, lineY + 30);
    setUseTypedSig(true);
    setHasDrawn(true);
  }, [signerDisplayName, sigFont]);

  const handleSubmit = useCallback(async () => {
    if (!canvasRef.current || !token) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
    const hasContent = imageData.data.some((v, i) => i % 4 === 3 && v > 0);
    if (!hasContent) { alert("Lütfen önce imzanızı çizin veya oluşturun."); return; }

    setSubmitting(true);
    try {
      const signature = canvasRef.current.toDataURL("image/png");
      const resp = await fetch(`/api/esign/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature, signatureType: useTypedSig ? "typed" : "drawn" }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      setPageState("submitted");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "İmzalama başarısız oldu");
    } finally {
      setSubmitting(false);
    }
  }, [token, useTypedSig]);

  // ── Loading ──
  if (pageState === "loading") return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto text-[#1e3a5f]" />
        <p className="mt-3 text-gray-500 text-lg">Belge yükleniyor...</p>
      </div>
    </div>
  );

  // ── Error ──
  if (pageState === "error") return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center max-w-md">
        <div className="h-16 w-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
          <FileSignature className="h-8 w-8 text-red-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-800">Geçersiz İmza Linki</h1>
        <p className="text-gray-500 mt-2">{error}</p>
      </div>
    </div>
  );

  // ── Already Signed ──
  if (pageState === "already_signed") return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center max-w-md">
        <div className="h-16 w-16 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
          <Check className="h-8 w-8 text-green-500" />
        </div>
        <h1 className="text-xl font-semibold text-gray-800">Zaten İmzalanmış</h1>
        <p className="text-gray-500 mt-2">Bu belge zaten imzalanmış.</p>
      </div>
    </div>
  );

  // ── Submitted ──
  if (pageState === "submitted") return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center max-w-md">
        <div className="h-20 w-20 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
          <Check className="h-10 w-10 text-green-500" />
        </div>
        <h1 className="text-2xl font-bold text-gray-800">Belge İmzalandı!</h1>
        <p className="text-gray-500 mt-2 text-lg">Teşekkürler, {signerDisplayName}. İmzanız başarıyla gönderildi.</p>
        <p className="text-sm text-gray-400 mt-4">İmzalı belgenin bir kopyası e-posta ile gönderilecektir.</p>
        <p className="text-sm text-gray-400 mt-1">Bu sayfayı şimdi kapatabilirsiniz.</p>
      </div>
    </div>
  );

  // ── OTP Verification Screen (Firebase Phone Auth) ──
  if (pageState === "otp_pending") {
    const phoneDisplay = doc?.signerPhone || "";
    const masked = phoneDisplay.length > 4
      ? phoneDisplay.slice(0, -4).replace(/\d/g, "*") + phoneDisplay.slice(-4)
      : phoneDisplay;

    return (
      <div className="min-h-screen bg-[#fafbfc]">
        <div className="bg-white border-b px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <FileSignature className="h-6 w-6 text-[#1e3a5f]" />
            <span className="text-sm font-semibold text-[#1e3a5f]">Seçim Vekaleti</span>
          </div>
          <span className="text-sm text-gray-500 hidden sm:inline">Güvenli Belge İmzalama</span>
        </div>

        <div className="max-w-md mx-auto px-4 py-12">
          <div className="bg-white rounded-2xl border p-6 sm:p-8 shadow-sm text-center space-y-6">
            <div className="h-16 w-16 rounded-full bg-[#1e3a5f]/10 flex items-center justify-center mx-auto">
              <ShieldCheck className="h-8 w-8 text-[#1e3a5f]" />
            </div>

            <div>
              <h1 className="text-xl font-bold text-gray-800">Kimlik Doğrulama</h1>
              <p className="text-gray-500 mt-2">
                <strong>{masked}</strong> numarasına doğrulama kodu gönderin
              </p>
            </div>

            {/* Send OTP button (first step) */}
            {resendCooldown === 0 && otpCode.every(d => d === "") && !otpSending && (
              <Button
                className="w-full bg-[#1e3a5f] hover:bg-[#162d4a] text-white text-lg py-6 rounded-xl"
                onClick={handleSendOtp}
              >
                <Phone className="h-5 w-5 mr-2" /> Doğrulama Kodu Gönder
              </Button>
            )}

            {/* OTP sending spinner */}
            {otpSending && (
              <div className="py-4">
                <RefreshCw className="h-8 w-8 animate-spin mx-auto text-[#1e3a5f]" />
                <p className="text-gray-500 mt-2">Kod gönderiliyor...</p>
              </div>
            )}

            {/* OTP Input (shown after sending) */}
            {resendCooldown > 0 && !otpSending && (
              <>
                <p className="text-sm text-gray-500">Doğrulama kodu gönderildi</p>

                <div className="flex justify-center gap-2 sm:gap-3" onPaste={handleOtpPaste}>
                  {otpCode.map((digit, i) => (
                    <input
                      key={i}
                      ref={el => { otpInputsRef.current[i] = el; }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={e => handleOtpChange(i, e.target.value)}
                      onKeyDown={e => handleOtpKeyDown(i, e)}
                      className="w-12 h-14 sm:w-14 sm:h-16 text-center text-2xl font-bold rounded-xl border-2 bg-gray-50 focus:border-[#1e3a5f] focus:ring-2 focus:ring-[#1e3a5f]/20 outline-none transition-all text-gray-800"
                      style={{ borderColor: otpError ? "#ef4444" : "#e5e7eb" }}
                    />
                  ))}
                </div>

                {otpError && (
                  <p className="text-red-500 text-sm font-medium">{otpError}</p>
                )}

                <Button
                  className="w-full bg-[#1e3a5f] hover:bg-[#162d4a] text-white text-lg py-6 rounded-xl"
                  disabled={otpVerifying || otpCode.join("").length !== 6}
                  onClick={handleVerifyOtp}
                >
                  {otpVerifying ? (
                    <><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Doğrulanıyor...</>
                  ) : (
                    "Doğrula"
                  )}
                </Button>

                <div className="text-sm text-gray-400">
                  Kod gelmedi mi?{" "}
                  {resendCooldown > 0 ? (
                    <span className="text-gray-500">{resendCooldown} saniye bekleyin</span>
                  ) : (
                    <button onClick={handleSendOtp} className="text-[#1e3a5f] font-medium hover:underline">
                      Tekrar gönder
                    </button>
                  )}
                </div>
              </>
            )}

            {/* Invisible reCAPTCHA container */}
            <div id="recaptcha-container" />
          </div>

          <div className="text-center text-xs text-gray-400 mt-6">
            <p className="flex items-center justify-center gap-1">
              <Phone className="h-3 w-3" /> Firebase ile güvenli telefon doğrulama
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Main Signing Page (OTP verified or no OTP needed) ──
  return (
    <div className="min-h-screen bg-[#fafbfc]">
      <div className="bg-white border-b px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <FileSignature className="h-6 w-6 text-[#1e3a5f]" />
          <span className="text-sm font-semibold text-[#1e3a5f]">Seçim Vekaleti</span>
        </div>
        <div className="flex items-center gap-2">
          {doc?.requiresOtp && (
            <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> Doğrulandı
            </span>
          )}
          <span className="text-sm text-gray-500 hidden sm:inline">Güvenli Belge İmzalama</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="bg-white rounded-xl border p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-12 w-12 rounded-full bg-[#1e3a5f]/10 flex items-center justify-center flex-shrink-0">
              <FileSignature className="h-6 w-6 text-[#1e3a5f]" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-semibold text-gray-800">Belgeyi İmzala</h1>
              <p className="text-sm text-gray-500 truncate max-w-[300px] sm:max-w-none">{doc?.fileName}</p>
            </div>
          </div>
          <div className="rounded-lg bg-blue-50 border border-blue-100 p-4 text-sm sm:text-base text-gray-700">
            <p>Sayın <strong>{signerDisplayName}</strong>, aşağıdaki seçim vekaleti belgesini incelemeniz ve imzalamanız istenmektedir.</p>
            <p className="mt-2 text-gray-500">Lütfen belgenin tamamını inceleyin, ardından aşağı kaydırarak imzanızı ekleyin.</p>
          </div>
        </div>

        {pdfUrl && (
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-gray-50 text-sm text-gray-500 flex items-center justify-between">
              <span className="font-medium">Belge Önizleme</span>
              <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-[#1e3a5f] hover:underline text-sm">Tam PDF Aç ↗</a>
            </div>
            <div className="relative">
              <iframe src={pdfUrl} className="w-full" style={{ height: "70vh", minHeight: "500px", border: "none" }} title="Belge" />
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white to-transparent flex items-end justify-center pb-2 pointer-events-none">
                <div className="flex items-center gap-1 text-gray-400 text-sm animate-bounce">
                  <ChevronDown className="h-4 w-4" />
                  <span>Belgenin tamamını görüntülemek için kaydırın</span>
                  <ChevronDown className="h-4 w-4" />
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={sigAreaRef} className="bg-white rounded-xl border p-5 sm:p-6 shadow-sm space-y-5">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-[#1e3a5f]" />
            <h2 className="text-lg sm:text-xl font-semibold text-gray-800">İmzanız</h2>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${!useTypedSig ? "bg-[#1e3a5f] text-white shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`} onClick={() => clearCanvas()}>
              ✍️ İmza Çiz
            </button>
            <button className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${useTypedSig ? "bg-[#1e3a5f] text-white shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`} onClick={() => generateTypedSig()}>
              Aa Otomatik Oluştur
            </button>
            {hasDrawn && (
              <button className="px-4 py-2.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-all" onClick={clearCanvas}>
                Temizle
              </button>
            )}
          </div>

          {useTypedSig && (
            <div className="flex gap-2">
              {(["Dancing Script", "Great Vibes", "Marck Script"] as const).map(font => (
                <button key={font} className={`flex-1 py-4 rounded-lg text-center transition-all border-2 ${sigFont === font ? "border-[#1e3a5f] bg-blue-50 shadow-sm" : "border-gray-200 bg-white hover:bg-gray-50"}`} onClick={() => { setSigFont(font); generateTypedSig(font); }}>
                  <span style={{ fontFamily: `'${font}', cursive`, fontSize: "28px", color: sigFont === font ? "#1a56db" : "#9ca3af" }}>{signerDisplayName || "Adınız"}</span>
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <canvas ref={canvasRef} width={700} height={200} className="w-full rounded-xl touch-none"
              style={{ background: useTypedSig ? "#fefefe" : "#f9fafb", border: useTypedSig ? "1px solid #e5e7eb" : "2px dashed #d1d5db", cursor: useTypedSig ? "default" : "crosshair", aspectRatio: "3.5/1" }}
              onMouseDown={startDraw} onMouseMove={drawMove} onMouseUp={stopDraw} onMouseLeave={stopDraw}
              onTouchStart={startDraw} onTouchMove={drawMove} onTouchEnd={stopDraw} onTouchCancel={stopDraw}
            />
            {!useTypedSig && !hasDrawn && (
              <p className="absolute inset-0 flex items-center justify-center text-gray-300 pointer-events-none text-lg sm:text-xl">İmzanızı buraya çizin</p>
            )}
          </div>

          <p className="text-xs sm:text-sm text-gray-400">
            Bu belgeyi imzalayarak, yukarıda belirtilen seçim vekaleti şartlarını kabul etmiş olursunuz. İmzanız hukuken bağlayıcıdır.
          </p>

          <div className="flex gap-3">
            <Button className="flex-1 bg-[#1e3a5f] hover:bg-[#162d4a] text-white text-base sm:text-lg py-6 sm:py-7 rounded-xl shadow-sm" disabled={submitting || !hasDrawn} onClick={handleSubmit}>
              {submitting ? <><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Gönderiliyor...</> : "İmzayı Gönder"}
            </Button>
            {hasDrawn && (
              <Button variant="outline" className="py-6 sm:py-7 rounded-xl px-6" onClick={clearCanvas}>Tekrar İmzala</Button>
            )}
          </div>
        </div>

        <div className="text-center text-xs text-gray-400 py-4">
          <p>Seçim Vekaleti İmza Sistemi</p>
          <p className="mt-1">Bu belge şifrelenmiştir ve imzanız güvenli olarak saklanmaktadır.</p>
        </div>
      </div>
    </div>
  );
}
