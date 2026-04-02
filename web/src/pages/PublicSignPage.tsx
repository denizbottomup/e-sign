import { useState, useRef, useCallback, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FileSignature, Check, RefreshCw, ChevronDown } from "lucide-react";

// Load Google Fonts for signature
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;600;700&family=Great+Vibes&family=Marck+Script&display=swap";

export default function PublicSignPage() {
  const { token } = useParams<{ token: string }>();
  const [doc, setDoc] = useState<{ id: string; fileName: string; signerName: string; status: string; founderSigned: boolean; signerSigned: boolean } | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [alreadySigned, setAlreadySigned] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
        if (!data.ok) { setError(data.error || "Invalid link"); setLoading(false); return; }
        setDoc(data.document);
        setPdfUrl(data.pdfUrl || "");
        setSignerDisplayName(data.document.signerName);
        if (data.alreadySigned) setAlreadySigned(true);
        setLoading(false);
      })
      .catch(() => { setError("Failed to load document"); setLoading(false); });
  }, [token]);

  // Auto-scroll to signature area after PDF loads
  useEffect(() => {
    if (!loading && doc && sigAreaRef.current) {
      setTimeout(() => {
        sigAreaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 1500);
    }
  }, [loading, doc]);

  // Get canvas coordinates from mouse or touch event
  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    if ("touches" in e) {
      const touch = e.touches[0] || e.changedTouches[0];
      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      };
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  // Drawing
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
    const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    ctx.clearRect(0, 0, w, h);

    // Large cursive signature
    const fontSize = Math.min(72, w / (signerDisplayName.length * 0.5));
    ctx.font = `700 ${fontSize}px '${font}', cursive`;
    ctx.fillStyle = "#1a56db";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(signerDisplayName, w / 2, h * 0.33);

    // Signature line
    const lineWidth = Math.min(500, w * 0.75);
    const lineY = h * 0.56;
    ctx.beginPath();
    ctx.moveTo((w - lineWidth) / 2, lineY);
    ctx.lineTo((w + lineWidth) / 2, lineY);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Print name
    ctx.font = "16px 'DM Sans', 'Segoe UI', Arial, sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.textBaseline = "top";
    ctx.fillText(signerDisplayName, w / 2, lineY + 8);

    // Date + time
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
    if (!hasContent) { alert("Please draw or generate your signature first."); return; }

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
      setSubmitted(true);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Signing failed");
    } finally {
      setSubmitting(false);
    }
  }, [token, useTypedSig]);

  // Loading
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto text-[#F97316]" />
        <p className="mt-3 text-gray-500 text-lg">Loading document...</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center max-w-md">
        <div className="h-16 w-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
          <FileSignature className="h-8 w-8 text-red-400" />
        </div>
        <h1 className="text-xl font-semibold text-gray-800">Invalid Signing Link</h1>
        <p className="text-gray-500 mt-2">{error}</p>
      </div>
    </div>
  );

  if (alreadySigned) return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center max-w-md">
        <div className="h-16 w-16 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
          <Check className="h-8 w-8 text-green-500" />
        </div>
        <h1 className="text-xl font-semibold text-gray-800">Already Signed</h1>
        <p className="text-gray-500 mt-2">This document has already been signed.</p>
      </div>
    </div>
  );

  if (submitted) return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafbfc]">
      <div className="text-center max-w-md">
        <div className="h-20 w-20 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
          <Check className="h-10 w-10 text-green-500" />
        </div>
        <h1 className="text-2xl font-bold text-gray-800">Document Signed!</h1>
        <p className="text-gray-500 mt-2 text-lg">Thank you, {signerDisplayName}. Your signature has been submitted successfully.</p>
        <p className="text-sm text-gray-400 mt-4">You will receive a copy of the signed document via email.</p>
        <p className="text-sm text-gray-400 mt-1">You can close this page now.</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#fafbfc]">
      {/* Header */}
      <div className="bg-white border-b px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="BottomUP" className="h-7" />
          <span className="text-sm text-gray-400 hidden sm:inline">E-Sign</span>
        </div>
        <span className="text-sm text-gray-500 hidden sm:inline">Secure Document Signing</span>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Document info */}
        <div className="bg-white rounded-xl border p-5 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-12 w-12 rounded-full bg-[#F97316]/10 flex items-center justify-center flex-shrink-0">
              <FileSignature className="h-6 w-6 text-[#F97316]" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-semibold text-gray-800">Sign Document</h1>
              <p className="text-sm text-gray-500 truncate max-w-[300px] sm:max-w-none">{doc?.fileName}</p>
            </div>
          </div>

          <div className="rounded-lg bg-blue-50 border border-blue-100 p-4 text-sm sm:text-base text-gray-700">
            <p><strong>{signerDisplayName}</strong>, you have been asked to review and sign this document by <strong>BottomUP Inc.</strong></p>
            <p className="mt-2 text-gray-500">Please review the full document below, then scroll down to add your signature.</p>
          </div>
        </div>

        {/* PDF Preview — taller with scroll-to-bottom hint */}
        {pdfUrl && (
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-gray-50 text-sm text-gray-500 flex items-center justify-between">
              <span className="font-medium">Document Preview</span>
              <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-[#F97316] hover:underline text-sm">
                Open Full PDF ↗
              </a>
            </div>
            <div className="relative">
              <iframe src={pdfUrl} className="w-full" style={{ height: "70vh", minHeight: "500px", border: "none" }} title="Document" />
              {/* Scroll hint */}
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white to-transparent flex items-end justify-center pb-2 pointer-events-none">
                <div className="flex items-center gap-1 text-gray-400 text-sm animate-bounce">
                  <ChevronDown className="h-4 w-4" />
                  <span>Scroll to review full document</span>
                  <ChevronDown className="h-4 w-4" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Signature Area */}
        <div ref={sigAreaRef} className="bg-white rounded-xl border p-5 sm:p-6 shadow-sm space-y-5">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-[#F97316]" />
            <h2 className="text-lg sm:text-xl font-semibold text-gray-800">Your Signature</h2>
          </div>

          {/* Signature mode selector */}
          <div className="flex gap-2 flex-wrap">
            <button
              className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${!useTypedSig ? "bg-[#F97316] text-white shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              onClick={() => { clearCanvas(); }}
            >
              ✍️ Draw Signature
            </button>
            <button
              className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${useTypedSig ? "bg-[#F97316] text-white shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
              onClick={() => generateTypedSig()}
            >
              Aa Auto-Generate
            </button>
            {hasDrawn && (
              <button
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-all"
                onClick={clearCanvas}
              >
                Clear
              </button>
            )}
          </div>

          {/* Font selector (auto mode) */}
          {useTypedSig && (
            <div className="flex gap-2">
              {(["Dancing Script", "Great Vibes", "Marck Script"] as const).map(font => (
                <button
                  key={font}
                  className={`flex-1 py-4 rounded-lg text-center transition-all border-2 ${
                    sigFont === font
                      ? "border-[#F97316] bg-orange-50 shadow-sm"
                      : "border-gray-200 bg-white hover:bg-gray-50"
                  }`}
                  onClick={() => { setSigFont(font); generateTypedSig(font); }}
                >
                  <span style={{ fontFamily: `'${font}', cursive`, fontSize: "28px", color: sigFont === font ? "#1a56db" : "#9ca3af" }}>
                    {signerDisplayName || "Your Name"}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Signature canvas */}
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={700}
              height={200}
              className="w-full rounded-xl touch-none"
              style={{
                background: useTypedSig ? "#fefefe" : "#f9fafb",
                border: useTypedSig ? "1px solid #e5e7eb" : "2px dashed #d1d5db",
                cursor: useTypedSig ? "default" : "crosshair",
                aspectRatio: "3.5/1",
              }}
              // Mouse events
              onMouseDown={startDraw}
              onMouseMove={drawMove}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              // Touch events
              onTouchStart={startDraw}
              onTouchMove={drawMove}
              onTouchEnd={stopDraw}
              onTouchCancel={stopDraw}
            />
            {!useTypedSig && !hasDrawn && (
              <p className="absolute inset-0 flex items-center justify-center text-gray-300 pointer-events-none text-lg sm:text-xl">
                Draw your signature here
              </p>
            )}
          </div>

          <p className="text-xs sm:text-sm text-gray-400">
            By signing this document, you agree to the terms outlined above. Your signature is legally binding.
          </p>

          {/* Submit buttons */}
          <div className="flex gap-3">
            <Button
              className="flex-1 bg-[#F97316] hover:bg-[#ea6c10] text-white text-base sm:text-lg py-6 sm:py-7 rounded-xl shadow-sm"
              disabled={submitting || !hasDrawn}
              onClick={handleSubmit}
            >
              {submitting ? (
                <><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Submitting...</>
              ) : (
                "Submit Signature"
              )}
            </Button>
            {hasDrawn && (
              <Button variant="outline" className="py-6 sm:py-7 rounded-xl px-6" onClick={clearCanvas}>
                Re-sign
              </Button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-gray-400 py-4">
          <p>Powered by BottomUP E-Sign</p>
          <p className="mt-1">This document is encrypted and your signature is securely stored.</p>
        </div>
      </div>
    </div>
  );
}
