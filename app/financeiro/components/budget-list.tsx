"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  FileDown,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShoppingCart,
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
import { SectionHeading } from "@/components/section-heading";
import { BudgetDialog } from "./budget-dialog";
import type { BudgetFormData } from "../lib/budget-schema";
import { downloadBudgetPdf } from "../lib/download-budget";

type BudgetStatus = "ABERTO" | "CONVERTIDO" | "EXPIRADO" | "CANCELADO";

interface Seller {
  id: string;
  name: string | null;
  email: string;
  isOwner: boolean;
}

interface BudgetRow {
  id: string;
  document: string | null;
  reason: string | null;
  totalAmount: number;
  validUntil: string | null;
  status: BudgetStatus;
  customer: { id: string; name: string; cpf: string | null } | null;
  unidadeId?: string | null;
  unidade?: { id: string; name: string } | null;
  vendedorId?: string | null;
  vendedor?: { id: string; name: string | null; email: string } | null;
  receivableId?: string | null;
}

interface Props {
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
  unidadeId?: string;
}

const LIMIT = 20;
const STATUS_ALL = "__all__";
const VENDEDOR_ALL = "__all_v__";

const STATUS_STYLES: Record<BudgetStatus, string> = {
  ABERTO:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  CONVERTIDO:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  EXPIRADO:
    "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  CANCELADO: "bg-muted text-muted-foreground",
};
const STATUS_LABEL: Record<BudgetStatus, string> = {
  ABERTO: "Aberto",
  CONVERTIDO: "Convertido",
  EXPIRADO: "Expirado",
  CANCELADO: "Cancelado",
};

