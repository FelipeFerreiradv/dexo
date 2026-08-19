"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { UserRound } from "lucide-react";

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
  NO_SELLER,
  sellerLabel,
  sellerSelectValueToId,
  type SellerOption,
} from "../../lib/sale-seller";

// BLOCO B — quem VENDEU.
//
// Não é a mesma pergunta que "quem operou": no balcão o caixa frequentemente
// lança a venda do balconista, e a comissão é de quem vendeu. Por isso o campo
// existe além do autor que a timeline já registra.
//
// O seletor NASCE PREENCHIDO com quem está logado (decisão de produto): zero
// fricção para quem vende o próprio, um clique para o caixa que lança de
// outro. A lista é o dono do tenant + todo colaborador ATIVO, sem configuração
// prévia — mesma semântica das permissões da casa, cujo default é permitir
// justamente para não regredir.

interface Props {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  /**
   * Pré-selecionar quem está logado quando o campo vier vazio. `true` na
   * CRIAÇÃO; `false` na edição — ali, campo vazio significa "esta venda não
   * tem vendedor", e preencher sozinho atribuiria comissão a quem só abriu a
   * tela para conferir.
   */
  autoSelectMe?: boolean;
}

export function SellerSelect({
  value,
  onChange,
  disabled,
  autoSelectMe,
}: Props) {
  const { data: session } = useSession();
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  // Só pré-seleciona UMA vez: se o operador escolher "Sem vendedor" de
  // propósito, o efeito não pode desfazer a escolha na próxima renderização.
  const preSelecionado = useRef(false);

  useEffect(() => {
    const email = session?.user?.email;
    if (!email) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/me/team/sellers`, {
          headers: { email },
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        const lista = (data?.sellers ?? []) as SellerOption[];
        setSellers(lista);

        if (!autoSelectMe || preSelecionado.current || value) return;
        // "Eu" é resolvido pelo E-MAIL da sessão contra a lista do servidor.
        // O id do usuário não está na sessão do cliente de forma confiável, e
        // casar por e-mail é exato — ele é único no schema.
        const eu = lista.find(
          (s) => s.email && s.email.toLowerCase() === email.toLowerCase(),
        );
        if (eu) {
          preSelecionado.current = true;
          onChange(eu.id);
        }
      } catch {
        // Silencioso: o vendedor é opcional e não pode derrubar a venda.
      }
    })();
    return () => ctrl.abort();
    // `value` e `onChange` de propósito fora das deps: o efeito é de CARGA, e
    // reexecutá-lo a cada digitação do formulário refaria o request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.email, autoSelectMe]);

  // O vendedor JÁ GRAVADO entra na lista mesmo que não esteja mais ativa —
  // colaborador desligado depois da venda continua sendo quem vendeu. Sem
  // isto, abrir a venda mostraria "Sem vendedor" e salvar apagaria o registro.
  const opcoes: SellerOption[] =
    value && !sellers.some((s) => s.id === value)
      ? [{ id: value, name: "Vendedor anterior", email: null }, ...sellers]
      : sellers;

  return (
    <div className="space-y-2">
      <Label htmlFor="finance-seller" className="flex items-center gap-1.5">
        <UserRound className="size-3.5 text-muted-foreground" />
        Vendedor
      </Label>
      <Select
        value={value ?? NO_SELLER}
        onValueChange={(v) => onChange(sellerSelectValueToId(v))}
        disabled={disabled}
      >
        <SelectTrigger id="finance-seller">
          <SelectValue placeholder="Sem vendedor" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SELLER}>Sem vendedor</SelectItem>
          {opcoes.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {sellerLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
