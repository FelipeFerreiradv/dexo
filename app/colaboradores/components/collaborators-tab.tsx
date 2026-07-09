"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FilterIcon,
  PencilIcon,
  SearchIcon,
  UserPlusIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/section-heading";
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
import { Switch } from "@/components/ui/switch";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { authHeaders, getApiBaseUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CollaboratorFormDialog } from "./collaborator-form-dialog";
import { TeamProductivity } from "./team-productivity";

type Collaborator = {
  id: string;
  name?: string | null;
  email: string;
  avatarUrl?: string | null;
  isActive?: boolean;
  pagePermissions?: Record<string, boolean> | null;
};

type Toast = {
  id: string;
  message: string;
  type: "success" | "error";
};

type ActivityLog = {
  id: string;
  userId?: string | null;
  user?: { id: string; name?: string | null; email: string } | null;
  action: string;
  resource?: string | null;
  resourceId?: string | null;
  level: "INFO" | "WARNING" | "ERROR";
  message: string;
  details?: any;
  createdAt: string;
};

const ACTION_LABELS: Record<string, string> = {
  LOGIN: "Login",
  LOGOUT: "Logout",
  CREATE_PRODUCT: "Criar produto",
  UPDATE_PRODUCT: "Atualizar produto",
  DELETE_PRODUCT: "Excluir produto",
  CREATE_LISTING: "Criar anúncio",
  UPDATE_LISTING: "Atualizar anúncio",
  DELETE_LISTING: "Excluir anúncio",
  CREATE_NFE_DRAFT: "Criar rascunho NF-e",
  UPDATE_NFE_DRAFT: "Atualizar rascunho NF-e",
  EMIT_NFE: "Emitir NF-e",
  CANCEL_NFE: "Cancelar NF-e",
  INUTILIZE_NFE: "Inutilizar NF-e",
  UPDATE_FISCAL_CONFIG: "Atualizar configuração fiscal",
  CREATE_CUSTOMER: "Criar cliente",
  UPDATE_CUSTOMER: "Atualizar cliente",
  DELETE_CUSTOMER: "Excluir cliente",
  CREATE_LOCATION: "Criar localização",
  UPDATE_LOCATION: "Atualizar localização",
  DELETE_LOCATION: "Excluir localização",
  CREATE_SCRAP: "Criar sucata",
  UPDATE_SCRAP: "Atualizar sucata",
  DELETE_SCRAP: "Excluir sucata",
  CREATE_PAYABLE: "Criar conta a pagar",
  UPDATE_PAYABLE: "Atualizar conta a pagar",
  DELETE_PAYABLE: "Excluir conta a pagar",
  CREATE_RECEIVABLE: "Criar conta a receber",
  UPDATE_RECEIVABLE: "Atualizar conta a receber",
  DELETE_RECEIVABLE: "Excluir conta a receber",
  SYNC_STOCK: "Sincronizar estoque",
  CONNECT_MARKETPLACE: "Conectar marketplace",
  DISCONNECT_MARKETPLACE: "Desconectar marketplace",
  USER_ACTIVITY: "Atividade",
};

function formatDate(value: string) {
  try {
    return format(new Date(value), "dd/MM/yyyy HH:mm:ss", { locale: ptBR });
  } catch {
    return value;
  }
}

function levelVariant(level: ActivityLog["level"]) {
  if (level === "ERROR") return "destructive" as const;
  if (level === "WARNING") return "secondary" as const;
  return "default" as const;
}

