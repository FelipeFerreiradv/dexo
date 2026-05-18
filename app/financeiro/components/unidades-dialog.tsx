"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2, Pencil, Plus, X, Check } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getApiBaseUrl } from "@/lib/api";

interface Unidade {
  id: string;
  name: string;
  code: string | null;
  notes: string | null;
  active: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
}

export function UnidadesDialog({
  open,
  onOpenChange,
  onToast,
  onChanged,
}: Props) {
  const { data: session } = useSession();
  const [unidades, setUnidades] = useState<Unidade[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const email = session?.user?.email;

  const fetchUnidades = useCallback(async () => {
    if (!email) return;
    setLoading(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/unidades?all=1`, {
        headers: { email },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao listar unidades");
      setUnidades(Array.isArray(data.unidades) ? data.unidades : []);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao listar unidades", "error");
    } finally {
      setLoading(false);
    }
  }, [email, onToast]);

  useEffect(() => {
    if (open) {
      fetchUnidades();
      setEditId(null);
      setNewName("");
      setNewCode("");
      setNewNotes("");
    }
  }, [open, fetchUnidades]);

  const handleCreate = async () => {
    if (!email) return;
    if (newName.trim().length < 2) {
      onToast("Nome da unidade é obrigatório (mín. 2 caracteres)", "warning");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/unidades`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({
          name: newName.trim(),
          code: newCode.trim() || null,
          notes: newNotes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao criar unidade");
      onToast("Unidade criada com sucesso!", "success");
      setNewName("");
      setNewCode("");
      setNewNotes("");
      await fetchUnidades();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao criar unidade", "error");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (u: Unidade) => {
    setEditId(u.id);
    setEditName(u.name);
    setEditCode(u.code ?? "");
    setEditNotes(u.notes ?? "");
  };

  const handleUpdate = async (id: string) => {
    if (!email) return;
    if (editName.trim().length < 2) {
      onToast("Nome da unidade é obrigatório (mín. 2 caracteres)", "warning");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/unidades/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({
          name: editName.trim(),
          code: editCode.trim() || null,
          notes: editNotes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao atualizar unidade");
      onToast("Unidade atualizada!", "success");
      setEditId(null);
      await fetchUnidades();
      onChanged?.();
    } catch (e) {
      onToast(
        e instanceof Error ? e.message : "Erro ao atualizar unidade",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (u: Unidade) => {
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/unidades/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({ active: !u.active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao alterar status");
      onToast(
        !u.active ? "Unidade reativada" : "Unidade inativada",
        "success",
      );
      await fetchUnidades();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao alterar status", "error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Unidades</DialogTitle>
          <DialogDescription>
            Filiais / lojas físicas usadas para segmentar contas a pagar e a
            receber. Inativar não apaga: contas históricas permanecem
            vinculadas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Novo */}
          <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-4">
            <p className="text-sm font-medium">Nova unidade</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Nome *
                </label>
                <Input
                  placeholder="Ex: Loja Centro"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Identificador
                </label>
                <Input
                  placeholder="Ex: CENTRO"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Observação / endereço
                </label>
                <Input
                  placeholder="Opcional"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleCreate} disabled={saving}>
                <Plus className="h-4 w-4" />
                Adicionar
              </Button>
            </div>
          </div>

          {/* Lista */}
          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
            {loading && (
              <div className="py-8 text-center">
                <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && unidades.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nenhuma unidade cadastrada.
              </div>
            )}
            {!loading &&
              unidades.map((u) => {
                const isEditing = editId === u.id;

                if (isEditing) {
                  return (
                    <div key={u.id} className="space-y-3 bg-muted/20 p-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1 sm:col-span-2">
                          <label className="text-xs font-medium text-muted-foreground">
                            Nome *
                          </label>
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="Nome da unidade"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            Identificador
                          </label>
                          <Input
                            value={editCode}
                            onChange={(e) => setEditCode(e.target.value)}
                            placeholder="Opcional"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            Observação / endereço
                          </label>
                          <Input
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            placeholder="Opcional"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditId(null)}
                        >
                          <X className="h-4 w-4" />
                          Cancelar
                        </Button>
                        <Button
                          size="sm"
                          disabled={saving}
                          onClick={() => handleUpdate(u.id)}
                        >
                          <Check className="h-4 w-4" />
                          Salvar
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={u.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            u.active
                              ? ""
                              : "text-muted-foreground line-through"
                          }`}
                        >
                          {u.name}
                        </span>
                        {u.code ? (
                          <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                            {u.code}
                          </span>
                        ) : null}
                      </div>
                      {u.notes ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {u.notes}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <div className="flex items-center gap-1.5">
                        <Switch
                          checked={u.active}
                          onCheckedChange={() => handleToggleActive(u)}
                          aria-label={
                            u.active
                              ? `Inativar ${u.name}`
                              : `Reativar ${u.name}`
                          }
                        />
                        <span className="hidden text-xs text-muted-foreground sm:inline">
                          {u.active ? "Ativa" : "Inativa"}
                        </span>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Editar"
                        onClick={() => startEdit(u)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
