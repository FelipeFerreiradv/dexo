"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
  Undo2,
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
import { formatToBRL } from "@/components/ui/currency-input";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import { SectionHeading } from "@/components/section-heading";
import { FinanceDialog, FinanceKind } from "./finance-dialog";
import type { FinanceEntryFormData } from "../lib/finance-schema";
import { financeRowToFormSeed, entryPaymentsToForm } from "../lib/row-to-form";
import { downloadReceipt } from "../lib/download-receipt";
import { reverseSale } from "../lib/reverse-sale";
import {
  paymentMethodsForKind,
  paymentMethodsSummary,
} from "@/app/lib/payment-methods";
import {
  SaleStatusFilter,
  type SaleStatusFilterCode,
} from "./shared/sale-status-filter";
import { SaleTimelineSheet } from "./shared/sale-timeline-sheet";
import { isSaleTimelineUiEnabled } from "../lib/sale-timeline-client";
import {
  CancelReasonField,
  EMPTY_CANCEL_REASON,
  type CancelReasonValue,
} from "./shared/cancel-reason-field";
import {
  describeCancelReason,
  isCancelReasonUiEnabled,
} from "../lib/cancel-reasons";

interface FinanceRow {
  id: string;
  document: string | null;
  reason: string | null;
  paymentMethod?: string | null;
  totalAmount: number;
  installments: number;
  dueDate: string;
  // Fase 1.0 — campos EDITÁVEIS que a API já devolvia mas o tipo não
  // declarava. Sem eles em `base`, o `reset({...DEFAULT, ...initialData})` os
  // preenchia com o default do form e o submit os regravava por cima: editar
  // uma conta zerava multa/juros/tolerância/detalhes e fixava periodDays=30.
  debtDetails?: string | null;
  fineAmount?: number | null;
  finePercent?: number | null;
  interestPercent?: number | null;
  toleranceDays?: number | null;
  periodDays?: number | null;
  // Fase 1.1 — linhas de pagamento quando a venda teve mais de uma forma.
  // Ausente = uma forma só, e aí `paymentMethod` já conta a história toda.
  payments?: { method: string; amount: number }[];
  status: "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";
  // BLOCO D — motivo do cancelamento. Ausente em tudo que não foi cancelado
  // com motivo informado. Só leitura: o formulário de edição não os conhece
  // (`row-to-form.ts` é uma tabela explícita, não um spread da linha).
  cancelReasonCode?: string | null;
  cancelReason?: string | null;
  // BLOCO B — vendedor da venda. `sellerUserId` alimenta o formulário de
  // edição; `seller` é só o rótulo.
  sellerUserId?: string | null;
  seller?: { id: string; name: string | null; email: string | null } | null;
  customer: { id: string; name: string; cpf: string | null } | null;
  unidadeId?: string | null;
  unidade?: { id: string; name: string } | null;
}

interface Props {
  kind: FinanceKind;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
  // Filtro de unidade vindo do FinanceView. undefined = todas (sem parâmetro,
  // comportamento idêntico ao atual); "sem_unidade" = contas sem unidade.
  unidadeId?: string;
}

const LIMIT = 20;

// Flag de venda balcão (mesma do FinanceDialog). Só quando ON a edição carrega
// os itens sob demanda; com OFF o fluxo é byte-idêntico ao anterior (sem o GET
// extra) — e mesmo com itens no banco eles são preservados, pois o picker fica
// oculto e o submit não envia `items` (o backend faz updateSingle).
const BALCAO_SALE_ENABLED =
  process.env.NEXT_PUBLIC_BALCAO_SALE_ENABLED === "true";

// Bloco E — botão de estorno. Flag OFF ⇒ a coluna de ações fica byte-idêntica
// à de hoje (marcar paga, cupom, editar, excluir).
const SALE_CANCEL_ENABLED =
  process.env.NEXT_PUBLIC_SALE_CANCEL_ENABLED === "true";

