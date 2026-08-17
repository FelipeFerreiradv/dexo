"use client";

import { useCallback, useState } from "react";
import { useSession } from "next-auth/react";
import { ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api";
import {
  SALE_STAGES,
  deriveSaleStage,
  nextSaleStage,
  saleStageIndex,
  saleStageLabel,
} from "../../lib/sale-stage";

// BLOCO F — o estágio operacional numa célula de tabela.
//
// Duas ações no mesmo lugar, e a ordem importa: o CASO COMUM é avançar uma
// etapa, então ele é um clique direto; escolher qualquer etapa (voltar,
// pular) fica no menu. Um seletor de 11 opções para a ação que acontece 90%
// das vezes seria trabalho a mais em toda venda.
//
// O estágio NÃO GOVERNA nada — não trava receber, estornar nem emitir nota.
// Aqui não há nenhuma guarda por isso: é informação de pátio.

interface Props {
  receivableId: string;
  saleStage: string | null | undefined;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  /** Recarrega a lista após mover. */
  onChanged?: () => void;
}

export function SaleStageCell({
  receivableId,
  saleStage,
  onToast,
  onChanged,
}: Props) {
  const { data: session } = useSession();
  const [salvando, setSalvando] = useState(false);
  // Estágio otimista: a etapa aparece movida na hora e a lista recarrega
  // depois. Sem isso, o operador clica e fica 300 ms sem retorno numa ação que
  // ele vai repetir dezenas de vezes por dia.
  const [local, setLocal] = useState<string | null>(null);

  const atual = deriveSaleStage(local ?? saleStage);
  const proximo = nextSaleStage(atual);
  const indice = saleStageIndex(atual);

  const mover = useCallback(
    async (destino: string) => {
      const email = session?.user?.email;
      if (!email || salvando) return;
      const anterior = local;
      setSalvando(true);
      setLocal(destino);
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/finance/receivables/${receivableId}/stage`,
          {
            method: "PATCH",
            headers: { email, "Content-Type": "application/json" },
            body: JSON.stringify({ saleStage: destino }),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}) as any);
          throw new Error(data?.error || "Erro ao mover o estágio");
        }
        onChanged?.();
      } catch (e) {
        // Desfaz o otimismo: mostrar a etapa movida quando ela não moveu é
        // pior que não mostrar nada — o operador seguiria o processo em cima
        // de um estado que não existe.
        setLocal(anterior);
        onToast(e instanceof Error ? e.message : "Erro ao mover", "error");
      } finally {
        setSalvando(false);
      }
    },
    [receivableId, session?.user?.email, salvando, local, onToast, onChanged],
  );

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={salvando}
            title="Escolher etapa"
            className={cn(
              "inline-flex max-w-[150px] items-center gap-1 truncate rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-muted/70",
              salvando && "opacity-60",
            )}
          >
            {salvando && <Loader2 className="h-3 w-3 animate-spin" />}
            {/* Posição no pipeline: "3/11" responde "falta muito?" sem obrigar
                o operador a decorar a ordem das etapas. */}
            {indice >= 0 && (
              <span className="font-mono text-[10px] tabular-nums opacity-70">
                {indice + 1}/{SALE_STAGES.length}
              </span>
            )}
            <span className="truncate">{saleStageLabel(atual)}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Etapa da venda
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SALE_STAGES.map((s, i) => (
            <DropdownMenuItem
              key={s.code}
              disabled={s.code === atual}
              onSelect={() => void mover(s.code)}
            >
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <span className="flex flex-col">
                <span>{s.label}</span>
                {s.hint && (
                  <span className="text-[11px] text-muted-foreground">
                    {s.hint}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Avançar uma etapa: o caso comum, num clique. Some no último estágio —
          botão que não faz nada é pior que botão ausente. */}
      {proximo && (
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={salvando}
          title={`Avançar para ${saleStageLabel(proximo)}`}
          onClick={() => void mover(proximo)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
