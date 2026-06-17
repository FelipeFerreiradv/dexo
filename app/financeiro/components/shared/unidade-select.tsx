"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";

export interface UnidadeOption {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
}

// Sentinelas (Radix Select não aceita value=""):
const NONE = "__none__"; // formulário: conta sem unidade
const ALL = "__all__"; // filtro: todas as unidades (sem parâmetro)
const SEM = "__sem__"; // filtro: contas sem unidade (param "sem_unidade")

/**
 * Busca as unidades ativas do dataOwner. Falha em silêncio (lista vazia) —
 * se a migration ainda não foi aplicada ou a API responde erro, o Financeiro
 * continua 100% funcional sem unidades (zero regressão).
 */
export function useUnidades(refreshKey?: number) {
  const { data: session } = useSession();
  const [unidades, setUnidades] = useState<UnidadeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/unidades`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        setUnidades([]);
        return;
      }
      const data = await res.json();
      setUnidades(Array.isArray(data.unidades) ? data.unidades : []);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setUnidades([]);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.email]);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  return { unidades, loading, reload };
}

// ── Select usado no formulário de conta (a pagar/receber) ──
export function UnidadeSelect({
  value,
  onChange,
  disabled,
  refreshKey,
}: {
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  refreshKey?: number;
}) {
  const { unidades } = useUnidades(refreshKey);
  const current = value && value.length > 0 ? value : NONE;

  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder="Sem unidade" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Sem unidade</SelectItem>
        {unidades.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name}
            {u.code ? ` (${u.code})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Filtro usado no Financeiro (overview + listagens) ──
// value: undefined = todas | "sem_unidade" = sem unidade | <id> = uma unidade.
export function UnidadeFilter({
  value,
  onChange,
  refreshKey,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  refreshKey?: number;
}) {
  const { unidades } = useUnidades(refreshKey);
  const current =
    value === undefined ? ALL : value === "sem_unidade" ? SEM : value;

  return (
    <Select
      value={current}
      onValueChange={(v) =>
        onChange(v === ALL ? undefined : v === SEM ? "sem_unidade" : v)
      }
    >
      <SelectTrigger className="h-10 w-full sm:w-[210px] rounded-full border border-border/70 bg-muted/20">
        <SelectValue placeholder="Todas as unidades" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>Todas as unidades</SelectItem>
        <SelectItem value={SEM}>Sem unidade</SelectItem>
        {unidades.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name}
            {u.code ? ` (${u.code})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
