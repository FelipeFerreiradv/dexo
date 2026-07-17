"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowRight, CheckCircle2, Loader2, ReceiptText } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import { paymentMethodLabel } from "@/app/lib/payment-methods";
import { SectionHeading } from "@/components/section-heading";

// "Livro do dia" do PDV — as vendas balcão recentes (contas a receber COM
// itens), estilo ledger. Presentational: as linhas vêm da PdvView (uma única
// busca compartilhada com os KPIs). A ação "Receber" usa o POST /pay
// existente — e é também o caminho de recuperação quando o "receber agora"
// falhou após criar a venda.

type SaleStatus = "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";

export interface PdvSaleRow {
  id: string;
  totalAmount: number;
  status: SaleStatus;
  paymentMethod: string | null;
  createdAt: string;
  paidAt?: string | null;
  customer?: { id: string; name: string } | null;
}

interface Props {
  rows: PdvSaleRow[];
  loading: boolean;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
  // Fase 2 (NFC-e): quando presente, vendas PAGAs ganham o botão "NFC-e"
  // (emitir depois/reemitir/consultar — idempotente). Ausente ⇒ UI da Fase 1.
  onNfce?: (receivableId: string, totalAmount?: number) => Promise<void>;
}

const SHOWN = 10;

const STATUS_STYLES: Record<SaleStatus, string> = {
  PENDENTE:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PAGA: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  VENCIDA: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  CANCELADA: "bg-muted text-muted-foreground",
};

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  })} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

export function PdvSalesList({
  rows,
  loading,
  onToast,
  onChanged,
  onNfce,
}: Props) {
  const { data: session } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nfceBusyId, setNfceBusyId] = useState<string | null>(null);

  const handleNfce = async (r: PdvSaleRow) => {
    if (!onNfce) return;
    setNfceBusyId(r.id);
    try {
      await onNfce(r.id, r.totalAmount);
    } finally {
      setNfceBusyId(null);
    }
  };

  const shown = rows.slice(0, SHOWN);

  const handleReceive = async (r: PdvSaleRow) => {
    const email = session?.user?.email;
    if (!email) return;
    setBusyId(r.id);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/finance/receivables/${r.id}/pay`,
        { method: "POST", headers: { email } },
      );
      if (!res.ok) throw new Error("Erro ao receber a venda");
      onToast(
        "Venda recebida — estoque baixado e anúncios sincronizados.",
        "success",
      );
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <SectionHeading
          eyebrow="Livro do dia · Balcão"
          title="Vendas"
          accent="recentes"
          description="Contas a receber de venda balcão. Edição, estorno e cupom ficam no Financeiro."
        />
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center font-mono text-xs text-muted-foreground">
            Nenhuma venda balcão ainda. Clique em “Nova venda” para abrir o
            caixa.
          </p>
        ) : (
          // min-w força o scroll horizontal do wrapper do Table (overflow-auto)
          // no retrato, em vez de espremer as colunas nowrap.
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  Data
                </TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  Cliente
                </TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  Forma
                </TableHead>
                <TableHead className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  Status
                </TableHead>
                <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.14em]">
                  Valor
                </TableHead>
                <TableHead className="text-right font-mono text-[10px] uppercase tracking-[0.14em]">
                  Ações
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {formatWhen(r.createdAt)}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate font-medium">
                    {r.customer?.name ?? "—"}
                  </TableCell>
                  <TableCell>
                    {r.paymentMethod ? (
                      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {paymentMethodLabel(r.paymentMethod)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                        STATUS_STYLES[r.status] ?? STATUS_STYLES.PENDENTE,
                      )}
                    >
                      {r.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatToBRL(r.totalAmount)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {r.status !== "PAGA" && r.status !== "CANCELADA" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === r.id}
                          onClick={() => handleReceive(r)}
                        >
                          {busyId === r.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          )}
                          Receber
                        </Button>
                      )}
                      {onNfce && r.status === "PAGA" && (
                        <Button
                          size="sm"
                          variant="outline"
                          title="Emitir/consultar NFC-e desta venda"
                          disabled={nfceBusyId === r.id}
                          onClick={() => handleNfce(r)}
                        >
                          {nfceBusyId === r.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ReceiptText className="h-4 w-4" />
                          )}
                          NFC-e
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 border-t border-border/60 pt-4">
        <span className="font-mono text-[11px] text-muted-foreground">
          Mostrando {shown.length} de {rows.length} venda(s) recente(s)
        </span>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/financeiro">
            Ver no Financeiro
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