// BLOCO H — botão "Histórico". Flag OFF ⇒ o botão não existe e nenhum request
// novo acontece. Só em contas a RECEBER: a timeline é da venda.
const TIMELINE_UI_ENABLED = isSaleTimelineUiEnabled();

// Sentinela do filtro de forma de pagamento (Radix Select não aceita value="").
// "todas" = não envia o parâmetro => resultado idêntico ao atual.
const METHOD_ALL = "__all__";

const STATUS_STYLES: Record<FinanceRow["status"], string> = {
  PENDENTE:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PAGA: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  VENCIDA: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  CANCELADA: "bg-muted text-muted-foreground",
};

export function FinanceList({ kind, onToast, onChanged, unidadeId }: Props) {
  const { data: session } = useSession();
  const [rows, setRows] = useState<FinanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  // Filtro por forma de pagamento. undefined = todas (não envia parâmetro).
  const [methodFilter, setMethodFilter] = useState<string | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<
    | (Partial<FinanceEntryFormData> & {
        id?: string;
        customer?: { id: string; name: string; cpf: string | null } | null;
      })
    | undefined
  >(undefined);
  const [deleteTarget, setDeleteTarget] = useState<FinanceRow | null>(null);
  // Bloco E — alvo do estorno e id em voo (a linha vira spinner).
  const [reverseTarget, setReverseTarget] = useState<FinanceRow | null>(null);
  const [reversingId, setReversingId] = useState<string | null>(null);
  // BLOCO D — motivo do cancelamento. Zerado ao abrir e ao fechar: motivo de
  // uma venda jamais pode vazar para a próxima.
  const [motivo, setMotivo] = useState<CancelReasonValue>(EMPTY_CANCEL_REASON);
  // Id em voo do "marcar como paga" — o botão não tinha guarda nenhuma e o
  // duplo clique disparava dois POST /pay (ver handleMarkPaid).
  const [payingId, setPayingId] = useState<string | null>(null);
  // BLOCO C — status selecionados. Vazio = todos (não envia o parâmetro,
  // então a consulta fica idêntica à de hoje).
  const [statusFilters, setStatusFilters] = useState<SaleStatusFilterCode[]>(
    [],
  );
  // BLOCO H — venda com o histórico aberto. null = painel fechado.
  const [timelineTarget, setTimelineTarget] = useState<FinanceRow | null>(null);
  // Edição de receivable carrega os itens sob demanda (a lista não os traz, por
  // egress). Guarda o id em carregamento p/ feedback no botão de editar.
  const [editLoadingId, setEditLoadingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const basePath =
    kind === "receivable" ? "/finance/receivables" : "/finance/payables";
  const label = kind === "receivable" ? "a receber" : "a pagar";

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Mudar o filtro de unidade volta para a primeira página.
  useEffect(() => {
    setPage(1);
  }, [unidadeId]);

  const fetchList = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
      });
      if (searchTerm) params.set("search", searchTerm);
      // unidadeId ausente => não envia o parâmetro => resultado idêntico ao atual.
      if (unidadeId) params.set("unidadeId", unidadeId);
      // methodFilter ausente => não envia => resultado idêntico ao atual.
      if (methodFilter) params.set("paymentMethod", methodFilter);
      // Ausente => não envia => resultado idêntico ao atual.
      if (statusFilters.length > 0)
        params.set("statusIn", statusFilters.join(","));
      const res = await fetch(`${getApiBaseUrl()}${basePath}?${params}`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("Erro ao buscar");
      const data = await res.json();
      setRows(data.items || []);
      setTotal(data.pagination?.total || 0);
      setTotalPages(data.pagination?.totalPages || 1);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [
    session?.user?.email,
    page,
    searchTerm,
    unidadeId,
    methodFilter,
    statusFilters,
    basePath,
    onToast,
  ]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const handleCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const handleEdit = async (r: FinanceRow) => {
    // Fase 1.0 — a montagem é uma TABELA PURA (`lib/row-to-form.ts`): todo
    // campo editável tem de constar lá, senão o submit o regrava com o default
    // do formulário. Ver o cabeçalho daquele arquivo.
    const base = financeRowToFormSeed(r);

    // Receivables podem ter itens (venda balcão). A lista NÃO os traz (egress),
    // então carregamos sob demanda ao editar. Sem os itens no form, adicionar
    // um novo faria o backend dar "replace" e apagar os pré-existentes (perda
    // de dados + total recalculado errado). Em falha, NÃO abrimos o dialog —
    // fecha a janela de perda. Payable não tem itens: abre direto (inalterado).
    const email = session?.user?.email;
    if (kind === "receivable" && BALCAO_SALE_ENABLED && email) {
      setEditLoadingId(r.id);
      try {
        const res = await fetch(`${getApiBaseUrl()}${basePath}/${r.id}`, {
          headers: { email },
        });
        if (!res.ok) throw new Error("Falha ao carregar itens da conta");
        const data = await res.json();
        const items = data?.entry?.items;
        // Contrato: findById de receivable SEMPRE inclui items (array, mesmo
        // vazio). Se vier algo diferente (contrato quebrado), não arriscamos
        // abrir item-less — o usuário poderia adicionar 1 item e o replace
        // apagaria os ocultos. Trata como falha (toast + não abre).
        if (Array.isArray(items)) {
          base.items = items.map((it: any) => ({
            productId: it.productId ?? null,
            description: it.description ?? null,
            scrapId: it.scrapId ?? null,
            listingId: it.listingId ?? null,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            // `product` (id/sku/nome) alimenta o seed do productMeta no dialog;
            // o zod descarta a chave extra no submit (object não-strict).
            product: it.product ?? null,
          }));
        } else {
          throw new Error("Resposta sem itens");
        }
        // Fase 1.1 — as linhas de pagamento viajam JUNTO dos itens no mesmo
        // `GET /:id` (buildInclude traz as duas relações). Só faltava lê-las:
        // sem isto o bloco de pagamento combinado reabria vazio e a venda
        // parecia ter perdido as formas.
        const pagamentos = entryPaymentsToForm(data?.entry?.payments);
        if (pagamentos) base.payments = pagamentos;
      } catch {
        onToast(
          "Não foi possível carregar os itens desta conta. Tente novamente.",
          "error",
        );
        setEditLoadingId(null);
        return;
      }
      setEditLoadingId(null);
    }

    setEditing(base);
    setDialogOpen(true);
  };

  const handleMarkPaid = async (r: FinanceRow) => {
    const email = session?.user?.email;
    if (!email) return;
    // Defesa em profundidade contra o duplo clique. A proteção de verdade é o
    // compare-and-swap no backend (dois POST /pay simultâneos baixavam estoque
    // duas vezes); isto só evita que o operador dispare a corrida sem querer —
    // e não cobre duas abas nem dois operadores. Espelha o `reversingId` que a
    // ação de estorno já usa logo abaixo.
    if (payingId) return;
    setPayingId(r.id);
    try {
      const res = await fetch(`${getApiBaseUrl()}${basePath}/${r.id}/pay`, {
        method: "POST",
        headers: { email },
      });
      if (!res.ok) throw new Error("Erro ao marcar como paga");
      onToast("Conta marcada como paga", "success");
      fetchList();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setPayingId(null);
    }
  };

  const handleDownloadReceipt = async (r: FinanceRow) => {
    const email = session?.user?.email;
    if (!email) return;
    try {
      await downloadReceipt(r.id, email);
      onToast("Cupom sem validade fiscal emitido", "success");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao emitir cupom", "error");
    }
  };

  // Bloco E — estorno explícito. Reusa o POST /reverse que já existia (atômico:
  // status CANCELADA + devolução de estoque na MESMA transação).
  const handleReverse = async () => {
    if (!reverseTarget) return;
    const email = session?.user?.email;
    if (!email) return;
    setReversingId(reverseTarget.id);
    try {
      // BLOCO D: com a flag de UI desligada `motivo` nunca sai do vazio, e o
      // helper monta a requisição SEM body — byte-idêntica à de antes.
      await reverseSale(reverseTarget.id, email, {
        cancelReasonCode: motivo.code,
        cancelReason: motivo.note,
      });
      onToast(
        "Venda estornada — estoque devolvido e anúncios reabertos.",
        "success",
      );
      setReverseTarget(null);
      fetchList();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao estornar", "error");
    } finally {
      setReversingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const email = session?.user?.email;
    if (!email) return;
    try {
      const res = await fetch(
        `${getApiBaseUrl()}${basePath}/${deleteTarget.id}`,
        { method: "DELETE", headers: { email } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erro ao excluir");
      onToast("Conta excluída", "success");
      setDeleteTarget(null);
      fetchList();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    }
  };

  return (
    <>
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <SectionHeading
            eyebrow={
              kind === "receivable"
                ? "Financeiro · Entradas"
                : "Financeiro · Saídas"
            }
            title="Contas"
            accent={label}
            description={`${total} título${total === 1 ? "" : "s"} cadastrado${
              total === 1 ? "" : "s"
            }`}
          />
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            Nova conta
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por documento, motivo ou cliente..."
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setPage(1);
                }}
                className="h-10 rounded-full border border-border/70 bg-muted/20 pl-9"
              />
              {loading && (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            <Select
              value={methodFilter ?? METHOD_ALL}
              onValueChange={(v) => {
                setMethodFilter(v === METHOD_ALL ? undefined : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-full border border-border/70 bg-muted/20 sm:w-[210px]">
                <SelectValue placeholder="Todas as formas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={METHOD_ALL}>Todas as formas</SelectItem>
                {paymentMethodsForKind(kind).map((m) => (
                  <SelectItem key={m.code} value={m.code}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* BLOCO C — filtro por status. Componente compartilhado com o
                livro do dia do PDV: rótulo e comportamento idênticos por
                construção. */}
            <SaleStatusFilter
              value={statusFilters}
              onChange={(v) => {
                setStatusFilters(v);
                setPage(1);
              }}
            />
          </div>

          <div className="rounded-xl border border-border/70 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Documento</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Unidade</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Parcelas</TableHead>
                  <TableHead>Vencimento</TableHead>
                  <TableHead>Forma de pagamento</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="text-center py-8 text-muted-foreground"
                    >
                      Nenhum título encontrado.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      {r.document || r.reason || "—"}
                    </TableCell>
                    <TableCell>{r.customer?.name || "—"}</TableCell>
                    <TableCell>{r.unidade?.name || "—"}</TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      R$ {formatToBRL(r.totalAmount)}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {r.installments}x
                    </TableCell>
                    <TableCell>
                      {r.dueDate
                        ? new Date(r.dueDate).toLocaleDateString("pt-BR")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {r.paymentMethod
                        ? (() => {
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
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {/* BLOCO D — o motivo vira tooltip do próprio badge: a
                          pergunta "cancelada por quê?" se responde onde ela
                          nasce, sem abrir nada. Sem motivo, o badge é o de
                          sempre (title undefined). */}
                      <span
                        title={
                          describeCancelReason(
                            r.cancelReasonCode,
                            r.cancelReason,
                          ) ?? undefined
                        }
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                          STATUS_STYLES[r.status],
                        )}
                      >
                        {r.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        {r.status !== "PAGA" && r.status !== "CANCELADA" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Marcar como paga"
                            onClick={() => handleMarkPaid(r)}
                            disabled={payingId === r.id}
                          >
                            {payingId === r.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4 text-green-600" />
                            )}
                          </Button>
                        )}
                        {kind === "receivable" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Baixar cupom sem validade fiscal"
                            onClick={() => handleDownloadReceipt(r)}
                          >
                            <Receipt className="h-4 w-4" />
                          </Button>
                        )}
                        {/* BLOCO H — histórico. Somente leitura: abre um painel
                            e faz 1 GET, e só quando o operador clica. Flag OFF
                            ⇒ o botão não existe. */}
                        {TIMELINE_UI_ENABLED && kind === "receivable" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Histórico desta venda"
                            onClick={() => setTimelineTarget(r)}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Editar"
                          // Desabilita TODOS os botões de editar enquanto uma
                          // edição carrega — impede 2 fetches concorrentes (a
                          // resposta mais lenta abriria o dialog da linha errada).
                          disabled={editLoadingId !== null}
                          onClick={() => handleEdit(r)}
                        >
                          {editLoadingId === r.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Pencil className="h-4 w-4" />
                          )}
                        </Button>
                        {/* Bloco E — estorno. O endpoint POST /reverse existia,
                            era atômico e testado, e NÃO tinha botão nenhum:
                            quem tentava excluir uma venda paga recebia 409
                            mandando "use Estornar" e não tinha como estornar.
                            Flag OFF ⇒ o botão não existe (estado atual). */}
                        {SALE_CANCEL_ENABLED &&
                          kind === "receivable" &&
                          r.status === "PAGA" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Estornar venda (devolve o estoque)"
                              disabled={reversingId === r.id}
                              onClick={() => setReverseTarget(r)}
                            >
                              {reversingId === r.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Undo2 className="h-4 w-4 text-destructive" />
                              )}
                            </Button>
                          )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteTarget(r)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-muted-foreground">
                Página {page} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Próximo
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* BLOCO H — painel lateral do histórico. UM para a lista inteira; o que
          o abre é o `receivableId` não-nulo. Flag OFF ⇒ nem é montado. */}
      {TIMELINE_UI_ENABLED && (
        <SaleTimelineSheet
          receivableId={timelineTarget?.id ?? null}
          saleLabel={
            timelineTarget
              ? [
                  timelineTarget.document || timelineTarget.reason,
                  timelineTarget.customer?.name,
                ]
                  .filter(Boolean)
                  .join(" · ") || null
              : null
          }
          onOpenChange={(o) => !o && setTimelineTarget(null)}
        />
      )}

      <FinanceDialog
        kind={kind}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialData={editing}
        onToast={onToast}
        onSaved={() => {
          fetchList();
          onChanged?.();
        }}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir título</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir este título? Essa ação não pode ser
              desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bloco E — confirmação do estorno. */}
      <AlertDialog
        open={!!reverseTarget}
        onOpenChange={(o) => {
          if (o) return;
          setReverseTarget(null);
          setMotivo(EMPTY_CANCEL_REASON);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Estornar esta venda?</AlertDialogTitle>
            <AlertDialogDescription>
              O estoque das peças volta para o catálogo e os anúncios que
              zeraram são reabertos. A conta fica com status CANCELADA e deixa
              de contar no faturamento. Se já houver nota fiscal emitida, ela{" "}
              <strong>não</strong> é cancelada por aqui — o cancelamento fiscal
              tem prazo próprio e é feito em Notas Fiscais.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* BLOCO D — fora da Description: o campo é interativo, e a
              AlertDialogDescription vira o `aria-describedby` do diálogo. */}
          {isCancelReasonUiEnabled() && (
            <CancelReasonField
              value={motivo}
              onChange={setMotivo}
              disabled={reversingId !== null}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reversingId !== null}>
              Voltar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={reversingId !== null}
              onClick={(e) => {
                // Sem preventDefault o diálogo fecha antes da resposta e o
                // operador não vê o resultado (nem o 403 de permissão).
                e.preventDefault();
                void handleReverse();
              }}
            >
              {reversingId !== null && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Estornar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
