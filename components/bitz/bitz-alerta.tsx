"use client";

import * as React from "react";
import { AlertTriangle, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ContagemDeAlertas } from "./bitz-alerta-catraca";

/**
 * A faixa de alerta dentro do painel — o outro lado do badge do mascote.
 *
 * ⭐ ELA MORA ABAIXO DO CABEÇALHO, e não na tela de boas-vindas, de propósito.
 * O badge chama; se o que ele prometeu só aparecesse no estado vazio, quem
 * clicasse com uma conversa aberta veria o ponto vermelho sumir sem nunca
 * descobrir o motivo. Aqui ele aparece de qualquer jeito.
 *
 * ⚠️ NÃO É UM DIAGNÓSTICO — é uma CHAMADA. Ela diz o número e oferece a
 * pergunta; quem responde de verdade é o `diagnostico_operacional`, com a lista,
 * o motivo de cada pendência e o caminho de conserto. Repetir aquilo aqui seria
 * um segundo lugar para a mesma verdade divergir.
 */

/** A pergunta que a faixa faz por ele. `problema` casa `diagnostico_operacional`. */
export const PERGUNTA_DO_ALERTA =
  "Quais problemas estão travando a minha operação agora?";

interface BitzAlertaProps {
  contagem: ContagemDeAlertas;
  onPerguntar: (texto: string) => void;
  onDispensar: () => void;
}

/** "61 vendas" / "1 venda" — plural na mão, que é o custo de não ter i18n. */
function frase(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function BitzAlerta({
  contagem,
  onPerguntar,
  onDispensar,
}: BitzAlertaProps) {
  const partes: string[] = [];
  if (contagem.pedidosTravados > 0) {
    partes.push(
      `${frase(contagem.pedidosTravados, "venda não virou pedido", "vendas não viraram pedido")} — o estoque delas não baixou`,
    );
  }
  if (contagem.contasCaidas > 0) {
    partes.push(
      frase(
        contagem.contasCaidas,
        "conta de marketplace está com a autorização caída",
        "contas de marketplace estão com a autorização caída",
      ),
    );
  }
  if (partes.length === 0) return null;

  return (
    <div className="shrink-0 px-3.5 pb-2">
      <div
        // `role="status"` e não `alert`: o leitor de tela anuncia quando puder,
        // sem interromper quem já está digitando uma pergunta.
        role="status"
        className={cn(
          "border-primary/40 bg-primary/10 flex items-start gap-2.5 rounded-2xl border px-3 py-2.5",
        )}
      >
        <AlertTriangle className="text-primary mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-xs leading-snug">
            {partes.join(". ")}.
          </p>
          <button
            type="button"
            onClick={() => {
              // Perguntar TAMBÉM dispensa: ele não só viu, ele agiu. Deixar o
              // badge aceso depois disso seria cobrar duas vezes pelo mesmo
              // aviso.
              onDispensar();
              onPerguntar(PERGUNTA_DO_ALERTA);
            }}
            className={cn(
              "text-primary mt-1.5 text-xs font-medium underline underline-offset-2",
              "focus-visible:ring-ring rounded focus-visible:ring-2 focus-visible:outline-none",
            )}
          >
            Ver o que travou
          </button>
        </div>
        <button
          type="button"
          onClick={onDispensar}
          aria-label="Dispensar aviso"
          title="Dispensar — só volta se algum número subir"
          className={cn(
            "text-muted-foreground hover:text-foreground -mr-1 shrink-0 rounded-full p-1",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
