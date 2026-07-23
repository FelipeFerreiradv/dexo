"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Plus, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { getApiBaseUrl } from "@/lib/api";
import { FinanceDialog } from "@/app/financeiro/components/finance-dialog";
import { decideAutoReceive } from "../lib/pdv-finalize";
import {
  emitNfceForReceivable,
  excedeLimiteNfce,
  isMultiCnpjUiEnabled,
  isNfceUiEnabled,
  nfceToastFor,
} from "../lib/pdv-nfce";
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
  // Fase 2 — switch "Emitir NFC-e" (default OFF; UI atrás das flags). Emite
  // automaticamente APÓS o recebimento OK; falha nunca desfaz a venda.
  const nfceUi = isNfceUiEnabled();
  const [emitNfce, setEmitNfce] = useState(false);
  // Multi-CNPJ — seletor do emitente da NFC-e. Só aparece com a flag ligada E
  // 2+ empresas; null = CNPJ padrão (comportamento atual do PDV).
  const multiCnpjUi = nfceUi && isMultiCnpjUiEnabled();
  const [companies, setCompanies] = useState<
    Array<{ id: string; cnpj: string; razaoSocial: string; nomeFantasia?: string | null; isDefault?: boolean }>
  >([]);
  const [nfceCompanyId, setNfceCompanyId] = useState<string | null>(null);

  useEffect(() => {
    if (!multiCnpjUi) return;
    const email = session?.user?.email;
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        // view=summary: só os campos do seletor (egress; mesmos valores).
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/companies?view=summary`,
          { headers: { email } },
        );
        const data = await res.json().catch(() => ({}));
        if (!cancelled && Array.isArray(data?.companies)) {
          setCompanies(data.companies);
        }
      } catch {
        // silencioso — seletor simplesmente não aparece
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [multiCnpjUi, session?.user?.email]);

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

  // Fase 2 — cadeia da NFC-e (após recebimento OK): acima do limite legal cai
  // no rascunho de NF-e 55 existente; senão emite a NFC-e em 1 clique. NUNCA
  // lança — falha vira toast; a venda jamais é desfeita pela nota.
  const runNfceChain = useCallback(
    async (receivableId: string, totalAmount?: number) => {
      const email = session?.user?.email;
      if (!email) return;
      // Multi-CNPJ: emitente do seletor vai por QUERY (POST segue sem body).
      const companyQs = nfceCompanyId
        ? `?companyId=${encodeURIComponent(nfceCompanyId)}`
        : "";
      if (excedeLimiteNfce(Number(totalAmount ?? 0))) {
        try {
          // Sem Content-Type: POST sem body — declarar JSON vazio derruba a
          // requisição no parse do Fastify (FST_ERR_CTP_EMPTY_JSON_BODY).
          const res = await fetch(
            `${getApiBaseUrl()}/finance/receivables/${receivableId}/fiscal-draft${companyQs}`,
            { method: "POST", headers: { email } },
          );
          if (!res.ok) throw new Error();
          showToast(
            "Venda acima de R$ 10.000 — NFC-e não permitida. Rascunho de NF-e (modelo 55) criado; finalize em Notas Fiscais.",
            "warning",
          );
        } catch {
          showToast(
            "Venda acima de R$ 10.000 — NFC-e não permitida. Emita a NF-e (modelo 55) pelo Financeiro.",
            "warning",
          );
        }
        return;
      }
      const outcome = await emitNfceForReceivable(
        receivableId,
        email,
        nfceCompanyId,
      );
      const t = nfceToastFor(outcome);
      showToast(t.message, t.type);
    },
    [session?.user?.email, showToast, nfceCompanyId],
  );

  // Encadeia o recebimento após o FinanceDialog salvar a venda. Fire-and-
  // forget (mesmo padrão do cupom no próprio dialog): o dialog já fechou e a
  // conta JÁ EXISTE — falha aqui nunca desfaz a venda, só a deixa PENDENTE
  // (recuperável pelo botão "Receber" da lista ou pelo Financeiro).
  const handleSavedEntry = useCallback(
    (entry: {
      id: string;
      paymentMethod?: string | null;
      totalAmount?: number;
    }) => {
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
          // Fase 2: NFC-e automática APÓS o recebimento OK (switch ligado).
          if (nfceUi && emitNfce) {
            await runNfceChain(entry.id, entry.totalAmount);
          }
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
    [
      receiveNow,
      session?.user?.email,
      showToast,
      bumpRefresh,
      nfceUi,
      emitNfce,
      runNfceChain,
    ],
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
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-6">
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
          {nfceUi && (
            <div className="flex items-center gap-3">
              <Switch
                id="pdv-emit-nfce"
                checked={emitNfce}
                onCheckedChange={setEmitNfce}
              />
              <div className="flex flex-col">
                <Label htmlFor="pdv-emit-nfce">Emitir NFC-e</Label>
                <span className="font-mono text-[11px] text-muted-foreground">
                  Emite após o recebimento (até R$ 10.000; acima vira rascunho
                  de NF-e).
                </span>
              </div>
            </div>
          )}
          {/* Multi-CNPJ: emitente da NFC-e — só com a flag E 2+ empresas.
              Sem seleção (ou seletor oculto), o backend usa o CNPJ padrão. */}
          {multiCnpjUi && companies.length > 1 && (
            <div className="flex items-center gap-3">
              <div className="w-56">
                <Select
                  value={nfceCompanyId ?? "__default__"}
                  onValueChange={(v) =>
                    setNfceCompanyId(v === "__default__" ? null : v)
                  }
                >
                  <SelectTrigger id="pdv-nfce-company">
                    <SelectValue placeholder="CNPJ emissor" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">CNPJ padrão</SelectItem>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.nomeFantasia || c.razaoSocial}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col">
                <Label htmlFor="pdv-nfce-company">CNPJ emissor</Label>
                <span className="font-mono text-[11px] text-muted-foreground">
                  Emitente das NFC-e deste caixa.
                </span>
              </div>
            </div>
          )}
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
            onNfce={nfceUi ? runNfceChain : undefined}
          />
        </div>
        <div className="min-w-0">
          <PdvBudgetsPanel
            refreshKey={refreshKey}
            onToast={showToast}
            onChanged={bumpRefresh}
            receiveNow={receiveNow}
            onNfce={nfceUi && emitNfce ? runNfceChain : undefined}
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
