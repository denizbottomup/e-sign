import { useState, useRef, useCallback, useEffect } from "react";
import useSWR from "swr";
import { swrFetcher, apiPost, apiDelete } from "@/lib/api";
import { getFreshGmailToken, getGmailToken } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  FileSignature,
  Upload,
  Send,
  Check,
  Clock,
  X,
  Trash2,
  ExternalLink,
  FolderCheck,
  Eye,
  RefreshCw,
  Mail,
} from "lucide-react";
import { toast } from "sonner";

interface ESignDoc {
  id: string;
  fileName: string;
  originalName: string;
  signerName: string;
  signerEmail: string;
  status: "awaiting_founder" | "awaiting_signer" | "completed";
  founderSigned: boolean;
  signerSigned: boolean;
  signingToken: string;
  signingUrl: string;
  createdAt: string;
  completedAt: string | null;
  movedToDueDiligence: boolean;
  completionEmailPending?: boolean;
  completionEmailSent?: boolean;
  inviteEmailSent?: boolean;
}

const STATUS_CONFIG = {
  awaiting_founder: { label: "Awaiting Your Signature", color: "bg-yellow-500/15 text-yellow-400", icon: Clock },
  awaiting_signer: { label: "Awaiting Signer", color: "bg-blue-500/15 text-blue-400", icon: Send },
  completed: { label: "Completed", color: "bg-green-500/15 text-green-400", icon: Check },
};

