"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Check, Landmark, Loader2, Plus, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import {
  BANK_ACCOUNT_KINDS,
  DEFAULT_BANK_ACCOUNT_KIND,
  bankAccountKindLabel,
  bankAccountLabel,
} from "../lib/bank-accounts";

// BLOCO A — cadastro das contas bancárias / caixas do tenant.
//
// Espelha o `UnidadesDialog`, com uma diferença que não é estética: aqui NÃO
// EXISTE EXCLUIR. A conta é referenciada por lançamentos históricos, e apagá-la
// responderia "de onde saiu esse dinheiro?" com silêncio. Desativar tira do
// seletor e preserva o passado — é o que o backend oferece, e a tela não
// inventa um caminho que o backend recusaria.

interface Conta {
  id: string;
  name: string;
  bankName: string | null;
  agency: string | null;
  accountNumber: string | null;
  kind: string;
  isDefault: boolean;
  isActive: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
}

const VAZIO = {
  name: "",
  bankName: "",
  agency: "",
  accountNumber: "",
  kind: DEFAULT_BANK_ACCOUNT_KIND,
  isDefault: false,
};

export function BankAccountsDialog({
  open,
  onOpenChange,
  onToast,
  onChanged,
}: Props) {
  const { data: session } = useSession();
  const [contas, setContas] = useState<Conta[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState({ ...VAZIO });

  const carregar = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    setCarregando(true);
    try {
      // `all=1`: o cadastro mostra também as DESATIVADAS — é onde se reativa
      // uma conta, e escondê-las aqui deixaria a desativação sem volta.
      const res = await fetch(`${getApiBaseUrl()}/bank-accounts?all=1`, {
        headers: { email },
      });
      if (!res.ok) throw new Error("Erro ao carregar contas");
      const data = await res.json();
      setContas(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setCarregando(false);
    }
  }, [session?.user?.email, onToast]);

  useEffect(() => {
    if (open) void carregar();
  }, [open, carregar]);

  const criar = useCallback(async () => {
    const email = session?.user?.email;
    if (!email || salvando) return;
    setSalvando(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/bank-accounts`, {
        method: "POST",
        headers: { email, "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) throw new Error(data?.error || "Erro ao criar conta");
      onToast("Conta cadastrada.", "success");
      setForm({ ...VAZIO });
      await carregar();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setSalvando(false);
    }
  }, [form, salvando, session?.user?.email, carregar, onToast, onChanged]);

  const alterar = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      const email = session?.user?.email;
      if (!email || salvando) return;
      setSalvando(true);
      try {
        const res = await fetch(`${getApiBaseUrl()}/bank-accounts/${id}`, {
          method: "PATCH",
          headers: { email, "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}) as any);
        if (!res.ok) throw new Error(data?.error || "Erro ao atualizar");
        await carregar();
        onChanged?.();
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Erro", "error");
      } finally {
        setSalvando(false);
      }
    },
    [salvando, session?.user?.email, carregar, onToast, onChanged],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-4 w-4" />
            Contas e caixas
          </DialogTitle>
          <DialogDescription>
            Onde o dinheiro entra e de onde sai. A conta marcada como padrão vem
            sugerida ao lançar. Contas não são excluídas — desative para tirar
            do seletor sem perder o histórico.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── Cadastro ── */}
          <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ba-name">Nome</Label>
                <Input
                  id="ba-name"
                  placeholder="Itaú da loja, Caixa do balcão…"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ba-kind">Tipo</Label>
                <Select
                  value={form.kind}
                  onValueChange={(v) => setForm({ ...form, kind: v })}
                >
                  <SelectTrigger id="ba-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BANK_ACCOUNT_KINDS.map((k) => (
                      <SelectItem key={k.code} value={k.code}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Dados bancários só fazem sentido em conta de banco — caixa e
                carteira digital não têm agência. */}
            {form.kind === "BANCO" && (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ba-bank">Banco</Label>
                  <Input
                    id="ba-bank"
                    placeholder="Itaú"
                    value={form.bankName}
                    onChange={(e) =>
                      setForm({ ...form, bankName: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ba-agency">Agência</Label>
                  <Input
                    id="ba-agency"
                    value={form.agency}
                    onChange={(e) =>
                      setForm({ ...form, agency: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ba-number">Conta</Label>
                  <Input
                    id="ba-number"
                    value={form.accountNumber}
                    onChange={(e) =>
                      setForm({ ...form, accountNumber: e.target.value })
                    }
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.isDefault}
                  onCheckedChange={(v) => setForm({ ...form, isDefault: v })}
                />
                Sugerir esta conta ao lançar
              </label>
              <Button
                type="button"
                disabled={salvando || form.name.trim().length < 2}
                onClick={() => void criar()}
              >
                {salvando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Cadastrar
              </Button>
            </div>
          </div>

          {/* ── Lista ── */}
          {carregando && contas.length === 0 ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : contas.length === 0 ? (
            <p className="py-8 text-center font-mono text-xs text-muted-foreground">
              Nenhuma conta cadastrada ainda.
            </p>
          ) : (
            <ul className="space-y-2">
              {contas.map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2",
                    !c.isActive && "opacity-60",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {bankAccountLabel(c)}
                      {c.isDefault && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          <Star className="h-3 w-3" />
                          padrão
                        </span>
                      )}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {bankAccountKindLabel(c.kind)}
                      {c.agency || c.accountNumber
                        ? ` · ag. ${c.agency ?? "—"} / c. ${c.accountNumber ?? "—"}`
                        : ""}
                      {!c.isActive ? " · desativada" : ""}
                    </p>
                  </div>
                  {!c.isDefault && c.isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={salvando}
                      title="Sugerir esta conta ao lançar"
                      onClick={() => void alterar(c.id, { isDefault: true })}
                    >
                      <Star className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={salvando}
                    onClick={() =>
                      void alterar(c.id, { isActive: !c.isActive })
                    }
                  >
                    {c.isActive ? (
                      "Desativar"
                    ) : (
                      <>
                        <Check className="h-4 w-4" />
                        Reativar
                      </>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
