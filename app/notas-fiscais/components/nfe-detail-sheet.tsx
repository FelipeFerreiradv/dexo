"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  FileText,
  Download,
  Calendar,
  User,
  Hash,
  Shield,
  Clock,
  Ban,
  Mail,
  Copy,
  CheckCircle2,
  Receipt,
} from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getApiBaseUrl } from "@/lib/api";
import { NfeStatusBadge } from "./nfe-status-badge";
import { NfeCancelDialog } from "./nfe-cancel-dialog";
import { NfeSendEmailDialog } from "./nfe-send-email-dialog";

interface NfeDetailSheetProps {
  nfeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChanged?: () => void;
}

const formatCurrency = (value: number) =>
  value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

const formatDateTime = (value: Date | string | null) => {
  if (!value) return "—";
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
};

export function NfeDetailSheet({
  nfeId,
  open,
  onOpenChange,
  onStatusChanged,
}: NfeDetailSheetProps) {
  const { data: session } = useSession();
  const [nfe, setNfe] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const [isEmailOpen, setIsEmailOpen] = useState(false);
  const [copiedChave, setCopiedChave] = useState(false);

  const fetchNfe = useCallback(async () => {
    if (!nfeId || !session?.user?.email) return;
    setLoading(true);
    try {
      const apiBase = getApiBaseUrl();
      const headers = {
        "Content-Type": "application/json",
        email: session.user.email,
      };

      const [nfeRes, eventsRes] = await Promise.all([
        fetch(`${apiBase}/fiscal/nfe/${nfeId}`, { headers }),
        fetch(`${apiBase}/fiscal/nfe/${nfeId}/events`, { headers }),
      ]);

      if (nfeRes.ok) {
        const data = await nfeRes.json();
        setNfe(data.nfe);
      }
      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(data.events ?? []);
      }
    } catch (e) {
      console.error("Erro ao buscar detalhes NF-e:", e);
    } finally {
      setLoading(false);
    }
  }, [nfeId, session?.user?.email]);

  useEffect(() => {
    if (open && nfeId) {
      fetchNfe();
    }
    if (!open) {
      setNfe(null);
      setEvents([]);
      setCopiedChave(false);
    }
  }, [open, nfeId, fetchNfe]);

  const handleDownload = async (type: "xml" | "danfe") => {
    if (!nfeId || !session?.user?.email) return;
    const apiBase = getApiBaseUrl();
    const url = `${apiBase}/fiscal/nfe/${nfeId}/${type}`;
    try {
      const res = await fetch(url, {
        headers: { email: session.user.email },
      });
      if (!res.ok) {
        console.error(`Erro ao baixar ${type}: HTTP ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download =
        type === "xml"
          ? `nfe-${nfe?.serie ?? ""}-${nfe?.numero ?? ""}.xml`
          : `danfe-${nfe?.serie ?? ""}-${nfe?.numero ?? ""}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error(`Erro ao baixar ${type}:`, err);
    }
  };

  const handleCopyChave = async () => {
    if (!nfe?.chaveAcesso) return;
    try {
      await navigator.clipboard.writeText(nfe.chaveAcesso);
      setCopiedChave(true);
      setTimeout(() => setCopiedChave(false), 2000);
    } catch {
      // noop
    }
  };

  const dest = nfe?.destinatarioJson as any;
  const totais = nfe?.totaisJson as any;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden border-l border-border/60 bg-gradient-to-b from-background via-background to-muted p-0 shadow-2xl sm:max-w-[900px] lg:max-w-[1100px]"
      >
        <SheetTitle className="sr-only">Detalhes da NF-e</SheetTitle>

        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="space-y-4 w-full max-w-md p-6">
              {[...Array(5)].map((_, i) => (
                <div
                  key={i}
                  className="h-4 bg-muted/40 rounded animate-pulse"
                />
              ))}
            </div>
          </div>
        ) : nfe ? (
          <div className="relative flex h-full flex-col">
            {/* ── Header ── */}
            <div className="relative isolate overflow-hidden border-b border-border/60 bg-gradient-to-r from-primary/12 via-primary/6 to-transparent pl-6 pr-12 pb-6 pt-6">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-48 bg-[radial-gradient(circle_at_top_left,theme(colors.primary/25),transparent_55%)] opacity-80"
              />

              <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-inner shadow-primary/20">
                      <Receipt className="size-5" />
                    </span>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                        NF-e · Serie {nfe.serie}
                      </p>
                      <p className="text-xl font-semibold leading-tight text-foreground">
                        Nota Fiscal #{nfe.numero}
                      </p>
                    </div>
                  </div>

                  <p className="text-sm text-muted-foreground">
                    {nfe.naturezaOperacao}
                  </p>

                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                      <Calendar className="size-3" />
                      Emitida em {formatDateTime(nfe.dataEmissao)}
                    </span>
                    {nfe.dataAutorizacao ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/70 px-3 py-1">
                        <Shield className="size-3" />
                        Autorizada em {formatDateTime(nfe.dataAutorizacao)}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-3 text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <NfeStatusBadge status={nfe.status} />
                    <Badge
                      variant="outline"
                      className="border-border/60 bg-card/70 text-[11px] uppercase tracking-[0.08em] text-muted-foreground"
                    >
                      {nfe.ambiente === "HOMOLOGACAO"
                        ? "Homologacao"
                        : "Producao"}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                      Total da Nota
                    </p>
                    <p className="text-3xl font-semibold leading-tight text-foreground">
                      {formatCurrency(totais?.totalNota ?? 0)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Chave de acesso */}
              {nfe.chaveAcesso ? (
                <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/80 px-3 py-2 shadow-sm">
                  <Hash className="size-3.5 text-muted-foreground" />
                  <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    Chave
                  </span>
                  <span className="font-mono text-xs text-foreground break-all flex-1 min-w-0">
                    {nfe.chaveAcesso}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={handleCopyChave}
                  >
                    {copiedChave ? (
                      <>
                        <CheckCircle2 className="size-3.5 mr-1 text-green-600" />
                        Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="size-3.5 mr-1" />
                        Copiar
                      </>
                    )}
                  </Button>
                </div>
              ) : null}
            </div>

            {/* ── Body ── */}
            <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-8 pt-6">
              {/* Ações rápidas */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownload("xml")}
                  disabled={!nfe.xmlAutorizadoPath && !nfe.xmlOriginalPath}
                >
                  <Download className="size-4 mr-1" />
                  Baixar XML
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownload("danfe")}
                  disabled={!nfe.danfePdfPath}
                >
                  <Download className="size-4 mr-1" />
                  Baixar DANFE
                </Button>
                {(nfe.status === "AUTHORIZED" || nfe.status === "CANCELLED") && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsEmailOpen(true)}
                  >
                    <Mail className="size-4 mr-1" />
                    Enviar e-mail
                  </Button>
                )}
                {nfe.status === "AUTHORIZED" && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setIsCancelOpen(true)}
                  >
                    <Ban className="size-4 mr-1" />
                    Cancelar NF-e
                  </Button>
                )}
              </div>

              {/* Cards de info */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Destinatario */}
                {dest && dest.nome ? (
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <User className="size-4" />
                      Destinatario
                    </div>
                    <div className="mt-2 text-base font-semibold text-foreground">
                      {dest.nome}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {dest.cpfCnpj ?? "Sem CPF/CNPJ"}
                      {dest.uf ? ` · ${dest.uf}` : ""}
                    </p>
                  </div>
                ) : null}

                {/* Protocolo */}
                <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Shield className="size-4" />
                    Protocolo de Autorizacao
                  </div>
                  <div className="mt-2 text-base font-semibold text-foreground break-all">
                    {nfe.protocoloAutorizacao ?? "—"}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {nfe.dataAutorizacao
                      ? formatDateTime(nfe.dataAutorizacao)
                      : "Aguardando autorizacao"}
                  </p>
                </div>

                {/* Totais resumo */}
                {totais ? (
                  <div className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur md:col-span-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileText className="size-4" />
                      Totais
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Produtos
                        </div>
                        <div className="font-semibold text-foreground">
                          {formatCurrency(totais.totalProdutos ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Desconto
                        </div>
                        <div className="font-semibold text-foreground">
                          {formatCurrency(totais.totalDesconto ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">
                          ICMS
                        </div>
                        <div className="font-semibold text-foreground">
                          {formatCurrency(totais.totalIcms ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">IPI</div>
                        <div className="font-semibold text-foreground">
                          {formatCurrency(totais.totalIpi ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">PIS</div>
                        <div className="font-semibold text-foreground">
                          {formatCurrency(totais.totalPis ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">
                          COFINS
                        </div>
                        <div className="font-semibold text-foreground">
                          {formatCurrency(totais.totalCofins ?? 0)}
                        </div>
                      </div>
                      <div className="col-span-2 border-t pt-2 md:col-span-4">
                        <div className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                          Total da Nota
                        </div>
                        <div className="text-xl font-bold text-foreground">
                          {formatCurrency(totais.totalNota ?? 0)}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Itens */}
              {nfe.itens && nfe.itens.length > 0 ? (
                <section className="rounded-2xl border border-border/60 bg-card/80 shadow-sm backdrop-blur">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                        Itens da Nota
                      </p>
                      <p className="text-sm font-semibold text-foreground">
                        {nfe.itens.length}{" "}
                        {nfe.itens.length === 1 ? "item" : "itens"}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="bg-muted/40 text-[11px] font-medium text-muted-foreground"
                    >
                      Produto · Qtd · Total
                    </Badge>
                  </div>

                  <div className="p-4">
                    <Table className="[&_th]:text-xs">
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Descricao</TableHead>
                          <TableHead className="text-right">Qtd</TableHead>
                          <TableHead className="text-right">
                            Valor unit.
                          </TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {nfe.itens.map((item: any) => (
                          <TableRow key={item.id} className="hover:bg-muted/40">
                            <TableCell className="text-xs">
                              {item.numero}
                            </TableCell>
                            <TableCell className="text-xs font-medium text-foreground max-w-[260px] truncate">
                              {item.descricao}
                            </TableCell>
                            <TableCell className="text-xs text-right">
                              {Number(item.quantidade)}
                            </TableCell>
                            <TableCell className="text-xs text-right">
                              {formatCurrency(Number(item.valorUnitario))}
                            </TableCell>
                            <TableCell className="text-xs text-right">
                              {formatCurrency(Number(item.valorTotal))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              ) : null}

              {/* Histórico */}
              {events.length > 0 ? (
                <section className="rounded-2xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="size-4" />
                    Historico de Eventos
                  </div>
                  <div className="mt-3 space-y-2">
                    {events.map((ev: any) => (
                      <div
                        key={ev.id}
                        className="flex items-start gap-3 text-sm border-l-2 border-primary/30 pl-3 py-1"
                      >
                        <div className="flex-1">
                          <div className="font-medium text-foreground">
                            {ev.evento}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDateTime(ev.createdAt)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* Motivo rejeição */}
              {nfe.motivoRejeicao ? (
                <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="size-4 text-destructive" />
                    <span className="text-sm font-medium text-destructive">
                      {nfe.status === "CANCELLED"
                        ? "Justificativa do cancelamento"
                        : "Motivo da Rejeicao"}
                    </span>
                  </div>
                  <p className="text-sm">{nfe.motivoRejeicao}</p>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <p className="text-muted-foreground">NF-e nao encontrada.</p>
          </div>
        )}
      </SheetContent>

      <NfeCancelDialog
        nfeId={nfeId}
        nfeNumero={nfe?.numero ?? null}
        open={isCancelOpen}
        onOpenChange={setIsCancelOpen}
        onCancelled={() => {
          fetchNfe();
          onStatusChanged?.();
        }}
      />

      <NfeSendEmailDialog
        nfeId={nfeId}
        nfeNumero={nfe?.numero ?? null}
        open={isEmailOpen}
        onOpenChange={setIsEmailOpen}
        onSent={() => {}}
      />
    </Sheet>
  );
}
