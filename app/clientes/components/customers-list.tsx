"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
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
import { getApiBaseUrl } from "@/lib/api";
import { maskCpf, maskPhone } from "@/app/lib/masks";
import { CustomerDialog } from "./customer-dialog";
import type { CustomerFormData } from "../lib/customer-schema";

interface CustomerRow {
  id: string;
  name: string;
  cpf: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  city: string | null;
  state: string | null;
  createdAt: string;
  [key: string]: any;
}

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

const LIMIT = 20;

export function CustomersList() {
  const { data: session } = useSession();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<
    (Partial<CustomerFormData> & { id?: string }) | undefined
  >(undefined);
  const [deleteTarget, setDeleteTarget] = useState<CustomerRow | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "warning") => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36);
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchCustomers = useCallback(async () => {
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
      const res = await fetch(`${getApiBaseUrl()}/customers?${params}`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("Erro ao buscar clientes");
      const data = await res.json();
      setCustomers(data.customers || []);
      setTotal(data.pagination?.total || 0);
      setTotalPages(data.pagination?.totalPages || 1);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      showToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [session?.user?.email, page, searchTerm, showToast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const handleEdit = (c: CustomerRow) => {
    setEditing({
      id: c.id,
      ...(c as any),
    });
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const email = session?.user?.email;
    if (!email) return;
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/customers/${deleteTarget.id}`,
        {
          method: "DELETE",
          headers: { email },
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao excluir cliente");
      showToast("Cliente excluído com sucesso", "success");
      setDeleteTarget(null);
      fetchCustomers();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro ao excluir", "error");
    }
  };

  return (
    <div className="space-y-6">
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
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
      </div>

      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Clientes
            </CardTitle>
            <CardDescription>
              {total} cliente{total === 1 ? "" : "s"} cadastrado
              {total === 1 ? "" : "s"}.
            </CardDescription>
          </div>
          <Button onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            Novo cliente
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome, CPF, e-mail ou telefone..."
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
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Cidade/UF</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.length === 0 && !loading && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-8 text-muted-foreground"
                    >
                      Nenhum cliente encontrado. Crie o primeiro cadastro.
                    </TableCell>
                  </TableRow>
                )}
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>{c.cpf ? maskCpf(c.cpf) : "—"}</TableCell>
                    <TableCell>{c.email || "—"}</TableCell>
                    <TableCell>
                      {c.mobile ? maskPhone(c.mobile) : c.phone ? maskPhone(c.phone) : "—"}
                    </TableCell>
                    <TableCell>
                      {c.city ? `${c.city}${c.state ? "/" + c.state : ""}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEdit(c)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteTarget(c)}
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

      <CustomerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialData={editing}
        onToast={showToast}
        onSaved={fetchCustomers}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir cliente</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir {deleteTarget?.name}? Essa ação não
              pode ser desfeita.
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
    </div>
  );
}
