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

interface FinanceRow {
  id: string;
  document: string | null;
  reason: string | null;
  totalAmount: number;
  installments: number;
  dueDate: string;
  status: "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";
  customer: { id: string; name: string; cpf: string | null } | null;
}

interface Props {
  kind: FinanceKind;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
}

const LIMIT = 20;

const STATUS_STYLES: Record<FinanceRow["status"], string> = {
  PENDENTE: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  PAGA: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  VENCIDA: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  CANCELADA: "bg-muted text-muted-foreground",
};

export function FinanceList({ kind, onToast, onChanged }: Props) {
  const { data: session } = useSession();
  const [rows, setRows] = useState<FinanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] =
    useState<
      | (Partial<FinanceEntryFormData> & {
          id?: string;
          customer?: { id: string; name: string; cpf: string | null } | null;
        })
      | undefined
    >(undefined);
  const [deleteTarget, setDeleteTarget] = useState<FinanceRow | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const basePath =
    kind === "receivable" ? "/finance/receivables" : "/finance/payables";
  const label = kind === "receivable" ? "a receber" : "a pagar";

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

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
  }, [session?.user?.email, page, searchTerm, basePath, onToast]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const handleCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const handleEdit = (r: FinanceRow) => {
    setEditing({
      id: r.id,
      customerId: r.customer?.id || "",
      customer: r.customer,
      document: r.document,
      reason: r.reason,
      totalAmount: r.totalAmount,
      installments: r.installments,
      dueDate: r.dueDate?.slice(0, 10),
    });
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
        <CardHeader className="flex flex-row items-start justify-between gap-4">
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
          <div className="relative max-w-md">
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

          <div className="rounded-xl border border-border/70 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Documento</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Parcelas</TableHead>
                  <TableHead>Vencimento</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
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
                    <TableCell>R$ {formatToBRL(r.totalAmount)}</TableCell>
                    <TableCell>{r.installments}x</TableCell>
                    <TableCell>
                      {r.dueDate
                        ? new Date(r.dueDate).toLocaleDateString("pt-BR")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
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
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEdit(r)}
                        >
                          <Pencil className="h-4 w-4" />
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
              Tem certeza que deseja excluir este título? Essa ação não pode
              ser desfeita.
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
