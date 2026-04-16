"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  Send,
  Download,
  FileText,
  Mail,
  CheckCircle2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { getApiBaseUrl } from "@/lib/api";
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
      const response = await fetch(
        `${getApiBaseUrl()}/fiscal/nfe?${params}`,
        {
          headers: {
            "Content-Type": "application/json",
            email: session.user.email,
          },
        },
      );
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

  if (!FISCAL_MODULE_ENABLED) {
    router.push("/");
    return null;
  }

  if (authStatus === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const handleDownload = (nfeId: string, type: "xml" | "danfe") => {
    if (!session?.user?.email) return;
    window.open(
      `${getApiBaseUrl()}/fiscal/nfe/${nfeId}/${type}?email=${encodeURIComponent(session.user.email)}`,
      "_blank",
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Notas Fiscais
        </p>
        <h1 className="text-2xl font-bold tracking-tight">Enviar XML</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Baixe ou envie por e-mail o XML e DANFE das notas autorizadas
        </p>
      </div>

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
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg z-50 ${
            toast.type === "success" ? "bg-green-500" : "bg-red-500"
          } text-white`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
