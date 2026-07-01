"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
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
import { FinanceDialog, FinanceKind } from "./finance-dialog";
import type { FinanceEntryFormData } from "../lib/finance-schema";
import { downloadReceipt } from "../lib/download-receipt";
import { PAYMENT_METHODS, paymentMethodLabel } from "@/app/lib/payment-methods";

interface FinanceRow {
  id: string;
  document: string | null;
  reason: string | null;
  paymentMethod?: string | null;
  totalAmount: number;
  installments: number;
  dueDate: string;
  status: "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";
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
    const base: Partial<FinanceEntryFormData> & {
      id?: string;
      customer?: FinanceRow["customer"];
      items?: unknown[];
    } = {
      id: r.id,
      customerId: r.customer?.id || "",
      customer: r.customer,
      unidadeId: r.unidadeId ?? null,
      document: r.document,
      reason: r.reason,
      paymentMethod: r.paymentMethod ?? null,
      totalAmount: r.totalAmount,
      installments: r.installments,
      dueDate: r.dueDate?.slice(0, 10),
    };

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
          <div className="space-y-1">
            <CardTitle>Contas {label}</CardTitle>
            <CardDescription>
              {total} título{total === 1 ? "" : "s"} cadastrado
              {total === 1 ? "" : "s"}.
            </CardDescription>
          </div>
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
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.code} value={m.code}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                      {r.paymentMethod ? (
                        <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {paymentMethodLabel(r.paymentMethod)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <span
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
                          >
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
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
    </>
  );
}
