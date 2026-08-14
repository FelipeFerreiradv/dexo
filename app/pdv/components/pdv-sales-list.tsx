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
import {
  SaleStatusFilter,
  type SaleStatusFilterCode,
} from "@/app/financeiro/components/shared/sale-status-filter";
import { SaleTimelineSheet } from "@/app/financeiro/components/shared/sale-timeline-sheet";
import { isSaleTimelineUiEnabled } from "@/app/financeiro/lib/sale-timeline-client";
import { describeCancelReason } from "@/app/financeiro/lib/cancel-reasons";
import {
  paymentMethodLabel,
  paymentMethodsSummary,
} from "@/app/lib/payment-methods";
import { SectionHeading } from "@/components/section-heading";
import {
  isFiscalUiEnabled,
  isPdvActionsMenuEnabled,
  isSaleCancelEnabled,
} from "../lib/pdv-actions";
import { PdvSaleActions } from "./pdv-sale-actions";

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
  // Bloco B — venda parcelada: `totalAmount` é só a ENTRADA; estes campos
  // trazem o agregado das parcelas para exibir o tamanho real da venda.
  // Ausentes = venda à vista.
  installmentsCount?: number;
  installmentsAmount?: number;
  // Fase 1.1 — linhas de pagamento quando a venda teve mais de uma forma.
  // Ausente = uma forma só, e aí `paymentMethod` já conta a história toda.
  payments?: { method: string; amount: number }[];
  // BLOCO D — motivo do cancelamento. Ausente em tudo que não foi cancelado
  // com motivo informado.
  cancelReasonCode?: string | null;
  cancelReason?: string | null;
}

interface Props {
  rows: PdvSaleRow[];
  // BLOCO C — filtro de status do livro do dia. Controlado pelo PdvView,
  // que é quem faz o fetch. Ausente => o cabeçalho fica como sempre foi.
  statusFilters?: SaleStatusFilterCode[];
  onStatusFiltersChange?: (v: SaleStatusFilterCode[]) => void;
  loading: boolean;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
  // Fase 2 (NFC-e): quando presente, vendas PAGAs ganham o botão "NFC-e"
  // (emitir depois/reemitir/consultar — idempotente). Ausente ⇒ UI da Fase 1.
  onNfce?: (receivableId: string, totalAmount?: number) => Promise<void>;
  // Bloco D (multi-CNPJ): emitente selecionado no caixa, repassado ao rascunho
  // de NF-e 55 do menu de ações. Ausente/null ⇒ CNPJ padrão (igual a hoje).
  nfceCompanyId?: string | null;
}

// Bloco D — menu "Ações". Flag OFF ⇒ a coluna renderiza EXATAMENTE os dois
// botões de hoje ("Receber" e "NFC-e"), sem request extra nenhum.
const ACTIONS_MENU = isPdvActionsMenuEnabled();
// Bloco E — "Cancelar venda" no menu. Flag OFF ⇒ item nem existe.
const SALE_CANCEL = isSaleCancelEnabled();
// BLOCO H — "Histórico da venda" no menu. Flag OFF ⇒ item nem existe, e o
// painel nem é montado.
const TIMELINE_UI = isSaleTimelineUiEnabled();

const SHOWN = 10;

const STATUS_STYLES: Record<SaleStatus, string> = {
  PENDENTE:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PAGA: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  VENCIDA: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  CANCELADA: "bg-muted text-muted-foreground",
};

