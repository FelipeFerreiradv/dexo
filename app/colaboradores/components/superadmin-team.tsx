"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { UserPlus, Users2, KeyRound, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authHeaders, getApiBaseUrl } from "@/lib/api";
import { SectionHeading } from "@/components/section-heading";
import { MLConnectScriptDialog } from "./ml-connect-script-dialog";
import {
  PagePermissionsToggles,
  pagePermsFromValue,
  type PagePerms,
} from "./page-permissions-toggles";

type SuperUser = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "USER" | "SUPERADMIN";
  parentUserId: string | null;
  isActive: boolean;
  defaultCostPrice: number | null;
  defaultStock: number | null;
  pagePermissions: Record<string, boolean> | null;
  createdAt: string;
};

type CreateRole = "ADMIN" | "USER";
type RoleFilter = "all" | "admin" | "collaborator";

export function SuperadminTeam() {
  const { data: session } = useSession();
  const [users, setUsers] = useState<SuperUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [error, setError] = useState<string | null>(null);

  // Modal de criação
  const [createOpen, setCreateOpen] = useState(false);
  const [role, setRole] = useState<CreateRole>("ADMIN");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [defaultCostPrice, setDefaultCostPrice] = useState("");
  const [defaultStock, setDefaultStock] = useState("");
  const [parentUserId, setParentUserId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Diálogo do gerador de script ML (Entrega D)
  const [scriptTarget, setScriptTarget] = useState<SuperUser | null>(null);

  // Diálogo de permissões por página de um colaborador (Entrega C, via superadmin)
  const [permsTarget, setPermsTarget] = useState<SuperUser | null>(null);
  const [permsValue, setPermsValue] = useState<PagePerms>(() =>
    pagePermsFromValue(null),
  );
  const [permsSaving, setPermsSaving] = useState(false);

  const openPerms = (kid: SuperUser) => {
    setPermsValue(pagePermsFromValue(kid.pagePermissions));
    setPermsTarget(kid);
  };

  const handleSavePerms = async () => {
    if (!session?.user?.email || !permsTarget) return;
    setPermsSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/superadmin/users/${permsTarget.id}`,
        {
          method: "PATCH",
          headers: authHeaders(session, { "content-type": "application/json" }),
          body: JSON.stringify({ pagePermissions: permsValue }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao salvar permissões");
      setPermsTarget(null);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar permissões");
    } finally {
      setPermsSaving(false);
    }
  };

  const loadUsers = useCallback(async () => {
    if (!session?.user?.email) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/superadmin/users`, {
        headers: authHeaders(session),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao carregar usuários");
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao carregar usuários");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // Administradores (top-level) — usados no seletor de "pai" ao criar colaborador.
  const admins = useMemo(() => users.filter((u) => !u.parentUserId), [users]);

  // Nome/e-mail do admin pai por id (p/ exibir "vinculado a ..." no colaborador).
  const parentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) {
      if (!u.parentUserId) map.set(u.id, u.name || u.email);
    }
    return map;
  }, [users]);

  // Lista filtrada por busca (nome/e-mail) + tipo (admin/colaborador).
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((u) => {
      const isAdmin = !u.parentUserId;
      if (roleFilter === "admin" && !isAdmin) return false;
      if (roleFilter === "collaborator" && isAdmin) return false;
      if (!term) return true;
      return (
        (u.name ?? "").toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term)
      );
    });
  }, [users, search, roleFilter]);

  const resetForm = () => {
    setName("");
    setEmail("");
    setPassword("");
    setDefaultCostPrice("");
    setDefaultStock("");
    setParentUserId("");
  };

  const openCreateAdmin = () => {
    resetForm();
    setRole("ADMIN");
    setCreateOpen(true);
  };
  const openCreateCollaborator = (adminId: string) => {
    resetForm();
    setRole("USER");
    setParentUserId(adminId);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!session?.user?.email) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        email: email.trim(),
        password,
        role,
      };
      if (defaultCostPrice.trim() !== "") {
        body.defaultCostPrice = Number(defaultCostPrice);
      }
      if (defaultStock.trim() !== "") {
        body.defaultStock = Number(defaultStock);
      }
      if (role === "USER" && parentUserId) {
        body.parentUserId = parentUserId;
      }

      const res = await fetch(`${getApiBaseUrl()}/superadmin/users`, {
        method: "POST",
        headers: authHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Erro ao criar usuário");

      setCreateOpen(false);
      resetForm();
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar usuário");
    } finally {
      setSaving(false);
    }
  };

  const label = (u: SuperUser) => u.name || u.email;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading
          eyebrow="Equipe Dexo · Superadmin"
          title="Equipe Dexo"
          description="Crie administradores e usuários com os campos padrão, e gere o script de conexão do Mercado Livre."
        />
        <Button onClick={openCreateAdmin}>
          <UserPlus className="mr-2 h-4 w-4" />
          Novo administrador
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Busca + filtro por tipo (vê TODOS os usuários) */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou e-mail…"
            className="pl-9"
          />
        </div>
        <Select
          value={roleFilter}
          onValueChange={(v) => setRoleFilter(v as RoleFilter)}
        >
          <SelectTrigger className="sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os usuários</SelectItem>
            <SelectItem value="admin">Administradores</SelectItem>
            <SelectItem value="collaborator">Colaboradores</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando usuários…
        </div>
      ) : (
        <Card>
          <CardContent className="p-3">
            <div className="space-y-2">
              {filtered.map((u) => {
                const isAdmin = !u.parentUserId;
                const roleLabel =
                  u.role === "SUPERADMIN"
                    ? "Superadmin"
                    : isAdmin
                      ? "Administrador"
                      : "Colaborador";
                return (
                  <div
                    key={u.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{label(u)}</span>
                        <Badge
                          variant={
                            u.role === "SUPERADMIN"
                              ? "default"
                              : isAdmin
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {roleLabel}
                        </Badge>
                        {!u.isActive && (
                          <Badge variant="destructive">Bloqueado</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {u.email}
                        {!isAdmin &&
                        u.parentUserId &&
                        parentNameById.get(u.parentUserId)
                          ? ` · vinculado a ${parentNameById.get(u.parentUserId)}`
                          : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {u.role === "ADMIN" && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openCreateCollaborator(u.id)}
                          >
                            <Users2 className="mr-2 h-4 w-4" />
                            Novo colaborador
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setScriptTarget(u)}
                          >
                            <KeyRound className="mr-2 h-4 w-4" />
                            Gerar script ML
                          </Button>
                        </>
                      )}
                      {!isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openPerms(u)}
                        >
                          Permissões
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="p-2 text-sm text-muted-foreground">
                  {users.length === 0
                    ? "Nenhum usuário cadastrado ainda."
                    : "Nenhum usuário encontrado para o filtro atual."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal de criação */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {role === "ADMIN" ? "Novo administrador" : "Novo colaborador"}
            </DialogTitle>
            <DialogDescription>
              Preencha os dados do usuário. Os campos padrão são opcionais.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Perfil</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as CreateRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">Administrador</SelectItem>
                  <SelectItem value="USER">Colaborador</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {role === "USER" && (
              <div className="space-y-1.5">
                <Label>Administrador responsável</Label>
                <Select value={parentUserId} onValueChange={setParentUserId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o administrador" />
                  </SelectTrigger>
                  <SelectContent>
                    {admins
                      .filter((a) => a.role !== "SUPERADMIN")
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {label(a)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="su-name">Nome</Label>
              <Input
                id="su-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="su-email">E-mail</Label>
              <Input
                id="su-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="su-password">Senha (mín. 8 caracteres)</Label>
              <Input
                id="su-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="su-cost">Preço de custo padrão</Label>
                <Input
                  id="su-cost"
                  type="number"
                  step="0.01"
                  value={defaultCostPrice}
                  onChange={(e) => setDefaultCostPrice(e.target.value)}
                  placeholder="0,00"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-stock">Estoque padrão</Label>
                <Input
                  id="su-stock"
                  type="number"
                  value={defaultStock}
                  onChange={(e) => setDefaultStock(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Salvando…
                </>
              ) : (
                "Criar"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Gerador de script ML (Entrega D) */}
      {scriptTarget && (
        <MLConnectScriptDialog
          open={!!scriptTarget}
          onOpenChange={(o) => !o && setScriptTarget(null)}
          userId={scriptTarget.id}
          userLabel={label(scriptTarget)}
        />
      )}

      {/* Permissões por página de um colaborador (Entrega C via superadmin) */}
      <Dialog
        open={!!permsTarget}
        onOpenChange={(o) => !o && setPermsTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permissões de acesso</DialogTitle>
            <DialogDescription>
              {permsTarget ? label(permsTarget) : ""} — desligue as páginas que
              este colaborador não deve ver.
            </DialogDescription>
          </DialogHeader>
          <PagePermissionsToggles
            value={permsValue}
            onChange={setPermsValue}
            disabled={permsSaving}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPermsTarget(null)}
              disabled={permsSaving}
            >
              Cancelar
            </Button>
            <Button onClick={handleSavePerms} disabled={permsSaving}>
              {permsSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Salvando…
                </>
              ) : (
                "Salvar permissões"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
