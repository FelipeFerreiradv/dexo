"use client";

import * as React from "react";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBitzMemorias } from "@/hooks/use-bitz-memorias";

/**
 * "O que eu sei da sua loja" — a memória, aberta. Fase 11.
 *
 * ⭐ ESTA TELA É A CONTRAPARTIDA DE EXISTIR MEMÓRIA. Um agente que guarda coisas
 * sobre o seu negócio e não te mostra quais é uma caixa-preta crescendo dentro
 * do seu banco. Aqui está tudo, com o texto integral, na ordem em que foi
 * ensinado, e cada linha tem uma lixeira.
 *
 * ⛔ E ISTO NÃO FURA "O BITZ NÃO APAGA": quem apaga é o administrador, com o
 * dedo dele, e o que some é uma anotação do próprio agente — não peça, não
 * pedido, não cliente. Não existe ferramenta de esquecer, e pedir por escrito no
 * chat não apaga nada.
 *
 * ⚠️ SOBREPÕE O PAINEL em vez de abrir outro diálogo. Um `Dialog` dentro do
 * `Dialog` do Bitz brigaria por foco e por `z-index` com o cartão de ação e com
 * os toasts — e o Radix desmonta o conteúdo ao fechar, o que já custou um bug
 * nesta mesma fase do projeto (o cartão ressuscitava como pendente).
 */
export function BitzMemorias({ onFechar }: { onFechar: () => void }) {
  const { memorias, estado, erro, apagando, apagar } = useBitzMemorias(true);

  return (
    <div className="bg-background/95 absolute inset-0 z-10 flex flex-col backdrop-blur-sm">
      <header className="relative flex shrink-0 items-center gap-2.5 px-3.5 py-3">
        <div
          aria-hidden
          className="via-border absolute inset-x-3 bottom-0 h-px bg-gradient-to-r from-transparent to-transparent"
        />
        <button
          type="button"
          onClick={onFechar}
          aria-label="Voltar para a conversa"
          className="text-muted-foreground hover:text-foreground hover:bg-muted/60 grid size-8 shrink-0 place-items-center rounded-full transition-colors"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-semibold">
            O que eu sei da sua loja
          </p>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            Vale para toda a equipe, em toda conversa
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {estado === "carregando" && (
          <p className="text-muted-foreground flex items-center gap-2 py-8 text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            Carregando…
          </p>
        )}

        {erro && (
          <p className="text-destructive border-destructive/30 bg-destructive/5 mb-3 rounded-xl border px-3 py-2 text-xs">
            {erro}
          </p>
        )}

        {estado === "pronto" && memorias.length === 0 && (
          <div className="py-8">
            <p className="text-foreground text-sm font-medium">
              Ainda não te ensinei nada.
            </p>
            {/* O vazio ensina a usar. Sem isto, o recurso existe e ninguém
                descobre que existe — ele não tem botão de "criar", nasce de uma
                frase no chat. */}
            <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
              Na conversa, diga coisas como{" "}
              <span className="text-foreground">
                “lembra que eu sempre anuncio as peças como usadas”
              </span>{" "}
              ou{" "}
              <span className="text-foreground">
                “guarda isso: meu markup padrão é 2,2x”
              </span>
              . Eu preparo um cartão e você confirma.
            </p>
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              Regra da casa, não número do dia: preço de peça, estoque e saldo eu
              consulto na hora — guardar isso viraria resposta desatualizada.
            </p>
          </div>
        )}

        <ul className="space-y-2">
          {memorias.map((m) => {
            const saindo = apagando.includes(m.id);
            return (
              <li
                key={m.id}
                className={cn(
                  "border-border/60 bg-card/70 flex items-start gap-2 rounded-2xl border px-3 py-2.5",
                  saindo && "opacity-50",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground font-mono text-[9px] tracking-[0.18em] uppercase">
                    {m.topicoLabel}
                  </p>
                  <p className="text-foreground mt-1 text-sm leading-snug break-words">
                    {m.conteudo}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={saindo}
                  onClick={() => void apagar(m.id)}
                  aria-label={`Esquecer: ${m.conteudo}`}
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:pointer-events-none"
                >
                  {saindo ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
