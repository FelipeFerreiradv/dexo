"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Plus, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { getApiBaseUrl } from "@/lib/api";
import { FinanceDialog } from "@/app/financeiro/components/finance-dialog";
import { decideAutoReceive } from "../lib/pdv-finalize";
import { PdvOverview } from "./pdv-overview";
import { PdvSalesList, type PdvSaleRow } from "./pdv-sales-list";
import { PdvBudgetsPanel } from "./pdv-budgets-panel";

// PDV Balcão — casca do módulo próprio sobre o fluxo de venda balcão que já
// existe no Financeiro. NADA de lógica de venda aqui: o wizard é o
// FinanceDialog (com forceBalcao), a persistência são os endpoints existentes
// (POST /finance/receivables e POST .../:id/pay) e a baixa de estoque +
// pausa/sync de anúncios continuam no markPaid/firePostEffects do backend.
//
// A view faz UMA busca de vendas recentes (hasItems=true, até 100) e a
// compartilha entre os KPIs (pdv-stats) e o livro do dia (PdvSalesList).

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

// Egress: 50 linhas cobrem com folga os KPIs "de hoje" + o livro (10 visíveis)
// sem virar um dump da base — regra da casa: listagens enxutas por padrão.
const SALES_FETCH_LIMIT = 50;

export function PdvView() {
  const { data: session } = useSession();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sales, setSales] = useState<PdvSaleRow[]>([]);
  const [salesLoading, setSalesLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  // Egress: quando o "receber agora" vai encadear o POST /pay, pulamos o
  // refresh do onSaved (o finally da cadeia já atualiza tudo) — 1 rodada de
  // requests por venda em vez de 2.
  const payChainPending = useRef(false);
  // Switch "Receber agora" (default ON): finaliza a venda já recebida (o
  // estoque baixa na hora). FIADO sempre fica pendente (ver pdv-finalize).
  const [receiveNow, setReceiveNow] = useState(true);

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "warning") => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36);
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    [],
  );

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const fetchSales = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSalesLoading(true);
    try {
      const params = new URLSearchParams({
        page: "1",
        limit: String(SALES_FETCH_LIMIT),
        hasItems: "true",
      });
      const res = await fetch(
        `${getApiBaseUrl()}/finance/receivables?${params}`,
        { headers: { email }, signal: ctrl.signal },
      );
      if (!res.ok) throw new Error("Erro ao buscar vendas");
      const data = await res.json();
      setSales((data.items || []) as PdvSaleRow[]);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      showToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      if (abortRef.current === ctrl) setSalesLoading(false);
    }
  }, [session?.user?.email, showToast]);

  useEffect(() => {
    fetchSales();
  }, [fetchSales, refreshKey]);

  // Encadeia o recebimento após o FinanceDialog salvar a venda. Fire-and-
  // forget (mesmo padrão do cupom no próprio dialog): o dialog já fechou e a
  // conta JÁ EXISTE — falha aqui nunca desfaz a venda, só a deixa PENDENTE
  // (recuperável pelo botão "Receber" da lista ou pelo Financeiro).
  const handleSavedEntry = useCallback(
    (entry: { id: string; paymentMethod?: string | null }) => {
      const decision = decideAutoReceive({
        receiveNow,
        paymentMethod: entry.paymentMethod ?? null,
      });
      if (!decision.pay) {
        showToast(
          decision.reason === "fiado"
            ? "Venda fiado registrada — ficará PENDENTE em Contas a Receber."
            : "Venda registrada como PENDENTE. Use “Receber” no livro do dia para baixar o estoque.",
          "success",
        );
        return;
      }
      payChainPending.current = true;
      void (async () => {
        try {
          const email = session?.user?.email;
          if (!email) throw new Error("Sessão expirada");
          const res = await fetch(
            `${getApiBaseUrl()}/finance/receivables/${entry.id}/pay`,
            { method: "POST", headers: { email } },
          );
          if (!res.ok) throw new Error("Falha no recebimento");
          showToast(
            "Venda recebida — estoque baixado e anúncios sincronizados.",
            "success",
          );
        } catch {
          showToast(
            "A venda foi criada, mas o recebimento falhou. Ela está PENDENTE — use “Receber” no livro do dia ou no Financeiro para concluir.",
            "warning",
          );
        } finally {
          payChainPending.current = false;
          bumpRefresh();
        }
      })();
    },
    [receiveNow, session?.user?.email, showToast, bumpRefresh],
  );

  // onSaved do dialog: refresca, EXCETO quando a cadeia de recebimento já vai
  // refrescar no finally (evita rodada dupla de requests por venda).
  const handleDialogSaved = useCallback(() => {
    if (!payChainPending.current) bumpRefresh();
  }, [bumpRefresh]);

  return (
    <div className="space-y-6">
      <ToastViewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${
              t.type === "success"
                ? "bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-200"
                : t.type === "warning"
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-900/80 dark:text-amber-100"
                  : "bg-destructive text-white"
            }`}
          >
            {t.message}
          </div>
        ))}
      </ToastViewport>

      {/* Régua financeira do caixa — mesmo idioma do overview do Financeiro. */}
      <PdvOverview sales={sales} refreshKey={refreshKey} />

      {/* Barra de operação do caixa. */}
      <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card/80 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Switch
            id="pdv-receive-now"
            checked={receiveNow}
            onCheckedChange={setReceiveNow}
          />
          <div className="flex flex-col">
            <Label htmlFor="pdv-receive-now">Receber agora</Label>
            <span className="font-mono text-[11px] text-muted-foreground">
              Baixa o estoque e sincroniza os anúncios ao finalizar.
              {" “Fiado” "}sempre fica pendente.
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/financeiro">
              <Wallet className="h-4 w-4" />
              Financeiro
            </Link>
          </Button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Nova venda
          </Button>
        </div>
      </div>

      {/* min-w-0 nos filhos do grid: sem ele, o item de grid não encolhe
          abaixo da largura natural da tabela (whitespace-nowrap) e a página
          estoura no mobile em vez de rolar DENTRO do card. */}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <PdvSalesList
            rows={sales}
            loading={salesLoading}
            onToast={showToast}
            onChanged={bumpRefresh}
          />
        </div>
        <div className="min-w-0">
          <PdvBudgetsPanel
            refreshKey={refreshKey}
            onToast={showToast}
            onChanged={bumpRefresh}
            receiveNow={receiveNow}
          />
        </div>
      </div>

      <FinanceDialog
        kind="receivable"
        forceBalcao
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onToast={showToast}
        onSaved={handleDialogSaved}
        onSavedEntry={handleSavedEntry}
      />
    </div>
  );
}
