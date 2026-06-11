"use client";

import { useRef, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  UploadCloud,
  Loader2,
  FileCheck2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiBaseUrl } from "@/lib/api";

export interface CertificateStatus {
  configured: boolean;
  /** ISO string da validade (notAfter) ou null. */
  validoAte: string | null;
  subjectCN?: string | null;
  /** false quando não foi possível confirmar o CNPJ do certificado. */
  cnpjMatched?: boolean;
}

interface Props {
  userEmail: string | null | undefined;
  /** true quando a empresa já foi salva (CNPJ disponível para a trava). */
  configExists: boolean;
  /** UF do emissor (necessária para emitir via SEFAZ direto). */
  uf?: string | null;
  status: CertificateStatus | null;
  onUploaded: (status: CertificateStatus) => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export function CertificateUploadCard({
  userEmail,
  configExists,
  uf,
  status,
  onUploaded,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [senha, setSenha] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    setError(null);
    setOkMsg(null);

    if (!configExists) {
      setError(
        "Salve a configuração da empresa (botão abaixo) antes de enviar o certificado.",
      );
      return;
    }
    if (!file) {
      setError("Selecione o arquivo .pfx do certificado.");
      return;
    }
    if (!senha) {
      setError("Informe a senha do certificado.");
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("certificate", file, file.name);
      formData.append("senha", senha);

      const res = await fetch(`${getApiBaseUrl()}/fiscal/config/certificate`, {
        method: "POST",
        headers: { email: userEmail || "" },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || "Falha ao enviar o certificado.");
      }

      const newStatus: CertificateStatus = {
        configured: true,
        validoAte: data?.validoAte ?? null,
        subjectCN: data?.subjectCN ?? null,
        cnpjMatched: data?.cnpjMatched ?? false,
      };
      onUploaded(newStatus);

      setOkMsg(
        `Certificado enviado. Válido até ${formatDate(newStatus.validoAte)}.`,
      );
      // Limpa a senha da memória do componente após o sucesso.
      setSenha("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao enviar o certificado.");
    } finally {
      setLoading(false);
    }
  };

  const expDays = daysUntil(status?.validoAte ?? null);
  const expiringSoon = expDays !== null && expDays >= 0 && expDays <= 30;
  const expired = expDays !== null && expDays < 0;

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Certificado digital A1 (.pfx)
          </p>
          <p className="text-xs text-muted-foreground">
            Necessário para assinar e transmitir a NF-e direto à SEFAZ. O arquivo
            fica criptografado no servidor — a senha nunca é armazenada em texto
            puro nem retorna ao navegador.
          </p>
        </div>
      </div>

      {/* Status atual do certificado */}
      {status?.configured ? (
        <div
          className={
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs " +
            (expired
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : expiringSoon
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600")
          }
        >
          <FileCheck2 className="h-4 w-4 shrink-0" />
          <span>
            {expired
              ? `Certificado vencido em ${formatDate(status.validoAte)}. Envie um novo A1.`
              : `Certificado ativo · válido até ${formatDate(status.validoAte)}` +
                (expiringSoon ? ` (vence em ${expDays} dia(s))` : "")}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>Nenhum certificado enviado ainda.</span>
        </div>
      )}

      {status?.configured && status.subjectCN && (
        <p className="text-xs text-muted-foreground">
          Titular: <span className="font-medium">{status.subjectCN}</span>
        </p>
      )}

      {status?.configured && status.cnpjMatched === false && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Não foi possível confirmar o CNPJ do certificado pelo CN. Confirme que
            ele pertence ao CNPJ do emissor antes de emitir.
          </span>
        </div>
      )}

      {!uf && (
        <p className="text-xs text-amber-700">
          Defina a <span className="font-medium">UF</span> no passo “Endereço
          fiscal” — ela é obrigatória para emitir direto à SEFAZ.
        </p>
      )}

      {!configExists && (
        <p className="text-xs text-amber-700">
          Salve a configuração da empresa (botão “Salvar configuração” abaixo)
          antes de enviar o certificado.
        </p>
      )}

      {/* Formulário de upload */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Arquivo do certificado (.pfx)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pfx,.p12"
            onChange={(e) => {
              setError(null);
              setOkMsg(null);
              setFile(e.target.files?.[0] ?? null);
            }}
            className="block w-full cursor-pointer rounded-md border border-border/60 bg-background text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/70"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Senha do certificado
          </label>
          <Input
            type="password"
            value={senha}
            onChange={(e) => {
              setError(null);
              setOkMsg(null);
              setSenha(e.target.value);
            }}
            placeholder="Senha do .pfx"
            autoComplete="off"
          />
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {okMsg && <p className="text-xs text-emerald-600">{okMsg}</p>}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading || !file || !senha || !configExists}
        onClick={handleUpload}
        className="gap-2"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <UploadCloud className="h-4 w-4" />
        )}
        {status?.configured ? "Substituir certificado" : "Enviar certificado"}
      </Button>
    </div>
  );
}
