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
    }
  }, [open, nfeId, fetchNfe]);

  const handleDownload = (type: "xml" | "danfe") => {
    if (!nfeId || !session?.user?.email) return;
    const apiBase = getApiBaseUrl();
    const url = `${apiBase}/fiscal/nfe/${nfeId}/${type}`;
    // Use a hidden form/link approach to download with auth header
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    // For simplicity, open in new tab (backend serves with Content-Disposition)
    window.open(`${url}?email=${encodeURIComponent(session.user.email)}`, "_blank");
  };

  const dest = nfe?.destinatarioJson as any;
  const totais = nfe?.totaisJson as any;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetTitle className="text-lg font-semibold mb-4">
          Detalhes da NF-e
        </SheetTitle>

        {loading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="h-4 bg-muted/40 rounded animate-pulse"
              />
            ))}
          </div>
        ) : nfe ? (
          <div className="space-y-6">
            {/* Identification */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Hash className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Identificacao</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Numero</span>
                  <p className="font-medium">{nfe.numero}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Serie</span>
                  <p className="font-medium">{nfe.serie}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <p>
                    <NfeStatusBadge status={nfe.status} />
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Ambiente</span>
                  <p className="font-medium">
                    <Badge variant="outline">
                      {nfe.ambiente === "HOMOLOGACAO"
                        ? "Homologacao"
                        : "Producao"}
                    </Badge>
                  </p>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">
                    Chave de Acesso
                  </span>
                  <p className="font-mono text-xs break-all">
                    {nfe.chaveAcesso ?? "—"}
                  </p>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">
                    Natureza da Operacao
                  </span>
                  <p className="font-medium">{nfe.naturezaOperacao}</p>
                </div>
                {nfe.protocoloAutorizacao && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">
                      Protocolo de Autorizacao
                    </span>
                    <p className="font-mono text-xs">
                      {nfe.protocoloAutorizacao}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Dates */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Calendar className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Datas</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Emissao</span>
                  <p className="font-medium">
                    {formatDateTime(nfe.dataEmissao)}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Autorizacao</span>
                  <p className="font-medium">
                    {formatDateTime(nfe.dataAutorizacao)}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Criado em</span>
                  <p className="font-medium">
                    {formatDateTime(nfe.createdAt)}
                  </p>
                </div>
              </div>
            </div>

            {/* Destinatario */}
            {dest && dest.nome && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <User className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Destinatario</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Nome</span>
                    <p className="font-medium">{dest.nome}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">CPF/CNPJ</span>
                    <p className="font-medium">{dest.cpfCnpj ?? "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">UF</span>
                    <p className="font-medium">{dest.uf ?? "—"}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Totais */}
            {totais && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Totais</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Produtos</span>
                    <p className="font-medium">
                      {formatCurrency(totais.totalProdutos ?? 0)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Desconto</span>
                    <p className="font-medium">
                      {formatCurrency(totais.totalDesconto ?? 0)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">ICMS</span>
                    <p className="font-medium">
                      {formatCurrency(totais.totalIcms ?? 0)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">IPI</span>
                    <p className="font-medium">
                      {formatCurrency(totais.totalIpi ?? 0)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">PIS</span>
                    <p className="font-medium">
                      {formatCurrency(totais.totalPis ?? 0)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">COFINS</span>
                    <p className="font-medium">
                      {formatCurrency(totais.totalCofins ?? 0)}
                    </p>
                  </div>
                  <div className="col-span-2 border-t pt-2">
                    <span className="text-muted-foreground">Total da Nota</span>
                    <p className="text-lg font-bold">
                      {formatCurrency(totais.totalNota ?? 0)}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Items */}
            {nfe.itens && nfe.itens.length > 0 && (
              <div className="space-y-3">
                <span className="text-sm font-medium">
                  Itens ({nfe.itens.length})
                </span>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Descricao</TableHead>
                      <TableHead className="text-right">Qtd</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nfe.itens.map((item: any) => (
                      <TableRow key={item.id}>
                        <TableCell className="text-xs">{item.numero}</TableCell>
                        <TableCell className="text-xs max-w-[180px] truncate">
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
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownload("xml")}
                disabled={!nfe.xmlAutorizadoPath && !nfe.xmlOriginalPath}
              >
                <Download className="size-4 mr-1" />
                XML
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownload("danfe")}
                disabled={!nfe.danfePdfPath}
              >
                <Download className="size-4 mr-1" />
                DANFE
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

            {/* Events Timeline */}
            {events.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Clock className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    Historico de Eventos
                  </span>
                </div>
                <div className="space-y-2">
                  {events.map((ev: any) => (
                    <div
                      key={ev.id}
                      className="flex items-start gap-3 text-sm border-l-2 border-border pl-3 py-1"
                    >
                      <div className="flex-1">
                        <p className="font-medium">{ev.evento}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(ev.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Rejection reason */}
            {nfe.motivoRejeicao && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Shield className="size-4 text-destructive" />
                  <span className="text-sm font-medium text-destructive">
                    Motivo da Rejeicao
                  </span>
                </div>
                <p className="text-sm">{nfe.motivoRejeicao}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">NF-e nao encontrada.</p>
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
