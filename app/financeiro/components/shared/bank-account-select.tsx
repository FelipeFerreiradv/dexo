"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Landmark } from "lucide-react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import {
  NO_BANK_ACCOUNT,
  bankAccountLabel,
  bankAccountSelectValueToId,
  type BankAccountRef,
} from "../../lib/bank-accounts";

// BLOCO A — seletor de conta bancária / caixa.
//
// Espelha `unidade-select.tsx`, que é o desenho da casa: hook de carga +
// componente de formulário, com falha SILENCIOSA (lista vazia). O motivo do
// silêncio é o mesmo de lá: se o DDL ainda não rodou ou a API responde erro, o
// Financeiro tem de continuar 100% funcional — a conta é um enriquecimento, e
// nenhum lançamento pode deixar de ser feito por causa dela.
//
// A rota devolve `{accounts: []}` com a flag desligada, então nem é preciso
// checar flag aqui: sem contas, o seletor some sozinho.

export interface BankAccountOption extends BankAccountRef {
  id: string;
  name: string;
  isDefault?: boolean;
}

export function useBankAccounts(refreshKey?: number) {
  const { data: session } = useSession();
  const [accounts, setAccounts] = useState<BankAccountOption[]>([]);
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
      const res = await fetch(`${getApiBaseUrl()}/bank-accounts`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        setAccounts([]);
        return;
      }
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.email]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  return { accounts, loading, reload };
}

interface Props {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  label?: string;
  /**
   * Pré-selecionar a conta PADRÃO quando o campo vier vazio. `true` na
   * CRIAÇÃO; `false` na edição — ali, campo vazio significa "este lançamento
   * não tem conta", e preencher sozinho reescreveria o histórico de um
   * lançamento que alguém só abriu para conferir.
   */
  autoSelectDefault?: boolean;
  refreshKey?: number;
}

export function BankAccountSelect({
  value,
  onChange,
  disabled,
  label = "Conta / caixa",
  autoSelectDefault,
  refreshKey,
}: Props) {
  const { accounts } = useBankAccounts(refreshKey);
  // Só pré-seleciona UMA vez: se o operador escolher "Não informar" de
  // propósito, o efeito não pode desfazer a escolha na próxima renderização.
  const preSelecionado = useRef(false);

  useEffect(() => {
    if (!autoSelectDefault || preSelecionado.current || value) return;
    const padrao = accounts.find((c) => c.isDefault);
    if (padrao) {
      preSelecionado.current = true;
      onChange(padrao.id);
    }
    // `onChange` fora das deps: recriá-lo a cada render do formulário
    // reexecutaria o efeito e brigaria com a escolha do operador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, autoSelectDefault, value]);

  // Sem conta cadastrada, o campo não aparece: um seletor com uma opção só
  // ("Não informar") é ruído puro no formulário.
  if (accounts.length === 0 && !value) return null;

  // A conta JÁ GRAVADA entra na lista mesmo desativada — lançamento antigo
  // continua tendo acontecido naquela conta. Sem isto, abrir o lançamento
  // mostraria "não informado" e salvar APAGARIA o vínculo.
  const opcoes: BankAccountOption[] =
    value && !accounts.some((c) => c.id === value)
      ? [{ id: value, name: "Conta desativada" }, ...accounts]
      : accounts;

  return (
    <div className="space-y-2">
      <Label
        htmlFor="finance-bank-account"
        className="flex items-center gap-1.5"
      >
        <Landmark className="size-3.5 text-muted-foreground" />
        {label}
      </Label>
      <Select
        value={value ?? NO_BANK_ACCOUNT}
        onValueChange={(v) => onChange(bankAccountSelectValueToId(v))}
        disabled={disabled}
      >
        <SelectTrigger id="finance-bank-account">
          <SelectValue placeholder="Não informar" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_BANK_ACCOUNT}>Não informar</SelectItem>
          {opcoes.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {bankAccountLabel(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