export function BudgetList({ onToast, onChanged, unidadeId }: Props) {
  const { data: session } = useSession();
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );
  const [vendedorFilter, setVendedorFilter] = useState<string | undefined>(
    undefined,
  );
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<
    | (Partial<BudgetFormData> & {
        id?: string;
        customer?: { id: string; name: string; cpf: string | null } | null;
      })
    | undefined
  >(undefined);
  const [confirm, setConfirm] = useState<{
    type: "delete" | "convert";
    row: BudgetRow;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [unidadeId]);

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
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
      });
      if (searchTerm) params.set("search", searchTerm);
      if (unidadeId) params.set("unidadeId", unidadeId);
      if (statusFilter) params.set("status", statusFilter);
      if (vendedorFilter) params.set("vendedorId", vendedorFilter);
      const res = await fetch(`${getApiBaseUrl()}/budgets?${params}`, {
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
    statusFilter,
    vendedorFilter,
    onToast,
  ]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const handleCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const handleEdit = async (r: BudgetRow) => {
    const email = session?.user?.email;
    if (!email) return;
    setBusyId(r.id);
    try {
      // A lista não traz itens (egress) — carrega sob demanda ao editar.
      const res = await fetch(`${getApiBaseUrl()}/budgets/${r.id}`, {
        headers: { email },
      });
      if (!res.ok) throw new Error("Falha ao carregar o orçamento");
      const data = await res.json();
      const b = data?.budget;
      const items = Array.isArray(b?.items)
        ? b.items.map((it: any) => ({
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
        id: r.id,
        customerId: r.customer?.id || "",
        customer: r.customer,
        unidadeId: r.unidadeId ?? null,
        vendedorId: r.vendedorId ?? null,
        document: r.document,
        reason: r.reason,
        notes: b?.notes ?? null,
        totalAmount: r.totalAmount,
        validUntil: b?.validUntil ? String(b.validUntil).slice(0, 10) : "",
        items,
      });
      setDialogOpen(true);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao carregar", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handlePrint = async (r: BudgetRow) => {
    const email = session?.user?.email;
    if (!email) return;
    try {
      await downloadBudgetPdf(r.id, email);
      onToast("Orçamento gerado", "success");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao gerar PDF", "error");
    }
  };

  const handleCancel = async (r: BudgetRow) => {
    const email = session?.user?.email;
    if (!email) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`${getApiBaseUrl()}/budgets/${r.id}/cancel`, {
        method: "POST",
        headers: { email },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erro ao cancelar");
      onToast("Orçamento cancelado", "success");
      fetchList();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleConvert = async (r: BudgetRow) => {
    const email = session?.user?.email;
    if (!email) return;
    setBusyId(r.id);
    try {
      const res = await fetch(`${getApiBaseUrl()}/budgets/${r.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erro ao converter");
      onToast(
        "Orçamento convertido em Conta a Receber (venda balcão). Marque como paga na aba Contas a Receber para baixar o estoque.",
        "success",
      );
      setConfirm(null);
      fetchList();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (r: BudgetRow) => {
    const email = session?.user?.email;
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/budgets/${r.id}`, {
        method: "DELETE",
        headers: { email },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erro ao excluir");
      onToast("Orçamento excluído", "success");
      setConfirm(null);
      fetchList();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    }
  };

  return (
    <>
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <SectionHeading
            eyebrow="Financeiro · Propostas"
            title="Orçamentos"
            description={`${total} orçamento${total === 1 ? "" : "s"} cadastrado${
              total === 1 ? "" : "s"
            }`}
          />
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            Novo orçamento
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
              value={statusFilter ?? STATUS_ALL}
              onValueChange={(v) => {
                setStatusFilter(v === STATUS_ALL ? undefined : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-full border border-border/70 bg-muted/20 sm:w-[200px]">
                <SelectValue placeholder="Todos os status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STATUS_ALL}>Todos os status</SelectItem>
                <SelectItem value="ABERTO">Aberto</SelectItem>
                <SelectItem value="EXPIRADO">Expirado</SelectItem>
                <SelectItem value="CONVERTIDO">Convertido</SelectItem>
                <SelectItem value="CANCELADO">Cancelado</SelectItem>
              </SelectContent>
            </Select>
            {sellers.length > 0 && (
              <Select
                value={vendedorFilter ?? VENDEDOR_ALL}
                onValueChange={(v) => {
                  setVendedorFilter(v === VENDEDOR_ALL ? undefined : v);
                  setPage(1);
                }}
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
          </div>

          <div className="rounded-xl border border-border/70 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Documento</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Unidade</TableHead>
                  <TableHead>Vendedor</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Validade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center py-8 text-muted-foreground"
                    >
                      Nenhum orçamento encontrado.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => {
                  const editable =
                    r.status === "ABERTO" || r.status === "EXPIRADO";
                  const convertible =
                    r.status !== "CONVERTIDO" && r.status !== "CANCELADO";
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {r.document || r.reason || "—"}
                      </TableCell>
                      <TableCell>{r.customer?.name || "—"}</TableCell>
                      <TableCell>{r.unidade?.name || "—"}</TableCell>
                      <TableCell>
                        {r.vendedor?.name || r.vendedor?.email || "—"}
                      </TableCell>
                      <TableCell className="font-mono font-semibold tabular-nums">
                        R$ {formatToBRL(r.totalAmount)}
                      </TableCell>
                      <TableCell>
                        {r.validUntil
                          ? new Date(r.validUntil).toLocaleDateString("pt-BR")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                            STATUS_STYLES[r.status],
                          )}
                        >
                          {STATUS_LABEL[r.status]}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          {convertible && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Converter em venda (Conta a Receber)"
                              disabled={busyId !== null}
                              onClick={() =>
                                setConfirm({ type: "convert", row: r })
                              }
                            >
                              <ShoppingCart className="h-4 w-4 text-green-600" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Imprimir orçamento (PDF)"
                            onClick={() => handlePrint(r)}
                          >
                            <FileDown className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Editar"
                              disabled={busyId !== null}
                              onClick={() => handleEdit(r)}
                            >
                              {busyId === r.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Pencil className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          {editable && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Cancelar orçamento"
                              disabled={busyId !== null}
                              onClick={() => handleCancel(r)}
                            >
                              <Ban className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          )}
                          {r.status !== "CONVERTIDO" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Excluir"
                              onClick={() =>
                                setConfirm({ type: "delete", row: r })
                              }
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
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

      <BudgetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialData={editing}
        sellers={sellers}
        onToast={onToast}
        onSaved={() => {
          fetchList();
          onChanged?.();
        }}
      />

      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.type === "convert"
                ? "Converter em venda"
                : "Excluir orçamento"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.type === "convert"
                ? "Isto cria uma Conta a Receber (venda balcão) com o cliente e os itens deste orçamento. O orçamento fica marcado como Convertido. Não pode ser desfeito."
                : "Tem certeza que deseja excluir este orçamento? Essa ação não pode ser desfeita."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return;
                if (confirm.type === "convert") handleConvert(confirm.row);
                else handleDelete(confirm.row);
              }}
            >
              {confirm?.type === "convert" ? "Converter" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
