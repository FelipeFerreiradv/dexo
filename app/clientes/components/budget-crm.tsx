"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  LayoutGrid, // catálogo
  List as ListIcon,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import { UnidadeFilter } from "@/app/financeiro/components/shared/unidade-select";
import { BudgetDialog } from "@/app/financeiro/components/budget-dialog";
import type { BudgetFormData } from "@/app/financeiro/lib/budget-schema";
import { downloadBudgetPdf } from "@/app/financeiro/lib/download-budget";

import { BudgetKanban } from "./budget-kanban";
import { BudgetStageList } from "./budget-stage-list";
import {
  FONT_DISPLAY,
  FONT_SERIF,
  type ColumnKey,
  type CrmBudget,
  type Transition,
  deriveColumn,
  planTransition,
} from "./budget-crm-shared";

interface Seller {
  id: string;
  name: string | null;
  email: string;
  isOwner: boolean;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

interface Props {
  // Deep-link vindo da aba Clientes (badge de contagem). Abre já filtrado.
  initialCustomerId?: string | null;
  initialCustomerName?: string | null;
  onClearCustomer?: () => void;
}

const LIMIT = 100;
const VENDEDOR_ALL = "__all_v__";
const VIEW_KEY = "dexo:clientes:crm:view";

type ViewMode = "catalog" | "list";
type Pending = { budget: CrmBudget; transition: Transition };

export function BudgetCrm({
  initialCustomerId,
  initialCustomerName,
  onClearCustomer,
}: Props) {
  const { data: session } = useSession();
  const [budgets, setBudgets] = useState<CrmBudget[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("catalog");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [vendedorFilter, setVendedorFilter] = useState<string | undefined>(
    undefined,
  );
  const [unidadeFilter, setUnidadeFilter] = useState<string | undefined>(
    undefined,
  );
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<
    | (Partial<BudgetFormData> & {
        id?: string;
        customer?: { id: string; name: string; cpf: string | null } | null;
      })
    | undefined
  >(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lostReason, setLostReason] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Persistência SÓ da preferência de visão (não do dado — estágio vive no banco).
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === "list" || v === "catalog") setView(v);
    } catch {
      /* ignore */
    }
  }, []);
  const changeView = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const showToast = useCallback((message: string, type: Toast["type"]) => {
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      4000,
    );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Vendedores (admin + colaboradores) p/ o filtro. Carrega uma vez.
  useEffect(() => {
    const email = session?.user?.email;
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/budgets/sellers`, {
          headers: { email },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSellers((data.sellers ?? []) as Seller[]);
      } catch {
        /* silencioso */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.email]);

  const fetchList = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: "1", limit: String(LIMIT) });
      if (searchTerm) params.set("search", searchTerm);
      if (vendedorFilter) params.set("vendedorId", vendedorFilter);
      if (unidadeFilter) params.set("unidadeId", unidadeFilter);
      if (initialCustomerId) params.set("customerId", initialCustomerId);
      const res = await fetch(`${getApiBaseUrl()}/budgets?${params}`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("Erro ao buscar orçamentos");
      const data = await res.json();
      setBudgets((data.items || []) as CrmBudget[]);
      setTotal(data.pagination?.total || 0);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      showToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [
    session?.user?.email,
    searchTerm,
    vendedorFilter,
    unidadeFilter,
    initialCustomerId,
    showToast,
  ]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const patchLocal = (id: string, patch: Partial<CrmBudget>) =>
    setBudgets((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  // ── Transições (matriz) ────────────────────────────────────────────────
  const onMove = (budgetId: string, to: ColumnKey) => {
    const budget = budgets.find((b) => b.id === budgetId);
    if (!budget) return;
    const from = deriveColumn(budget);
    const t = planTransition(from, to);
    switch (t.kind) {
      case "noop":
        return;
      case "blocked":
        showToast(t.reason, "warning"); // nada é persistido
        return;
      case "stage":
        moveStage(budget, t.stage);
        return;
      case "convert":
      case "cancel":
        setLostReason("");
        setPending({ budget, transition: t });
        return;
    }
  };

  // Aberto→aberto: otimista + rollback. Sem confirmação.
  const moveStage = async (
    budget: CrmBudget,
    stage: CrmBudget["pipelineStage"],
  ) => {
    const email = session?.user?.email;
    if (!email) return;
    const prev = budgets;
    patchLocal(budget.id, { pipelineStage: stage });
    try {
      const res = await fetch(`${getApiBaseUrl()}/budgets/${budget.id}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({ pipelineStage: stage }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erro ao mover");
    } catch (e) {
      setBudgets(prev); // rollback
      showToast(e instanceof Error ? e.message : "Erro ao mover", "error");
    }
  };

  const runPending = async () => {
    if (!pending) return;
    const email = session?.user?.email;
    if (!email) return;
    const { budget, transition } = pending;
    setBusyId(budget.id);
    try {
      if (transition.kind === "convert") {
        const res = await fetch(
          `${getApiBaseUrl()}/budgets/${budget.id}/convert`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", email },
            body: JSON.stringify({}),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erro ao converter");
        patchLocal(budget.id, { status: "CONVERTIDO", pipelineStage: "GANHO" });
        showToast(
          "Orçamento convertido em Conta a Receber (venda balcão). Marque como paga na aba Contas a Receber para baixar o estoque.",
          "success",
        );
      } else if (transition.kind === "cancel") {
        const res = await fetch(
          `${getApiBaseUrl()}/budgets/${budget.id}/cancel`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", email },
            body: JSON.stringify({
              pipelineStage: transition.pipelineStage,
              lostReason:
                transition.pipelineStage === "PERDIDO"
                  ? lostReason.trim() || null
                  : null,
            }),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erro ao cancelar");
        patchLocal(budget.id, {
          status: "CANCELADO",
          pipelineStage: transition.pipelineStage,
          lostReason:
            transition.pipelineStage === "PERDIDO"
              ? lostReason.trim() || null
              : (budget.lostReason ?? null),
        });
        showToast(
          transition.pipelineStage === "PERDIDO"
            ? "Orçamento marcado como Perdido."
            : "Orçamento cancelado.",
          "success",
        );
      }
      setPending(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro", "error");
      setPending(null);
      fetchList(); // reconcilia (ex.: 409 já convertido por outra aba)
    } finally {
      setBusyId(null);
    }
  };

  // ── Ações rápidas ──────────────────────────────────────────────────────
  const handleEdit = async (b: CrmBudget) => {
    const email = session?.user?.email;
    if (!email) return;
    setBusyId(b.id);
    try {
      const res = await fetch(`${getApiBaseUrl()}/budgets/${b.id}`, {
        headers: { email },
      });
      if (!res.ok) throw new Error("Falha ao carregar o orçamento");
      const data = await res.json();
      const full = data?.budget;
      const items = Array.isArray(full?.items)
        ? full.items.map((it: any) => ({
            productId: it.productId ?? null,
            description: it.description ?? null,
            scrapId: it.scrapId ?? null,
            listingId: it.listingId ?? null,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            product: it.product ?? null,
          }))
        : [];
      setEditing({
        id: b.id,
        customerId: b.customer?.id || "",
        customer: b.customer,
        unidadeId: full?.unidade?.id ?? null,
        vendedorId: b.vendedorId ?? null,
        document: b.document,
        reason: b.reason,
        notes: full?.notes ?? null,
        totalAmount: b.totalAmount,
        validUntil: full?.validUntil
          ? String(full.validUntil).slice(0, 10)
          : "",
        items,
      });
      setDialogOpen(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro ao carregar", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handlePdf = async (b: CrmBudget) => {
    const email = session?.user?.email;
    if (!email) return;
    try {
      await downloadBudgetPdf(b.id, email);
      showToast("Orçamento gerado", "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro ao gerar PDF", "error");
    }
  };

  // Ação rápida "converter" == mover para Fechado (mesma confirmação).
  const handleConvertClick = (b: CrmBudget) => {
    setLostReason("");
    setPending({ budget: b, transition: { kind: "convert" } });
  };

  const handleCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const pendingTitle =
    pending?.transition.kind === "convert"
      ? "Converter em venda"
      : pending?.transition.kind === "cancel" &&
          pending.transition.pipelineStage === "PERDIDO"
        ? "Marcar como Perdido / Desistido"
        : "Cancelar orçamento";

  const pendingDesc =
    pending?.transition.kind === "convert"
      ? "Isto cria uma Conta a Receber (venda balcão) com o cliente e os itens deste orçamento. O orçamento fica marcado como Convertido. Não pode ser desfeito."
      : pending?.transition.kind === "cancel" &&
          pending.transition.pipelineStage === "PERDIDO"
        ? "O orçamento será marcado como Perdido/Desistido (Cancelado). Essa ação não pode ser desfeita."
        : "O orçamento será marcado como Cancelado. Essa ação não pode ser desfeita.";

  const isLost =
    pending?.transition.kind === "cancel" &&
    pending.transition.pipelineStage === "PERDIDO";

  return (
    <div className="space-y-4">
      <ToastViewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
              t.type === "success"
                ? "bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-200"
                : t.type === "warning"
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-900/80 dark:text-amber-100"
                  : "bg-destructive text-white",
            )}
          >
            {t.message}
          </div>
        ))}
      </ToastViewport>

      <Card className="relative overflow-hidden border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        {/* fio-guia amarelo sinalização no topo (assinatura da marca) */}
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[#f2c419] via-[#f2c419]/60 to-transparent"
          aria-hidden
        />
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Pipeline · CRM de orçamentos
            </span>
            <CardTitle
              className={cn(
                "text-2xl tracking-tight sm:text-[26px]",
                FONT_DISPLAY,
              )}
            >
              Funil de{" "}
              <span
                className={cn(
                  "italic text-[#2c5f4f] dark:text-emerald-400",
                  FONT_SERIF,
                )}
              >
                orçamentos
              </span>
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              <span className="font-semibold text-foreground">{total}</span>{" "}
              orçamento{total === 1 ? "" : "s"}
              {total > LIMIT ? ` · exibindo os ${LIMIT} mais recentes` : ""} ·
              arraste os cards entre os estágios
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {/* Toggle catálogo ↔ lista (chip petróleo quando ativo) */}
            <div className="inline-flex rounded-full border border-border/70 bg-muted/20 p-0.5">
              <button
                type="button"
                onClick={() => changeView("catalog")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wide transition-colors",
                  view === "catalog"
                    ? "bg-foreground text-[var(--card)] shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === "catalog"}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Catálogo
              </button>
              <button
                type="button"
                onClick={() => changeView("list")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wide transition-colors",
                  view === "list"
                    ? "bg-foreground text-[var(--card)] shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === "list"}
              >
                <ListIcon className="h-3.5 w-3.5" />
                Lista
              </button>
            </div>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4" />
              Novo orçamento
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por documento, motivo ou cliente..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-10 rounded-full border border-border/70 bg-muted/20 pl-9"
              />
              {loading && (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            {sellers.length > 0 && (
              <Select
                value={vendedorFilter ?? VENDEDOR_ALL}
                onValueChange={(v) =>
                  setVendedorFilter(v === VENDEDOR_ALL ? undefined : v)
                }
              >
                <SelectTrigger className="h-10 w-full rounded-full border border-border/70 bg-muted/20 sm:w-[200px]">
                  <SelectValue placeholder="Todos os vendedores" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={VENDEDOR_ALL}>
                    Todos os vendedores
                  </SelectItem>
                  <SelectItem value="sem_vendedor">Sem vendedor</SelectItem>
                  {sellers.map((sl) => (
                    <SelectItem key={sl.id} value={sl.id}>
                      {sl.name || sl.email}
                      {sl.isOwner ? " (admin)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <UnidadeFilter value={unidadeFilter} onChange={setUnidadeFilter} />
          </div>

          {initialCustomerId && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/15 px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-wide text-foreground">
                Cliente: {initialCustomerName || "selecionado"}
                <button
                  type="button"
                  onClick={onClearCustomer}
                  aria-label="Limpar filtro de cliente"
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          )}

          {/* Prancheta técnica: grade de manual (pontos) atrás do funil */}
          <div
            className="rounded-2xl border border-border/50 p-2 sm:p-3"
            style={{
              backgroundImage:
                "radial-gradient(circle, rgba(127,133,144,0.14) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
              backgroundPosition: "-1px -1px",
            }}
          >
            {view === "catalog" ? (
              <BudgetKanban
                budgets={budgets}
                busyId={busyId}
                onMove={onMove}
                onEdit={handleEdit}
                onPdf={handlePdf}
                onConvert={handleConvertClick}
              />
            ) : (
              <BudgetStageList
                budgets={budgets}
                loading={loading}
                busyId={busyId}
                onMove={onMove}
                onEdit={handleEdit}
                onPdf={handlePdf}
                onConvert={handleConvertClick}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialData={editing}
        sellers={sellers}
        onToast={showToast}
        onSaved={fetchList}
      />

      <AlertDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingTitle}</AlertDialogTitle>
            <AlertDialogDescription>{pendingDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          {isLost && (
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">
                Motivo (opcional)
              </label>
              <Textarea
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                placeholder="Ex.: preço acima do concorrente, desistiu da compra…"
                rows={3}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={runPending} disabled={busyId !== null}>
              {pending?.transition.kind === "convert"
                ? "Converter"
                : isLost
                  ? "Marcar como Perdido"
                  : "Cancelar orçamento"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