export function CollaboratorsTab() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? null;
  const apiToken = (session as { apiToken?: string } | null)?.apiToken;

  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [collaboratorId, setCollaboratorId] = useState<string>("ALL");
  const [actionFilter, setActionFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // Gestão de colaboradores (aditivo). Modal de criar/editar, confirmação de
  // desativação e toasts locais (mesmo padrão de budget-crm, sem lib nova).
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<Collaborator | null>(null);
  const [pendingDeactivate, setPendingDeactivate] =
    useState<Collaborator | null>(null);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

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
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const fetchData = useCallback(async () => {
    if (!email) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "50",
      });
      if (collaboratorId !== "ALL")
        params.set("collaboratorId", collaboratorId);
      if (actionFilter !== "ALL") params.set("action", actionFilter);
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);

      const apiBase = getApiBaseUrl();
      const res = await fetch(
        `${apiBase}/me/team/activity?${params.toString()}`,
        { headers: { email } },
      );
      if (!res.ok) {
        if (res.status === 403) {
          // Não deveria acontecer (page.tsx já redirect), mas defesa em profundidade.
          setLogs([]);
          setTotal(0);
          setTotalPages(0);
          return;
        }
        throw new Error(`Erro ${res.status}`);
      }
      const data = await res.json();
      setLogs(Array.isArray(data.logs) ? data.logs : []);
      // A lista de colaboradores (com isActive) vem de fetchCollaborators —
      // não sobrescrevemos aqui para não perder o estado ativo/inativo.
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 0);
    } catch (err) {
      console.error("[CollaboratorsTab] fetch error", err);
    } finally {
      setLoading(false);
    }
  }, [email, page, collaboratorId, actionFilter, startDate, endDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fonte da lista "Sua equipe" (inclui isActive). Separada da auditoria para
  // não depender dos filtros e sobreviver a re-buscas após criar/editar/status.
  const fetchCollaborators = useCallback(async () => {
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/me/team/collaborators`, {
        headers: authHeaders({ user: { email }, apiToken }),
      });
      if (!res.ok) return; // 403 defensivo — page.tsx já protege a rota.
      const data = await res.json();
      setCollaborators(
        Array.isArray(data.collaborators) ? data.collaborators : [],
      );
    } catch (err) {
      console.error("[CollaboratorsTab] fetchCollaborators error", err);
    }
  }, [email, apiToken]);

  useEffect(() => {
    fetchCollaborators();
  }, [fetchCollaborators]);

  // Ativa/desativa um colaborador. O corte da sessão ativa (≤60s) é feito pelo
  // backend (auth.middleware). Aqui só refletimos o novo estado após o PATCH.
  const applyStatus = useCallback(
    async (collab: Collaborator, isActive: boolean) => {
      setStatusBusyId(collab.id);
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/me/team/collaborators/${collab.id}/status`,
          {
            method: "PATCH",
            headers: authHeaders(
              { user: { email }, apiToken },
              { "Content-Type": "application/json" },
            ),
            body: JSON.stringify({ isActive }),
          },
        );
        if (!res.ok) {
          let message = "Não foi possível alterar o status.";
          try {
            const data = await res.json();
            if (data?.message) message = data.message;
          } catch {
            // sem corpo JSON — mantém a mensagem genérica.
          }
          showToast(message, "error");
          return;
        }
        showToast(
          isActive ? "Colaborador ativado." : "Colaborador desativado.",
          "success",
        );
        await fetchCollaborators();
      } catch {
        showToast("Erro de conexão ao alterar o status.", "error");
      } finally {
        setStatusBusyId(null);
      }
    },
    [email, apiToken, showToast, fetchCollaborators],
  );

  // Reset de página quando filtros mudam.
  useEffect(() => {
    setPage(1);
  }, [collaboratorId, actionFilter, startDate, endDate]);

  const visibleLogs = useMemo(() => {
    if (!debouncedSearch) return logs;
    const term = debouncedSearch.toLowerCase();
    return logs.filter((l) => {
      const author = (l.user?.name || l.user?.email || "").toLowerCase();
      return (
        l.message.toLowerCase().includes(term) ||
        author.includes(term) ||
        (l.resource ?? "").toLowerCase().includes(term)
      );
    });
  }, [logs, debouncedSearch]);

  const clearFilters = () => {
    setCollaboratorId("ALL");
    setActionFilter("ALL");
    setSearch("");
    setStartDate("");
    setEndDate("");
  };

  const openCreate = () => {
    setFormMode("create");
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (collab: Collaborator) => {
    setFormMode("edit");
    setEditing(collab);
    setFormOpen(true);
  };

  const handleFormSuccess = (message: string) => {
    showToast(message, "success");
    fetchCollaborators();
  };

  return (
    <div className="space-y-6">
      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeading
              eyebrow="Equipe · Membros"
              title="Sua"
              accent="equipe"
              description={
                collaborators.length === 0
                  ? "Nenhum colaborador vinculado à sua conta"
                  : `${collaborators.length} colaborador(es) vinculado(s) à sua conta`
              }
            />
            <Button
              onClick={openCreate}
              className="shrink-0 gap-2 rounded-full"
            >
              <UserPlusIcon className="h-4 w-4" />
              Novo colaborador
            </Button>
          </div>
        </CardHeader>
        {collaborators.length > 0 && (
          <CardContent>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {collaborators.map((c) => {
                const inactive = c.isActive === false;
                return (
                  <div
                    key={c.id}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border border-border/60 p-3",
                      inactive && "opacity-70",
                    )}
                  >
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full border border-border/60 bg-muted/30">
                      {c.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={c.avatarUrl}
                          alt={c.name || c.email}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-sm font-semibold">
                          {(c.name || c.email).slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {c.name || "—"}
                        </span>
                        {inactive && (
                          <Badge variant="secondary" className="shrink-0">
                            Inativo
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {c.email}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={c.isActive !== false}
                        disabled={statusBusyId === c.id}
                        aria-label={
                          inactive
                            ? "Ativar colaborador"
                            : "Desativar colaborador"
                        }
                        onCheckedChange={(checked) => {
                          if (checked) {
                            applyStatus(c, true);
                          } else {
                            setPendingDeactivate(c);
                          }
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Editar colaborador"
                        onClick={() => openEdit(c)}
                      >
                        <PencilIcon className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FilterIcon className="h-5 w-5" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-2 lg:col-span-2">
              <label className="text-sm font-medium">Buscar</label>
              <div className="relative">
                <SearchIcon className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Mensagem, recurso, autor..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-10 rounded-full border border-border/70 bg-muted/20 pl-9"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Colaborador</label>
              <Select value={collaboratorId} onValueChange={setCollaboratorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Todos</SelectItem>
                  {collaborators.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name || c.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Ação</label>
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Todas</SelectItem>
                  {Object.entries(ACTION_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:col-span-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">De</label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Até</label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="outline" onClick={clearFilters}>
              Limpar filtros
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bloco de produtividade (Entrega A) — aditivo, acima da auditoria. */}
      <TeamProductivity />

      <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <CardHeader>
          <CardTitle>Atividades</CardTitle>
          <CardDescription>
            {total > 0
              ? `${total} ação(ões) registrada(s).`
              : "Nenhuma ação registrada para os filtros atuais."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center text-muted-foreground">
              Carregando...
            </div>
          ) : visibleLogs.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              Nenhuma ação para exibir.
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Data/Hora</th>
                    <th className="px-3 py-2 font-medium">Colaborador</th>
                    <th className="px-3 py-2 font-medium">Ação</th>
                    <th className="px-3 py-2 font-medium">Recurso</th>
                    <th className="px-3 py-2 font-medium">Mensagem</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.map((log) => (
                    <tr
                      key={log.id}
                      className="border-b border-border/40 hover:bg-muted/20"
                    >
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                        {formatDate(log.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-sm font-medium">
                          {log.user?.name || log.user?.email || "—"}
                        </div>
                        {log.user?.name && log.user.email && (
                          <div className="text-xs text-muted-foreground">
                            {log.user.email}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={levelVariant(log.level)}>
                            {log.level}
                          </Badge>
                          <span className="text-xs">
                            {ACTION_LABELS[log.action] ?? log.action}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {log.resource ? (
                          <span className="rounded bg-muted/40 px-2 py-1">
                            {log.resource}
                            {log.resourceId
                              ? ` · ${log.resourceId.slice(0, 8)}`
                              : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-sm text-muted-foreground">
                        {log.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-2 border-t pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
              >
                <ChevronLeftIcon className="h-4 w-4" />
                Anterior
              </Button>
              <span className="text-sm text-muted-foreground">
                Página {page} de {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages || loading}
              >
                Próximo
                <ChevronRightIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <CollaboratorFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        mode={formMode}
        session={session}
        collaborator={editing}
        onSuccess={handleFormSuccess}
      />

      <AlertDialog
        open={pendingDeactivate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeactivate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar colaborador?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeactivate
                ? `${
                    pendingDeactivate.name || pendingDeactivate.email
                  } perderá o acesso à plataforma em até 60 segundos. Nenhum dado é apagado — você pode reativar quando quiser.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingDeactivate;
                setPendingDeactivate(null);
                if (target) applyStatus(target, false);
              }}
            >
              Desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ToastViewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
              t.type === "success"
                ? "bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-200"
                : "bg-destructive text-white",
            )}
          >
            {t.message}
          </div>
        ))}
      </ToastViewport>
    </div>
  );
}
