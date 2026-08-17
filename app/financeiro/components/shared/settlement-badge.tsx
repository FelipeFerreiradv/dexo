"use client";

import { useCallback, useState } from "react";
import { useSession } from "next-auth/react";
import { Clock, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import { hasPendingSettlement } from "../../lib/settlement";

// BLOCO A (2ª metade) — o selo "a liquidar" e a confirmação de um clique.
//
// SÓ APARECE QUANDO HÁ ALGO A CAIR. Uma venda no PIX não ganha selo nenhum —
// marcar "liquidado" em tudo que já liquidou sozinho seria criar uma fila de
// trabalho para confirmar o óbvio, e fila que ninguém percorre vira número
// errado do outro lado.
//
// A confirmação é otimista com desfazer: o operador está conferindo extrato e
// vai clicar em vários seguidos; esperar o servidor a cada clique tornaria a
// conferência mais lenta que a planilha que ela substitui.

interface Props {
  receivableId: string;
  status: string | null | undefined;
  paidAt: string | Date | null | undefined;
  paymentMethod: string | null | undefined;
  settledAt: string | Date | null | undefined;
  payments?: { method: string; amount: number; settledAt?: string | null }[];
  totalAmount: number;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
}

export function SettlementBadge({
  receivableId,
  status,
  paidAt,
  paymentMethod,
  settledAt,
  payments,
  totalAmount,
  onToast,
  onChanged,
}: Props) {
  const { data: session } = useSession();
  const [salvando, setSalvando] = useState(false);
  // `true` assim que o operador confirma — some o selo na hora.
  const [confirmadoLocal, setConfirmadoLocal] = useState(false);

  const pendente =
    !confirmadoLocal &&
    hasPendingSettlement(
      { status, paidAt, paymentMethod, settledAt },
      payments,
      totalAmount,
    );

  const confirmar = useCallback(async () => {
    const email = session?.user?.email;
    if (!email || salvando) return;
    setSalvando(true);
    setConfirmadoLocal(true);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/finance/receivables/${receivableId}/settlement`,
        {
          method: "PATCH",
          headers: { email, "Content-Type": "application/json" },
          body: JSON.stringify({ settled: true }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}) as any);
        throw new Error(d?.error || "Erro ao confirmar");
      }
      onToast("Recebimento confirmado na conta.", "success");
      onChanged?.();
    } catch (e) {
      // Desfaz o otimismo: um selo que sumiu sem a escrita ter acontecido faria
      // o operador dar a conferência por concluída sobre um estado que não
      // existe.
      setConfirmadoLocal(false);
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setSalvando(false);
    }
  }, [receivableId, salvando, session?.user?.email, onToast, onChanged]);

  if (!pendente) return null;

  return (
    <button
      type="button"
      disabled={salvando}
      onClick={() => void confirmar()}
      title="O dinheiro ainda não caiu. Clique para confirmar que entrou na conta."
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 transition hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200",
        salvando && "opacity-60",
      )}
    >
      {salvando ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      a liquidar
    </button>
  );
}
