import { useState, useEffect } from "react";
import useSWR from "swr";
import { swrFetcher, apiPost, apiDelete } from "@/lib/api";
import { getFreshGmailToken } from "@/lib/firebase";
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
  Eye,
  RefreshCw,
  Mail,
} from "lucide-react";
import { toast } from "sonner";

interface VekaletDoc {
  id: string;
  fileName: string;
  originalName: string;
  signerName: string;
  signerEmail: string;
  signerPhone: string;
  tcKimlikNo: string;
  smsSent?: boolean;
  status: "awaiting_signer" | "completed";
  signerSigned: boolean;
  signingToken: string;
  signingUrl: string;
  createdAt: string;
  completedAt: string | null;
  completionEmailPending?: boolean;
  completionEmailSent?: boolean;
  inviteEmailSent?: boolean;
}

const STATUS_CONFIG = {
  awaiting_signer: { label: "İmza Bekliyor", color: "bg-blue-500/15 text-blue-400", icon: Clock },
  completed: { label: "Tamamlandı", color: "bg-green-500/15 text-green-400", icon: Check },
};

export default function ESignPage() {
  const { data, mutate } = useSWR<{ documents: VekaletDoc[] }>("/esign/list", swrFetcher, { refreshInterval: 10000 });
  const docs = data?.documents || [];

  const [showCreate, setShowCreate] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [signerPhone, setSignerPhone] = useState("");
  const [tcKimlikNo, setTcKimlikNo] = useState("");
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
            toast.success(`İmzalı "${doc.originalName}" belgesi taraflara e-posta ile gönderildi`);
            mutate();
          })
          .catch(() => {});
      }
    })();
  }, [docs, mutate]);

  const handleCreate = async () => {
    if (!pdfFile || !signerName || (!signerEmail && !signerPhone)) return;
    setCreating(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];

        const gmailToken = await getFreshGmailToken();
        const resp = await apiPost("/esign/create", {
          fileBase64: base64,
          fileName: pdfFile.name,
          signerName,
          signerEmail,
          signerPhone,
          tcKimlikNo,
          gmailToken,
        }) as { document: VekaletDoc; emailSent: boolean; smsSent: boolean };

        if (resp.smsSent) {
          toast.success(`İmza linki SMS ile ${signerPhone} numarasına gönderildi!`);
        } else if (resp.emailSent) {
          toast.success(`İmza daveti ${signerEmail} adresine gönderildi!`);
        } else {
          toast.success("Vekalet oluşturuldu! İmza linki panoya kopyalandı.");
        }
        setShowCreate(false);
        setSignerName("");
        setSignerEmail("");
        setSignerPhone("");
        setTcKimlikNo("");
        setPdfFile(null);
        mutate();

        const link = `${window.location.origin}${resp.document.signingUrl}`;
        navigator.clipboard.writeText(link).then(() => {
          toast.info("İmza linki panoya kopyalandı!");
        });
      };
      reader.readAsDataURL(pdfFile);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Belge oluşturulamadı");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <FileSignature className="h-5 w-5 text-[#1e3a5f]" /> Seçim Vekaleti İmza Toplama
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Seçim vekaleti belgelerini elektronik olarak imzalatın.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => mutate()} className="gap-1">
            <RefreshCw className="h-4 w-4" /> Yenile
          </Button>
          <Button size="sm" className="bg-[#1e3a5f] hover:bg-[#162d4a] text-white gap-1" onClick={() => setShowCreate(true)}>
            <FileSignature className="h-4 w-4" /> Yeni Vekalet
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
              <p className="text-sm text-muted-foreground">Toplam</p>
            </div>
          </CardContent>
        </Card>
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <Clock className="h-5 w-5 text-yellow-400" />
            <div>
              <p className="text-lg font-semibold">{docs.filter(d => d.status === "awaiting_signer").length}</p>
              <p className="text-sm text-muted-foreground">Bekleyen</p>
            </div>
          </CardContent>
        </Card>
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <Check className="h-5 w-5 text-green-400" />
            <div>
              <p className="text-lg font-semibold">{docs.filter(d => d.status === "completed").length}</p>
              <p className="text-sm text-muted-foreground">Tamamlanan</p>
            </div>
          </CardContent>
        </Card>
        <Card style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <CardContent className="p-4 flex items-center gap-3">
            <Send className="h-5 w-5 text-blue-400" />
            <div>
              <p className="text-lg font-semibold">{docs.filter(d => d.status !== "completed").length}</p>
              <p className="text-sm text-muted-foreground">Devam Eden</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Document List */}
      <div className="space-y-3">
        {docs.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <FileSignature className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-lg">Henüz vekalet yok</p>
            <p className="text-sm mt-1">"Yeni Vekalet" butonuna tıklayarak ilk imza talebinizi oluşturun</p>
          </div>
        ) : (
          docs.map(doc => {
            const config = STATUS_CONFIG[doc.status] || STATUS_CONFIG.awaiting_signer;
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
                    <span>Kişi: {doc.signerName}</span>
                    {doc.signerPhone && <span>{doc.signerPhone}</span>}
                    {doc.signerEmail && <span className="hidden sm:inline">({doc.signerEmail})</span>}
                    {doc.tcKimlikNo && <span>TC: {doc.tcKimlikNo}</span>}
                    <span>Oluşturulma: {new Date(doc.createdAt).toLocaleDateString("tr-TR")}</span>
                    {doc.completedAt && <span className="text-green-400">İmzalandı: {new Date(doc.completedAt).toLocaleDateString("tr-TR")}</span>}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* PDF Görüntüle */}
                  <Button size="sm" variant="ghost" onClick={() => window.open(`/api/esign/pdf/${doc.id}`, "_blank")} title="PDF Görüntüle">
                    <Eye className="h-4 w-4" />
                  </Button>

                  {/* İmza linkini kopyala */}
                  {doc.status !== "completed" && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      navigator.clipboard.writeText(signingLink);
                      toast.success("İmza linki kopyalandı!");
                    }} title="İmza linkini kopyala">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  )}

                  {/* Davet gönder / tekrar gönder */}
                  {doc.status === "awaiting_signer" && (
                    <Button size="sm" variant="outline" className="gap-1 text-blue-400 border-blue-400/30" onClick={async () => {
                      const token = await getFreshGmailToken();
                      if (!token) { toast.error("Gmail erişimi gerekli"); return; }
                      try {
                        await apiPost(`/esign/${doc.id}/resend-invite`, { gmailToken: token });
                        toast.success(`Davet ${doc.signerEmail} adresine gönderildi`);
                        mutate();
                      } catch { toast.error("Davet gönderilemedi"); }
                    }}>
                      <Send className="h-3.5 w-3.5" /> {doc.inviteEmailSent ? "Tekrar Gönder" : "Davet Gönder"}
                    </Button>
                  )}

                  {/* Tamamlama e-postası gönder */}
                  {doc.status === "completed" && !doc.completionEmailSent && (
                    <Button size="sm" variant="outline" className="gap-1 text-blue-400 border-blue-400/30" onClick={async () => {
                      const token = await getFreshGmailToken();
                      if (!token) { toast.error("Gmail erişimi gerekli — lütfen tekrar giriş yapın"); return; }
                      try {
                        const resp = await apiPost(`/esign/${doc.id}/send-completion`, { gmailToken: token }) as { sent: number; total: number };
                        toast.success(`İmzalı belge ${resp.sent}/${resp.total} tarafa e-posta ile gönderildi`);
                        mutate();
                      } catch { toast.error("E-posta gönderilemedi"); }
                    }}>
                      <Mail className="h-3.5 w-3.5" /> E-posta Gönder
                    </Button>
                  )}
                  {doc.completionEmailSent && (
                    <Badge variant="outline" className="text-xs text-blue-400 border-blue-400/30">
                      <Mail className="h-3 w-3 mr-1" /> Gönderildi
                    </Badge>
                  )}

                  {/* Sil */}
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-red-400" onClick={async () => {
                    if (!confirm(`"${doc.originalName}" silinsin mi?`)) return;
                    await apiDelete(`/esign/${doc.id}`);
                    toast.success("Silindi");
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

      {/* Vekalet Oluşturma Modalı */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCreate(false)} />
          <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border p-6 space-y-4" style={{ background: "#0f1018", borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2"><FileSignature className="h-5 w-5 text-[#1e3a5f]" /> Yeni Vekalet Belgesi</h2>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
            </div>

            {/* Adım 1: PDF Yükle */}
            <div>
              <label className="text-sm font-medium text-muted-foreground">Vekalet Belgesi (PDF) *</label>
              <div className="mt-1 rounded-lg border-2 border-dashed p-6 text-center" style={{ borderColor: pdfFile ? "rgba(30,58,95,0.3)" : "rgba(255,255,255,0.1)" }}>
                {pdfFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileSignature className="h-5 w-5 text-[#1e3a5f]" />
                    <span className="text-sm">{pdfFile.name}</span>
                    <button onClick={() => setPdfFile(null)} className="text-red-400"><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <>
                    <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground mb-2">İmzalanacak vekalet PDF'ini yükleyin</p>
                    <input type="file" accept=".pdf" className="hidden" id="esign-pdf" onChange={e => setPdfFile(e.target.files?.[0] || null)} />
                    <Button variant="outline" size="sm" onClick={() => document.getElementById("esign-pdf")?.click()}>PDF Seç</Button>
                  </>
                )}
              </div>
            </div>

            {/* Adım 2: İmzacı bilgileri */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Adı Soyadı *</label>
                <Input value={signerName} onChange={e => setSignerName(e.target.value)} placeholder="Ahmet Yılmaz" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Telefon Numarası *</label>
                  <Input value={signerPhone} onChange={e => setSignerPhone(e.target.value)} placeholder="+90 5XX XXX XX XX" />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">E-posta Adresi</label>
                  <Input value={signerEmail} onChange={e => setSignerEmail(e.target.value)} placeholder="ahmet@ornek.com" />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">TC Kimlik No</label>
                <Input value={tcKimlikNo} onChange={e => setTcKimlikNo(e.target.value)} placeholder="12345678901" maxLength={11} />
              </div>
            </div>

            {/* Gönder */}
            <Button
              className="w-full bg-[#1e3a5f] hover:bg-[#162d4a] text-white"
              disabled={!pdfFile || !signerName || (!signerEmail && !signerPhone) || creating}
              onClick={handleCreate}
            >
              {creating ? "Oluşturuluyor..." : "Oluştur ve İmza Linki Gönder"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