export default function ESignPage() {
  const { data, mutate } = useSWR<{ documents: ESignDoc[] }>("/esign/list", swrFetcher, { refreshInterval: 10000 });
  const docs = data?.documents || [];

  const [showCreate, setShowCreate] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);

  // Auto-send completion emails for pending docs
  useEffect(() => {
    const pending = docs.filter(d => d.completionEmailPending && !d.completionEmailSent);
    if (pending.length === 0) return;

    (async () => {
      const token = await getFreshGmailToken();
      if (!token) return;
      for (const doc of pending) {
        apiPost(`/esign/${doc.id}/send-completion`, { gmailToken: token })
          .then(() => {
            toast.success(`Signed document "${doc.originalName}" emailed to both parties`);
            mutate();
          })
          .catch(() => {});
      }
    })();
  }, [docs, mutate]);

  // Founder signing
  const [signingDocId, setSigningDocId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [useTypedSig, setUseTypedSig] = useState(false);
  const [sigFont, setSigFont] = useState<"Dancing Script" | "Great Vibes" | "Marck Script">("Dancing Script");

  // Canvas drawing
  const startDraw = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    setIsDrawing(true);
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  }, []);

  const draw = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  }, [isDrawing]);

  const stopDraw = useCallback(() => setIsDrawing(false), []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  // Generate DocuSign-style auto signature on canvas
  const renderAutoSignature = useCallback((fontFamily?: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const font = fontFamily || sigFont;
    const w = canvas.width;
    const h = canvas.height;
    const name = "Deniz Saglam";
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

    ctx.clearRect(0, 0, w, h);

    // Cursive signature name
    ctx.font = `600 38px '${font}', cursive`;
    ctx.fillStyle = "#1a56db";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, w / 2, h * 0.35);

    // Signature line
    const lineWidth = Math.min(280, w * 0.65);
    const lineY = h * 0.58;
    ctx.beginPath();
    ctx.moveTo((w - lineWidth) / 2, lineY);
    ctx.lineTo((w + lineWidth) / 2, lineY);
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Print name below line
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.fillStyle = "#9ca3af";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(name, w / 2, lineY + 6);

    // Date + time
    ctx.font = "11px 'DM Sans', sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText(`${dateStr} | ${timeStr}`, w / 2, lineY + 22);

    setUseTypedSig(true);
  }, [sigFont]);

  useEffect(() => {
    if (useTypedSig) renderAutoSignature();
  }, [sigFont, useTypedSig, renderAutoSignature]);

  const handleCreate = useCallback(async () => {
    if (!pdfFile || !signerName || !signerEmail) return;
    setCreating(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];

        // Get founder signature from canvas
        let founderSignature: string | null = null;
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext("2d");
          if (ctx) {
            const imageData = ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height);
            const hasDrawing = imageData.data.some((v, i) => i % 4 === 3 && v > 0);
            if (hasDrawing) {
              founderSignature = canvasRef.current.toDataURL("image/png");
            }
          }
        }

        const gmailToken = await getFreshGmailToken();
        const resp = await apiPost("/esign/create", {
          fileBase64: base64,
          fileName: pdfFile.name,
          signerName,
          signerEmail,
          founderSignature,
          gmailToken,
        }) as { document: ESignDoc; emailSent: boolean };

        if (resp.emailSent) {
          toast.success(`Signing invitation sent to ${signerEmail}!`);
        } else {
          toast.success("Document created! Signing link copied to clipboard.");
        }
        setShowCreate(false);
        setSignerName("");
        setSignerEmail("");
        setPdfFile(null);
        setSigningDocId(null);
        mutate();

        // Copy signing link
        const link = `${window.location.origin}${resp.document.signingUrl}`;
        navigator.clipboard.writeText(link).then(() => {
          toast.info("Signing link copied to clipboard!");
        });
      };
      reader.readAsDataURL(pdfFile);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create document");
    } finally {
      setCreating(false);
    }
  }, [pdfFile, signerName, signerEmail, mutate]);

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <FileSignature className="h-5 w-5 text-[#F97316]" /> E-Sign
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Send documents for electronic signature — no third-party tools needed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => mutate()} className="gap-1">
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button size="sm" className="bg-[#F97316] hover:bg-[#ea6c10] text-white gap-1" onClick={() => setShowCreate(true)}>
            <FileSignature className="h-4 w-4" /> New Document
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <FileSignature className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-lg font-semibold">{docs.length}</p>
              <p className="text-sm text-muted-foreground">Total</p>
            </div>
          </CardContent>
        </Card>
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <Clock className="h-5 w-5 text-yellow-400" />
            <div>
              <p className="text-lg font-semibold">{docs.filter(d => d.status === "awaiting_signer").length}</p>
              <p className="text-sm text-muted-foreground">Pending</p>
            </div>
          </CardContent>
        </Card>
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <Check className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-semibold">{docs.filter(d => d.status === "completed").length}</p>
              <p className="text-sm text-muted-foreground">Completed</p>
            </div>
          </CardContent>
        </Card>
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <Send className="h-5 w-5 text-blue-400" />
            <div>
              <p className="text-lg font-semibold">{docs.filter(d => d.status !== "completed").length}</p>
              <p className="text-sm text-muted-foreground">In Progress</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Document List */}
      <div className="space-y-3">
        {docs.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <FileSignature className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-lg">No documents yet</p>
            <p className="text-sm mt-1">Click "New Document" to send your first e-sign request</p>
          </div>
        ) : (
          docs.map(doc => {
            const config = STATUS_CONFIG[doc.status];
            const StatusIcon = config.icon;
            const signingLink = `${window.location.origin}${doc.signingUrl}`;

            return (
              <div
                key={doc.id}
                className="rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.06)" }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium truncate">{doc.originalName}</p>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${config.color}`}>
                      <StatusIcon className="inline h-3 w-3 mr-1" />
                      {config.label}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-muted-foreground">
                    <span>To: {doc.signerName}</span>
                    <span className="hidden sm:inline">({doc.signerEmail})</span>
                    <span>Created: {new Date(doc.createdAt).toLocaleDateString()}</span>
                    {doc.completedAt && <span className="text-green-400">Signed: {new Date(doc.completedAt).toLocaleDateString()}</span>}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* View PDF */}
                  <Button size="sm" variant="ghost" onClick={() => window.open(`/api/esign/pdf/${doc.id}`, "_blank")} title="View PDF">
                    <Eye className="h-4 w-4" />
                  </Button>

                  {/* Copy signing link */}
                  {doc.status !== "completed" && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      navigator.clipboard.writeText(signingLink);
                      toast.success("Signing link copied!");
                    }} title="Copy signing link">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  )}

                  {/* Send/Resend invite */}
                  {doc.status === "awaiting_signer" && (
                    <Button size="sm" variant="outline" className="gap-1 text-blue-400 border-blue-400/30" onClick={async () => {
                      const token = await getFreshGmailToken();
                      if (!token) { toast.error("Gmail access required"); return; }
                      try {
                        await apiPost(`/esign/${doc.id}/resend-invite`, { gmailToken: token });
                        toast.success(`Invitation sent to ${doc.signerEmail}`);
                        mutate();
                      } catch { toast.error("Failed to send invitation"); }
                    }}>
                      <Send className="h-3.5 w-3.5" /> {doc.inviteEmailSent ? "Resend" : "Send Invite"}
                    </Button>
                  )}

                  {/* Founder sign (if needed) */}
                  {doc.status === "awaiting_founder" && (
                    <Button size="sm" variant="outline" className="text-[#F97316] border-[#F97316]/30" onClick={() => setSigningDocId(doc.id)}>
                      Sign Now
                    </Button>
                  )}

                  {/* Send completion email */}
                  {doc.status === "completed" && !doc.completionEmailSent && (
                    <Button size="sm" variant="outline" className="gap-1 text-blue-400 border-blue-400/30" onClick={async () => {
                      const token = await getFreshGmailToken();
                      if (!token) { toast.error("Gmail access required — please re-login"); return; }
                      try {
                        const resp = await apiPost(`/esign/${doc.id}/send-completion`, { gmailToken: token }) as { sent: number; total: number };
                        toast.success(`Signed document emailed to ${resp.sent}/${resp.total} parties`);
                        mutate();
                      } catch { toast.error("Failed to send email"); }
                    }}>
                      <Mail className="h-3.5 w-3.5" /> Email Both
                    </Button>
                  )}
                  {doc.completionEmailSent && (
                    <Badge variant="outline" className="text-xs text-blue-400 border-blue-400/30">
                      <Mail className="h-3 w-3 mr-1" /> Emailed
                    </Badge>
                  )}

                  {/* Move to DD */}
                  {doc.status === "completed" && !doc.movedToDueDiligence && (
                    <Button size="sm" variant="ghost" onClick={async () => {
                      await apiPost(`/esign/${doc.id}/move-to-dd`, {});
                      toast.success("Moved to Due Diligence");
                      mutate();
                    }} title="Move to Due Diligence">
                      <FolderCheck className="h-4 w-4 text-green-400" />
                    </Button>
                  )}
                  {doc.movedToDueDiligence && (
                    <Badge variant="outline" className="text-xs text-green-400 border-green-400/30">In DD</Badge>
                  )}

                  {/* Delete */}
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-red-400" onClick={async () => {
                    if (!confirm(`Delete "${doc.originalName}"?`)) return;
                    await apiDelete(`/esign/${doc.id}`);
                    toast.success("Deleted");
                    mutate();
                  }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create Document Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCreate(false)} />
          <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border p-6 space-y-4" style={{ background: "#0f1018", borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2"><FileSignature className="h-5 w-5 text-[#F97316]" /> New E-Sign Document</h2>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
            </div>

            {/* Step 1: Upload PDF */}
            <div>
              <label className="text-sm font-medium text-muted-foreground">PDF Document *</label>
              <div className="mt-1 rounded-lg border-2 border-dashed p-6 text-center" style={{ borderColor: pdfFile ? "rgba(249,115,22,0.3)" : "rgba(255,255,255,0.1)" }}>
                {pdfFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileSignature className="h-5 w-5 text-[#F97316]" />
                    <span className="text-sm">{pdfFile.name}</span>
                    <button onClick={() => setPdfFile(null)} className="text-red-400"><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <>
                    <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground mb-2">Upload PDF to sign</p>
                    <input type="file" accept=".pdf" className="hidden" id="esign-pdf" onChange={e => setPdfFile(e.target.files?.[0] || null)} />
                    <Button variant="outline" size="sm" onClick={() => document.getElementById("esign-pdf")?.click()}>Choose PDF</Button>
                  </>
                )}
              </div>
            </div>

            {/* Step 2: Signer info */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Signer Full Name *</label>
                <Input value={signerName} onChange={e => setSignerName(e.target.value)} placeholder="John Smith" />
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Signer Email *</label>
                <Input value={signerEmail} onChange={e => setSignerEmail(e.target.value)} placeholder="john@company.com" />
              </div>
            </div>

            {/* Step 3: Founder signature */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-muted-foreground">Your Signature (Founder)</label>
                <div className="flex gap-2">
                  <button
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${!useTypedSig ? "bg-[#F97316] text-white" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => { setUseTypedSig(false); clearCanvas(); }}
                  >✍️ Draw</button>
                  <button
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${useTypedSig ? "bg-[#F97316] text-white" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => renderAutoSignature()}
                  >Aa Auto</button>
                  <button className="px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-red-400" onClick={() => { clearCanvas(); setUseTypedSig(false); }}>Clear</button>
                </div>
              </div>

              {/* Font selector (only in auto mode) */}
              {useTypedSig && (
                <div className="flex gap-2 mb-2">
                  {(["Dancing Script", "Great Vibes", "Marck Script"] as const).map(font => (
                    <button
                      key={font}
                      className={`flex-1 py-2 rounded-lg text-center transition-all ${sigFont === font ? "ring-2 ring-[#F97316]" : ""}`}
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                      onClick={() => { setSigFont(font); renderAutoSignature(font); }}
                    >
                      <span style={{ fontFamily: `'${font}', cursive`, fontSize: "20px", color: sigFont === font ? "#1a56db" : "#9ca3af" }}>
                        Deniz
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <canvas
                ref={canvasRef}
                width={440}
                height={140}
                className="w-full rounded-lg"
                style={{
                  background: useTypedSig ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  cursor: useTypedSig ? "default" : "crosshair",
                }}
                onMouseDown={useTypedSig ? undefined : startDraw}
                onMouseMove={useTypedSig ? undefined : draw}
                onMouseUp={useTypedSig ? undefined : stopDraw}
                onMouseLeave={useTypedSig ? undefined : stopDraw}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {useTypedSig ? "Select a signature style above" : "Draw your signature with mouse or trackpad"}
              </p>
            </div>

            {/* Submit */}
            <Button
              className="w-full bg-[#F97316] hover:bg-[#ea6c10] text-white"
              disabled={!pdfFile || !signerName || !signerEmail || creating}
              onClick={handleCreate}
            >
              {creating ? "Creating..." : "Create & Generate Signing Link"}
            </Button>
          </div>
        </div>
      )}

      {/* Founder Signing Modal */}
      {signingDocId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSigningDocId(null)} />
          <div className="relative w-full max-w-md rounded-xl border p-6 space-y-4" style={{ background: "#0f1018", borderColor: "rgba(255,255,255,0.08)" }}>
            <h2 className="text-lg font-semibold">Sign as Founder</h2>
            <canvas
              ref={canvasRef}
              width={380}
              height={120}
              className="w-full rounded-lg cursor-crosshair"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)" }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
            />
            <div className="flex gap-2">
              <Button className="flex-1 bg-[#F97316] hover:bg-[#ea6c10] text-white" onClick={async () => {
                if (!canvasRef.current) return;
                const sig = canvasRef.current.toDataURL("image/png");
                await apiPost(`/esign/founder-sign/${signingDocId}`, { signature: sig });
                toast.success("Founder signature added!");
                setSigningDocId(null);
                mutate();
              }}>
                Submit Signature
              </Button>
              <Button variant="outline" onClick={() => { clearCanvas(); }}>Clear</Button>
              <Button variant="ghost" onClick={() => setSigningDocId(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
