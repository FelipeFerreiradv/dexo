"use client";

import * as React from "react";
import { AlertTriangle, ArrowRight, Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBitzAcao, type BitzAcao } from "@/hooks/use-bitz-acao";

/**
 * O cartão de confirmação. Fase 9.
 *
 * ⭐ ELE É A CONFIRMAÇÃO HUMANA — não a frase "confirma?" que o Bitz escreve
 * acima dele. O servidor só reconhece o clique; um "sim" digitado no chat não
 * executa nada, e o próprio prompt manda o modelo dizer isso.
 *
 * DESENHO: o que muda vem primeiro e em tamanho de leitura, com "de → para"
 * lado a lado. O aviso de marketplace, quando existe, fica ACIMA dos botões e
 * em destaque — quem decide precisa vê-lo antes de decidir, não depois.
 *
 * Depois de decidido o cartão NÃO some: ele vira um registro do que foi feito.
 * Sumir deixaria a conversa dizendo "preparei o cadastro" sem nada em volta, e
 * o lojista sem saber se clicou ou imaginou que clicou.
 */
export function BitzAcaoCard({
  acao,
  aoDecidir,
}: {
  acao: BitzAcao;
  aoDecidir?: (id: string, status: "confirmada" | "cancelada") => void;
}) {
  const { estado, erro, confirmar, cancelar } = useBitzAcao(acao.id, {
    decidida: acao.decidida,
    aoDecidir,
  });

  const decidido = estado === "confirmada" || estado === "cancelada";
  const enviando = estado === "enviando";

  return (
    <div
      className={cn(
        "border-border/60 bg-card/70 overflow-hidden rounded-2xl border",
        estado === "confirmada" && "border-primary/50",
        estado === "cancelada" && "opacity-70",
      )}
    >
      <div className="px-3.5 pt-3 pb-2">
        <p className="text-muted-foreground font-mono text-[9px] tracking-[0.18em] uppercase">
          {decidido ? "O que o Bitz fez" : "Confira antes de confirmar"}
        </p>
        <p className="text-foreground mt-0.5 text-sm font-semibold">
          {acao.preview.titulo}
        </p>
        {acao.preview.alvo && (
          <p className="text-muted-foreground mt-0.5 text-xs">
            {acao.preview.alvo}
          </p>
        )}
      </div>

      <dl className="border-border/60 border-t px-3.5 py-2">
        {acao.preview.campos.map((c) => (
          <div
            key={c.campo}
            className="flex items-baseline gap-2 py-1 text-xs"
          >
            <dt className="text-muted-foreground w-28 shrink-0 truncate">
              {c.campo}
            </dt>
            <dd className="text-foreground flex min-w-0 flex-1 items-baseline gap-1.5">
              {/* `de` ausente = criação: não havia valor antes, e mostrar um
                  travessão sugeriria que havia e foi apagado. */}
              {c.de != null && (
                <>
                  <span className="text-muted-foreground line-through">
                    {c.de}
                  </span>
                  <ArrowRight className="text-muted-foreground size-3 shrink-0" />
                </>
              )}
              <span className="font-medium break-words">{c.para}</span>
            </dd>
          </div>
        ))}
      </dl>

      {acao.preview.aviso && (
        <p className="border-border/60 text-foreground flex items-start gap-2 border-t px-3.5 py-2 text-[11px] leading-snug">
          <AlertTriangle className="text-primary mt-0.5 size-3.5 shrink-0" />
          <span>{acao.preview.aviso}</span>
        </p>
      )}

      {erro && (
        <p
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-foreground border-t px-3.5 py-2 text-[11px]"
        >
          {erro}
        </p>
      )}

      <div className="border-border/60 flex items-center gap-2 border-t px-3.5 py-2.5">
        {estado === "confirmada" ? (
          <p className="text-foreground flex items-center gap-1.5 text-xs font-medium">
            <Check className="text-primary size-4" /> Feito.
          </p>
        ) : estado === "cancelada" ? (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <X className="size-4" /> Cancelado — nada foi alterado.
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={confirmar}
              disabled={enviando}
              className={cn(
                "bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5",
                "text-xs font-medium shadow-sm transition disabled:opacity-50",
                "hover:bg-primary/90 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                "motion-reduce:transition-none",
              )}
            >
              {enviando ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Check className="size-3.5" />
              )}
              Confirmar
            </button>
            <button
              type="button"
              onClick={cancelar}
              disabled={enviando}
              className={cn(
                "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex items-center gap-1.5",
                "rounded-full px-3 py-1.5 text-xs transition disabled:opacity-50",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                "motion-reduce:transition-none",
              )}
            >
              Cancelar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
