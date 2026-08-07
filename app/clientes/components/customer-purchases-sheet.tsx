"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ShoppingBag,
} from "lucide-react";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import { paymentMethodLabel } from "@/app/lib/payment-methods";
import {
  isFiscalUiEnabled,
  isPdvActionsMenuEnabled,
  isSaleCancelEnabled,
} from "@/app/pdv/lib/pdv-actions";
import { isNfceUiEnabled } from "@/app/pdv/lib/pdv-nfce";
import { PdvSaleActions } from "@/app/pdv/components/pdv-sale-actions";
import {
  PURCHASES_PAGE_SIZE,
  fetchCustomerPurchases,
  fetchCustomerTotals,
  fetchPurchaseItems,
  type PurchaseItem,
  type PurchaseRow,
  type PurchaseStatus,
  type PurchasesTotals,
} from "../lib/customer-purchases";

// Bloco C — histórico de compras da ficha do cliente.
//
// LEITURA PURA: nenhum endpoint novo, nenhuma escrita. O vínculo venda↔cliente
// já existia (Receivable.customerId é NOT NULL) e o filtro `customerId` já
// estava implementado no repositório — só não tinha UI. Isto é a UI.
//
// Os atalhos de impressão reusam o menu do Bloco D (PdvSaleActions). Emitir
// NFC-e nova fica desabilitado aqui de propósito: é operação de caixa, e o
// emitente multi-CNPJ é escolhido no PDV.

interface Props {
  customerId: string | null;
  customerName: string;
  onOpenChange: (open: boolean) => void;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
}

const STATUS_STYLES: Record<PurchaseStatus, string> = {
  PENDENTE:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PAGA: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  VENCIDA: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  CANCELADA: "bg-muted text-muted-foreground",
};

// timeZone fixo (fuso do negócio), igual ao livro do dia do PDV: render
// determinístico não diverge entre SSR e browser (hydration).
function formatDay(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });
}

