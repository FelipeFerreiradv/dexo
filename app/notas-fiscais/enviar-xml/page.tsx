"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Send, Download, FileText, Mail, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getApiBaseUrl, authHeaders } from "@/lib/api";
import { NfeStatusBadge } from "../components/nfe-status-badge";
import { NfeSendEmailDialog } from "../components/nfe-send-email-dialog";

interface NfeListItem {
  id: string;
  serie: number;
  numero: number;
  chaveAcesso: string | null;
  destinatarioNome: string;
  status: string;
  dataEmissao: string | null;
  createdAt: string;
  hasXml: boolean;
  hasDanfe: boolean;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const FISCAL_MODULE_ENABLED =
  process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED === "true";

export default function EnviarXmlPage() {
  const { data: session, status: authStatus } = useSession();
  const router = useRouter();

  const [notas, setNotas] = useState<NfeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [emailTarget, setEmailTarget] = useState<{
    id: string;
    numero: number;
  } | null>(null);
  const [isEmailOpen, setIsEmailOpen] = useState(false);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    [],
  );

  const fetchNotas = useCallback(async () => {
    if (!session?.user?.email) return;
    try {
      setIsLoading(true);
      const params = new URLSearchParams({
        page: "1",
        limit: "50",
        status: "AUTHORIZED",
      });
      const response = await fetch(`${getApiBaseUrl()}/fiscal/nfe?${params}`, {
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
      });
      if (!response.ok) throw new Error("Erro ao buscar notas");
      const data = await response.json();
      setNotas(data.notas ?? []);
    } catch {
      showToast("Erro ao carregar notas autorizadas", "error");
    } finally {
      setIsLoading(false);
    }
  }, [session?.user?.email, showToast]);

  useEffect(() => {
    if (authStatus === "authenticated") {
      fetchNotas();
    }
  }, [authStatus, fetchNotas]);

  // Redirecionamento em EFEITO, não no render — mesmo motivo do
  // `app-header.tsx`: esta página também é renderizada no servidor, e ali
  // `router.push` toca `location`, que não existe no Node. Hoje o ramo não
  // dispara (a flag está ligada em produção), o que torna isto uma mina
  // dormente: bastaria desligar o módulo fiscal para a página passar a
  // estourar `ReferenceError` a cada requisição.
  useEffect(() => {
    if (!FISCAL_MODULE_ENABLED) {
      router.push("/");
    }
  }, [router]);

  if (!FISCAL_MODULE_ENABLED) {
    return null;
  }

  if (authStatus === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const handleDownload = async (nfeId: string, type: "xml" | "danfe") => {
    if (!session?.user?.email) return;
    // fetch + blob (a ponte injeta o Bearer); funciona no modo strict e não
    // expõe credencial na URL.
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/fiscal/nfe/${nfeId}/${type}`,
        {
          headers: authHeaders(session),
        },
      );
      if (!res.ok) return;
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `nfe-${nfeId}.${type === "danfe" ? "pdf" : "xml"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch {
      // silencioso
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Notas Fiscais"
        title="Enviar XML"
        subtitle="Baixe ou envie por e-mail o XML e DANFE das notas autorizadas"
      />

      {/* List */}
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <CardTitle>Notas Autorizadas</CardTitle>
          <CardDescription>
            Notas fiscais disponiveis para download e envio por e-mail
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="h-12 bg-muted/30 rounded animate-pulse"
                />
              ))}
            </div>
          ) : notas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Send className="size-12 text-muted-foreground/40 mb-4" />
              <p className="text-muted-foreground">
                Nenhuma nota autorizada encontrada
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                As notas autorizadas aparecerao aqui para envio
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Numero</TableHead>
                  <TableHead>Serie</TableHead>
                  <TableHead>Destinatario</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="w-[180px]">Acoes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {notas.map((nota) => (
                  <TableRow key={nota.id}>
                    <TableCell className="font-mono text-sm font-medium">
                      {nota.numero || "—"}
                    </TableCell>
                    <TableCell className="text-sm">{nota.serie}</TableCell>
                    <TableCell className="text-sm max-w-[180px] truncate">
                      {nota.destinatarioNome || "—"}
                    </TableCell>
                    <TableCell>
                      <NfeStatusBadge status={nota.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {nota.dataEmissao
                        ? new Date(nota.dataEmissao).toLocaleDateString("pt-BR")
                        : new Date(nota.createdAt).toLocaleDateString("pt-BR")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {nota.hasXml && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => handleDownload(nota.id, "xml")}
                          >
                            <FileText className="size-4" />
                          </Button>
                        )}
                        {nota.hasDanfe && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => handleDownload(nota.id, "danfe")}
                          >
                            <Download className="size-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          onClick={() => {
                            setEmailTarget({
                              id: nota.id,
                              numero: nota.numero,
                            });
                            setIsEmailOpen(true);
                          }}
                        >
                          <Mail className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Email Dialog */}
      <NfeSendEmailDialog
        nfeId={emailTarget?.id ?? null}
        nfeNumero={emailTarget?.numero ?? null}
        open={isEmailOpen}
        onOpenChange={setIsEmailOpen}
        onSent={() => showToast("E-mail enviado com sucesso", "success")}
      />

      {/* Toasts */}
      <ToastViewport>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg z-[100] ${
              toast.type === "success" ? "bg-green-500" : "bg-red-500"
            } text-white`}
          >
            {toast.message}
          </div>
        ))}
      </ToastViewport>
    </div>
  );
}