// timeZone fixo (fuso do negócio): a hora da venda não pode variar com o
// relógio da máquina que abre a página, e um render determinístico nunca
// diverge entre SSR e browser (hydration).
function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
  })} ${d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  })}`;
}

export function PdvSalesList({
  rows,
  statusFilters,
  onStatusFiltersChange,
  loading,
  onToast,
  onChanged,
  onNfce,
  nfceCompanyId,
}: Props) {
  const { data: session } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nfceBusyId, setNfceBusyId] = useState<string | null>(null);
  // BLOCO H — venda com o histórico aberto. UM painel para a lista inteira,
  // não um por linha.
  const [timelineRow, setTimelineRow] = useState<PdvSaleRow | null>(null);

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
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeading
          eyebrow="Livro do dia · Balcão"
          title="Vendas"
          accent="recentes"
          description={
            ACTIONS_MENU
              ? "Contas a receber de venda balcão. Impressões no menu de ações; edição e estorno ficam no Financeiro."
              : "Contas a receber de venda balcão. Edição, estorno e cupom ficam no Financeiro."
          }
        />
        {onStatusFiltersChange && (
          <SaleStatusFilter
            value={statusFilters ?? []}
            onChange={onStatusFiltersChange}
          />
        )}
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
                      (() => {
                        // Fase 1.1 — venda em N formas mostrava só a
                        // predominante, como se as outras não existissem.
                        // Com 0 ou 1 linha o rótulo é idêntico ao de antes.
                        const { label, detail } = paymentMethodsSummary(
                          r.paymentMethod,
                          r.payments,
                        );
                        return (
                          <span
                            className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                            title={detail ?? undefined}
                          >
                            {label}
                          </span>
                        );
                      })()
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* BLOCO D — o motivo vira tooltip do badge, igual ao
                        Financeiro. Sem motivo, title fica undefined e o badge
                        é o de sempre. */}
                    <span
                      title={
                        describeCancelReason(
                          r.cancelReasonCode,
                          r.cancelReason,
                        ) ?? undefined
                      }
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                        STATUS_STYLES[r.status] ?? STATUS_STYLES.PENDENTE,
                      )}
                    >
                      {r.status}
                    </span>
                  </TableCell>
                  {/* Bloco B — o operador precisa ver o TAMANHO DA VENDA.
                      `totalAmount` sozinho mostraria só a entrada (R$ 50 numa
                      venda de R$ 131,11). O caixa do dia continua somando
                      apenas o que entrou — são números diferentes, e ambos
                      corretos. */}
                  <TableCell className="text-right font-mono tabular-nums">
                    {r.installmentsCount ? (
                      <span className="inline-flex flex-col items-end">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {r.installmentsCount}x
                          </span>
                          {formatToBRL(
                            r.totalAmount + (r.installmentsAmount ?? 0),
                          )}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          entrada {formatToBRL(r.totalAmount)}
                        </span>
                      </span>
                    ) : (
                      formatToBRL(r.totalAmount)
                    )}
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
                      {ACTIONS_MENU ? (
                        // Bloco D: recibo simples, NFC-e e NF-e 55 num só
                        // menu. "Receber" continua como ação primária acima.
                        <PdvSaleActions
                          saleId={r.id}
                          status={r.status}
                          totalAmount={r.totalAmount}
                          // A presença de onNfce JÁ é o gate da flag da NFC-e
                          // (pdv-view.tsx:376 passa undefined com ela OFF).
                          nfceUi={Boolean(onNfce)}
                          fiscalUi={isFiscalUiEnabled()}
                          onNfce={onNfce}
                          nfceCompanyId={nfceCompanyId}
                          // Bloco E: a UI só reflete. Quem decide é o guard
                          // `requireAction` no backend — colaborador sem a
                          // permissão recebe 403 mesmo chamando por fora.
                          saleCancelUi={SALE_CANCEL}
                          onReversed={onChanged}
                          // BLOCO H: ausente com a flag OFF ⇒ item não existe.
                          onTimeline={
                            TIMELINE_UI ? () => setTimelineRow(r) : undefined
                          }
                          onToast={onToast}
                        />
                      ) : (
                        onNfce &&
                        r.status === "PAGA" && (
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
                        )
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

      {/* BLOCO H — UM painel para a lista inteira, não um por linha; o que o
          abre é o `receivableId` não-nulo. Declarado dentro do Card só para
          não reindentar o arquivo: o SheetContent vai para um portal no
          `body`, então a posição no JSX não afeta o DOM renderizado. */}
      {TIMELINE_UI && (
        <SaleTimelineSheet
          receivableId={timelineRow?.id ?? null}
          saleLabel={
            timelineRow
              ? [timelineRow.customer?.name, formatWhen(timelineRow.createdAt)]
                  .filter(Boolean)
                  .join(" · ") || null
              : null
          }
          onOpenChange={(o) => !o && setTimelineRow(null)}
        />
      )}
    </Card>
  );
}
