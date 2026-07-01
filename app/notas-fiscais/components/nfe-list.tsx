"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  FileSignature,
  XCircle,
  Copy,
  CheckCircle2,
  Ban,
  Mail,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SectionHeading } from "@/components/section-heading";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getApiBaseUrl, authHeaders } from "@/lib/api";
import { NfeStatusBadge } from "./nfe-status-badge";
import { NfeDetailSheet } from "./nfe-detail-sheet";
import { NfeCancelDialog } from "./nfe-cancel-dialog";
import { NfeSendEmailDialog } from "./nfe-send-email-dialog";

// Feature flag: botão "Tentar novamente" em notas rejeitadas reaproveitáveis.
// Com a flag off, nenhum botão novo aparece — comportamento atual da lista.
const REEMISSAO_REJEITADA_ENABLED =
  process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED === "true";

interface NfeListItem {
  id: string;
  orderId: string | null;
  ambiente: string;
  serie: number;
  numero: number;
  chaveAcesso: string | null;
  tipoOperacao: string;
  finalidade: string;
  naturezaOperacao: string;
  destinatarioNome: string;
  destinatarioCpfCnpj: string;
  totalNota: number;
  status: string;
  protocoloAutorizacao: string | null;
  dataEmissao: string | null;
  dataAutorizacao: string | null;
  createdAt: string;
  hasXml: boolean;
  hasDanfe: boolean;
  reaproveitavel?: boolean;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface NfeStats {
  total: number;
  autorizadas: number;
  rejeitadas: number;
  canceladas: number;
  valorTotal: number;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const MESES_LABELS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

export function NfeList() {
  const { data: session, status: authStatus } = useSession();
  const router = useRouter();
  const [notas, setNotas] = useState<NfeListItem[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  const [stats, setStats] = useState<NfeStats>({
    total: 0,
    autorizadas: 0,
    rejeitadas: 0,
    canceladas: 0,
    valorTotal: 0,
  });
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [isLoading, setIsLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedNfeId, setSelectedNfeId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{
    id: string;
    numero: number;
  } | null>(null);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [emailTarget, setEmailTarget] = useState<{
    id: string;
    numero: number;
  } | null>(null);
  const [isEmailOpen, setIsEmailOpen] = useState(false);
  // Relatório mensal (XML): default = mês corrente
  const [reportMes, setReportMes] = useState(() =>
    String(new Date().getMonth() + 1),
  );
  const [reportAno, setReportAno] = useState(() =>
    String(new Date().getFullYear()),
  );
  const anosRelatorio = (() => {
    const atual = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => String(atual - i));
  })();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Reset page on filter change
  useEffect(() => {
    setPagination((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  }, [debouncedSearch, statusFilter]);

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
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (debouncedSearch.length >= 2) {
        params.set("search", debouncedSearch);
      }
      if (statusFilter && statusFilter !== "ALL") {
        params.set("status", statusFilter);
      }

      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/fiscal/nfe?${params}`, {
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
      });
      if (!response.ok) throw new Error("Erro ao buscar notas");

      const data = await response.json();
      setNotas(data.notas);
      setPagination({
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: data.totalPages,
      });
    } catch (error) {
      console.error("Erro ao buscar notas:", error);
      showToast("Erro ao carregar notas fiscais", "error");
    } finally {
      setIsLoading(false);
    }
  }, [
    debouncedSearch,
    pagination.limit,
    pagination.page,
    statusFilter,
    session?.user?.email,
    showToast,
  ]);

  const fetchStats = useCallback(async () => {
    if (!session?.user?.email) return;
    try {
      const response = await fetch(`${getApiBaseUrl()}/fiscal/nfe/stats`, {
        headers: {
          "Content-Type": "application/json",
          email: session.user.email,
        },
      });
      if (!response.ok) throw new Error("Erro ao buscar estatisticas");
      const data = await response.json();
      setStats(data.stats);
    } catch (error) {
      console.error("Erro ao buscar estatisticas:", error);
    }
  }, [session?.user?.email]);

  const handleExport = async (format: "xlsx" | "pdf") => {
    if (!session?.user?.email) return;
    try {
      const params = new URLSearchParams({ format });
      if (statusFilter && statusFilter !== "ALL") {
        params.set("status", statusFilter);
      }
      const response = await fetch(
        `${getApiBaseUrl()}/fiscal/nfe/export?${params}`,
        {
          headers: {
            email: session.user.email,
          },
        },
      );
      if (!response.ok) throw new Error("Erro ao exportar");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `notas-fiscais.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Exportacao concluida", "success");
    } catch (error) {
      console.error("Erro ao exportar:", error);
      showToast("Erro ao exportar dados", "error");
    }
  };

  const handleMonthlyReport = async () => {
    if (!session?.user?.email) return;
    try {
      const params = new URLSearchParams({ ano: reportAno, mes: reportMes });
      const response = await fetch(
        `${getApiBaseUrl()}/fiscal/nfe/relatorio-mensal?${params}`,
        {
          headers: {
            email: session.user.email,
          },
        },
      );
      if (!response.ok) throw new Error("Erro ao gerar relatorio");
      // Lê como texto para detectar mês vazio (resumo quantidade="0") e ainda
      // baixar o XML válido vazio.
      const text = await response.text();
      const blob = new Blob([text], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `relatorio-nfe-${reportAno}-${reportMes.padStart(2, "0")}.xml`;
      a.click();
      URL.revokeObjectURL(url);

      const mesLabel =
        MESES_LABELS[Number(reportMes) - 1]?.toLowerCase() ?? reportMes;
      if (text.includes('quantidade="0"')) {
        showToast(
          `Nenhuma nota autorizada em ${mesLabel}/${reportAno}`,
          "error",
        );
      } else {
        showToast("Relatório mensal gerado", "success");
      }
    } catch (error) {
      console.error("Erro ao gerar relatorio mensal:", error);
      showToast("Erro ao gerar relatório mensal", "error");
    }
  };

  const handleViewNfe = (id: string) => {
    setSelectedNfeId(id);
    setIsDetailOpen(true);
  };

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleDownload = async (nfeId: string, type: "xml" | "danfe") => {
    if (!session?.user?.email) return;
    // Baixa via fetch (a ponte de auth injeta o Bearer) + blob, em vez de
    // window.open(?email=). Funciona no modo strict e não expõe credencial na URL.
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
      // silencioso (mesmo comportamento de antes em caso de falha)
    }
  };

  useEffect(() => {
    if (authStatus === "authenticated" && session?.user?.email) {
      fetchStats();
    }
  }, [fetchStats, session, authStatus]);

  useEffect(() => {
    if (authStatus === "authenticated" && session?.user?.email) {
      fetchNotas();
    }
  }, [fetchNotas, session, authStatus]);

  // Prefetch wizard route once the list mounts — navigating to "Emitir NF-e"
  // from any trigger becomes instant (page bundle + RSC already loaded).
  useEffect(() => {
    router.prefetch("/notas-fiscais/nfe");
  }, [router]);

  if (authStatus === "loading") {
    return <NfeListSkeleton />;
  }

  if (authStatus === "unauthenticated") {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">
          Voce precisa estar logado para acessar esta pagina.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total de Notas
            </CardTitle>
            <FileText className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl leading-none tabular-nums [font-family:var(--font-fraunces)]">
              {stats.total}
            </div>
            <p className="text-xs text-muted-foreground">
              Notas emitidas no sistema
            </p>
          </CardContent>
        </Card>

        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Autorizadas</CardTitle>
            <CheckCircle2 className="size-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl leading-none tabular-nums [font-family:var(--font-fraunces)]">
              {stats.autorizadas}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatCurrency(stats.valorTotal)}
            </p>
          </CardContent>
        </Card>

        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rejeitadas</CardTitle>
            <XCircle className="size-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl leading-none tabular-nums [font-family:var(--font-fraunces)]">
              {stats.rejeitadas}
            </div>
            <p className="text-xs text-muted-foreground">Precisam de atencao</p>
          </CardContent>
        </Card>

        <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Canceladas</CardTitle>
            <FileSignature className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl leading-none tabular-nums [font-family:var(--font-fraunces)]">
              {stats.canceladas}
            </div>
            <p className="text-xs text-muted-foreground">Notas canceladas</p>
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por numero, chave, protocolo..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-10 w-full sm:w-[320px] rounded-full border border-border/70 bg-muted/20 pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-10 w-full sm:w-[180px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos</SelectItem>
              <SelectItem value="AUTHORIZED">Autorizadas</SelectItem>
              <SelectItem value="REJECTED">Rejeitadas</SelectItem>
              <SelectItem value="CANCELLED">Canceladas</SelectItem>
              <SelectItem value="SENDING">Enviando</SelectItem>
              <SelectItem value="VALIDATING">Validando</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={reportMes} onValueChange={setReportMes}>
            <SelectTrigger className="h-9 w-[130px]">
              <SelectValue placeholder="Mês" />
            </SelectTrigger>
            <SelectContent>
              {MESES_LABELS.map((label, i) => (
                <SelectItem key={label} value={String(i + 1)}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={reportAno} onValueChange={setReportAno}>
            <SelectTrigger className="h-9 w-[92px]">
              <SelectValue placeholder="Ano" />
            </SelectTrigger>
            <SelectContent>
              {anosRelatorio.map((ano) => (
                <SelectItem key={ano} value={ano}>
                  {ano}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleMonthlyReport}>
            <Download className="size-4 mr-1" />
            Relatório mensal (XML)
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport("xlsx")}
          >
            <Download className="size-4 mr-1" />
            Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleExport("pdf")}
          >
            <Download className="size-4 mr-1" />
            PDF
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <SectionHeading
            eyebrow="Notas Fiscais · Registro"
            title="Notas"
            accent="emitidas"
            description="Todas as NF-e emitidas no sistema"
          />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <NfeListSkeleton />
          ) : notas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="size-12 text-muted-foreground/40 mb-4" />
              <p className="text-muted-foreground">
                Nenhuma nota fiscal encontrada
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                As notas emitidas aparecerao aqui
              </p>
            </div>
          ) : (
            <>
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Numero</TableHead>
                      <TableHead>Serie</TableHead>
                      <TableHead>Destinatario</TableHead>
                      <TableHead>Chave de Acesso</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead className="w-[120px]">Acoes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {notas.map((nota) => (
                      <TableRow key={nota.id}>
                        <TableCell className="font-mono text-sm font-medium">
                          {nota.numero || "—"}
                        </TableCell>
                        <TableCell className="text-sm">{nota.serie}</TableCell>
                        <TableCell className="max-w-[180px]">
                          <div className="truncate text-sm">
                            {nota.destinatarioNome || "—"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {nota.destinatarioCpfCnpj || ""}
                          </div>
                        </TableCell>
                        <TableCell>
                          {nota.chaveAcesso ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  className="font-mono text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                                  onClick={() =>
                                    handleCopyKey(nota.chaveAcesso!)
                                  }
                                >
                                  {nota.chaveAcesso.substring(0, 12)}...
                                  {copiedKey === nota.chaveAcesso ? (
                                    <CheckCircle2 className="size-3 text-green-500" />
                                  ) : (
                                    <Copy className="size-3" />
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs">
                                  {nota.chaveAcesso}
                                </p>
                                <p className="text-xs">Clique para copiar</p>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <NfeStatusBadge status={nota.status} />
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {formatCurrency(nota.totalNota)}
                        </TableCell>
                        <TableCell className="text-sm">
                          {nota.dataEmissao
                            ? new Date(nota.dataEmissao).toLocaleDateString(
                                "pt-BR",
                              )
                            : new Date(nota.createdAt).toLocaleDateString(
                                "pt-BR",
                              )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={() => handleViewNfe(nota.id)}
                            >
                              <Eye className="size-4" />
                            </Button>
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
                            {(nota.status === "AUTHORIZED" ||
                              nota.status === "CANCELLED") && (
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
                            )}
                            {nota.status === "AUTHORIZED" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-destructive hover:text-destructive"
                                onClick={() => {
                                  setCancelTarget({
                                    id: nota.id,
                                    numero: nota.numero,
                                  });
                                  setIsCancelOpen(true);
                                }}
                              >
                                <Ban className="size-4" />
                              </Button>
                            )}
                            {REEMISSAO_REJEITADA_ENABLED &&
                              nota.status === "REJECTED" &&
                              nota.reaproveitavel && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-8"
                                      onClick={() =>
                                        router.push(
                                          `/notas-fiscais/nfe?draft=${nota.id}`,
                                        )
                                      }
                                    >
                                      <RotateCcw className="size-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Tentar novamente — reaproveita o nº{" "}
                                    {nota.serie}/{nota.numero}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TooltipProvider>

              {/* Pagination */}
              {pagination.totalPages > 1 && (
                <div className="flex items-center justify-between px-2 py-4">
                  <div className="flex-1 text-sm text-muted-foreground">
                    Mostrando {notas.length} de {pagination.total} notas
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPagination((prev) => ({
                          ...prev,
                          page: prev.page - 1,
                        }))
                      }
                      disabled={pagination.page === 1}
                    >
                      <ChevronLeft className="size-4" />
                      Anterior
                    </Button>
                    <span className="text-sm">
                      Pagina {pagination.page} de {pagination.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPagination((prev) => ({
                          ...prev,
                          page: prev.page + 1,
                        }))
                      }
                      disabled={pagination.page === pagination.totalPages}
                    >
                      Proximo
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Detail Sheet */}
      <NfeDetailSheet
        nfeId={selectedNfeId}
        open={isDetailOpen}
        onOpenChange={setIsDetailOpen}
        onStatusChanged={() => {
          fetchNotas();
          fetchStats();
        }}
      />

      {/* Cancel Dialog */}
      <NfeCancelDialog
        nfeId={cancelTarget?.id ?? null}
        nfeNumero={cancelTarget?.numero ?? null}
        open={isCancelOpen}
        onOpenChange={setIsCancelOpen}
        onCancelled={() => {
          showToast("NF-e cancelada com sucesso", "success");
          fetchNotas();
          fetchStats();
        }}
      />

      {/* Send Email Dialog */}
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

function NfeListSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-12 bg-muted/30 rounded animate-pulse" />
      ))}
    </div>
  );
}