export function CustomerPurchasesSheet({
  customerId,
  customerName,
  onOpenChange,
  onToast,
}: Props) {
  const { data: session } = useSession();
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [totals, setTotals] = useState<PurchasesTotals | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, PurchaseItem[]>>({});
  const [itemsLoading, setItemsLoading] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const showActions = isPdvActionsMenuEnabled();

  // Toda vez que troca de cliente, o painel recomeça do zero — senão a página
  // e os itens expandidos do cliente anterior vazariam para o novo.
  useEffect(() => {
    setPage(1);
    setExpanded(null);
    setItems({});
    setTotals(null);
  }, [customerId]);

  const load = useCallback(async () => {
    const email = session?.user?.email;
    if (!customerId || !email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const [pageData, totalsData] = await Promise.all([
        fetchCustomerPurchases(customerId, email, page, ctrl.signal),
        // Totais só na primeira página: não mudam ao paginar.
        page === 1
          ? fetchCustomerTotals(customerId, email, ctrl.signal)
          : Promise.resolve(null),
      ]);
      setRows(pageData.rows);
      setTotal(pageData.total);
      setTotalPages(pageData.totalPages);
      if (totalsData) setTotals(totalsData);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [customerId, session?.user?.email, page, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Itens sob demanda: a listagem não os traz (egress), então cada expansão
  // custa 1 request — e só do que o operador realmente abriu.
  const toggleExpand = useCallback(
    async (row: PurchaseRow) => {
      if (expanded === row.id) {
        setExpanded(null);
        return;
      }
      setExpanded(row.id);
      if (items[row.id]) return;
      const email = session?.user?.email;
      if (!email) return;
      setItemsLoading(row.id);
      try {
        const loaded = await fetchPurchaseItems(row.id, email);
        setItems((prev) => ({ ...prev, [row.id]: loaded }));
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Erro", "error");
        setExpanded(null);
      } finally {
        setItemsLoading(null);
      }
    },
    [expanded, items, session?.user?.email, onToast],
  );

  return (
    <Sheet open={!!customerId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4" />
            Compras de {customerName}
          </SheetTitle>
          <SheetDescription>
            Vendas de balcão registradas para este cliente. Cobranças avulsas
            (serviços, taxas) não entram aqui.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {totals && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Compras", value: String(totals.count), mono: true },
                { label: "Já pago", value: formatToBRL(totals.paidAmount) },
                { label: "Em aberto", value: formatToBRL(totals.pendingAmount) },
                {
                  label: "Vencido",
                  value: formatToBRL(totals.overdueAmount),
                  alert: totals.overdueAmount > 0,
                },
              ].map((k) => (
                <div
                  key={k.label}
                  className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {k.label}
                  </p>
                  <p
                    className={cn(
                      "font-mono text-sm tabular-nums",
                      k.alert && "text-destructive",
                    )}
                  >
                    {k.value}
                  </p>
                </div>
              ))}
            </div>
          )}

          {loading && rows.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-16 text-center font-mono text-xs text-muted-foreground">
              Este cliente ainda não tem compras de balcão registradas.
            </p>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="rounded-lg border border-border/60 bg-card/60"
                >
                  <div className="flex items-start gap-2 p-3">
                    <button
                      type="button"
                      onClick={() => void toggleExpand(r)}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      aria-expanded={expanded === r.id}
                    >
                      <ChevronDown
                        className={cn(
                          "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                          expanded === r.id && "rotate-180",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {r.reason || "Venda balcão"}
                        </p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {formatDay(r.createdAt)}
                          {" · "}
                          {r.paymentMethod
                            ? paymentMethodLabel(r.paymentMethod)
                            : "sem forma"}
                        </p>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                          STATUS_STYLES[r.status] ?? STATUS_STYLES.PENDENTE,
                        )}
                      >
                        {r.status}
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {formatToBRL(r.totalAmount)}
                      </span>
                      {showActions && (
                        <PdvSaleActions
                          saleId={r.id}
                          status={r.status}
                          totalAmount={r.totalAmount}
                          nfceUi={isNfceUiEnabled()}
                          fiscalUi={isFiscalUiEnabled()}
                          // Sem onNfce: emitir NFC-e nova é operação de caixa.
                          // Reimprimir/consultar continuam disponíveis.
                          saleCancelUi={isSaleCancelEnabled()}
                          onReversed={() => void load()}
                          onToast={onToast}
                        />
                      )}
                    </div>
                  </div>

                  {expanded === r.id && (
                    <div className="border-t border-border/60 px-3 py-2">
                      {itemsLoading === r.id ? (
                        <div className="flex items-center gap-2 py-2 text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="font-mono text-[11px]">
                            Carregando itens…
                          </span>
                        </div>
                      ) : (items[r.id] ?? []).length === 0 ? (
                        <p className="py-2 font-mono text-[11px] text-muted-foreground">
                          Sem itens detalhados.
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {(items[r.id] ?? []).map((it) => (
                            <li
                              key={it.id}
                              className="flex items-baseline justify-between gap-3 font-mono text-[11px]"
                            >
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                {it.product?.sku ? `${it.product.sku} · ` : ""}
                                {it.product?.name ??
                                  it.description ??
                                  "Item avulso"}
                              </span>
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {it.quantity} × {formatToBRL(it.unitPrice)}
                              </span>
                              <span className="w-20 shrink-0 text-right tabular-nums">
                                {formatToBRL(it.quantity * it.unitPrice)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border/60 pt-3">
              <span className="font-mono text-[11px] text-muted-foreground">
                {total} compra{total === 1 ? "" : "s"} · página {page} de{" "}
                {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Próximo
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {totalPages <= 1 && rows.length > 0 && (
            <p className="border-t border-border/60 pt-3 font-mono text-[11px] text-muted-foreground">
              {total} compra{total === 1 ? "" : "s"}
              {total > PURCHASES_PAGE_SIZE ? "" : " registrada(s)"}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
