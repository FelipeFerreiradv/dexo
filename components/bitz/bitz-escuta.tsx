"use client";

import * as React from "react";
import { Loader2, Mic, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { BitzMascot } from "./bitz-mascot";
import type { EstadoDoAudio } from "@/hooks/use-bitz-audio";

/**
 * A TELA DE ESCUTA — o desenho que o plano especificou para a Fase 7: mascote
 * grande centralizado, aura animada, tudo o mais some.
 *
 * ⭐ POR QUE COBRE O PAINEL INTEIRO. Gravar é um estado modal de verdade: o
 * microfone está aberto, e a única coisa que importa é o lojista saber disso e
 * poder parar. Uma barrinha discreta no rodapé deixaria dúvida sobre se está
 * gravando — e dúvida sobre microfone aberto é a pior forma de dúvida.
 *
 * ⚠️ DUAS SAÍDAS, e a diferença entre elas é o ponto:
 *   - **Pronto** encerra e MANDA transcrever;
 *   - **Cancelar** encerra e JOGA OS BYTES FORA.
 * Sem o cancelar, quem começou a falar sem querer só teria a opção de enviar.
 */
export function BitzEscuta({
  estado,
  segundos,
  maxSegundos,
  onParar,
  onCancelar,
}: {
  estado: EstadoDoAudio;
  segundos: number;
  maxSegundos: number;
  onParar: () => void;
  onCancelar: () => void;
}) {
  const gravando = estado === "gravando";
  const enviando = estado === "enviando";

  // Esc cancela — a saída que não custa nada, como em qualquer camada
  // sobreposta do sistema.
  React.useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onCancelar]);

  const mm = String(Math.floor(segundos / 60)).padStart(2, "0");
  const ss = String(segundos % 60).padStart(2, "0");
  const perto = segundos >= maxSegundos - 15;

  return (
    <div
      className={cn(
        "bg-background/95 absolute inset-0 z-20 flex flex-col items-center justify-center",
        "gap-7 px-6 text-center backdrop-blur-sm",
        "animate-in fade-in-0 duration-200 motion-reduce:animate-none",
      )}
      role="dialog"
      aria-modal="true"
      aria-label={gravando ? "Gravando áudio" : "Transcrevendo áudio"}
    >
      <div className="relative">
        {/* A aura. Ela PULSA enquanto grava e fica parada enquanto transcreve —
            é o sinal de que o microfone ainda está aberto, e é a diferença que
            o usuário lê sem precisar de legenda. */}
        <span
          aria-hidden
          className={cn(
            "absolute -inset-10 rounded-full opacity-60 blur-3xl",
            "bg-[conic-gradient(from_140deg,var(--color-chart-1),var(--color-chart-3),var(--color-primary),var(--color-chart-2),var(--color-chart-1))]",
            gravando &&
              "animate-[bitz-escuta-aura_2.4s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
        />
        <BitzMascot size={120} aura={false} priority />
      </div>

      <div className="flex flex-col items-center gap-2">
        <p
          className={cn(
            "font-mono text-3xl tabular-nums",
            perto ? "text-destructive" : "text-foreground",
          )}
          aria-live="off"
        >
          {mm}:{ss}
        </p>
        <p className="text-muted-foreground max-w-[26ch] text-sm text-balance">
          {enviando
            ? "Transcrevendo o que você falou…"
            : perto
              ? "Chegando no limite da gravação."
              : "Estou ouvindo. Fale a sua pergunta."}
        </p>
      </div>

      {enviando ? (
        <Loader2 className="text-muted-foreground size-6 animate-spin motion-reduce:animate-none" />
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCancelar}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex items-center gap-2",
              "rounded-full px-4 py-2.5 text-sm font-medium transition",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              "motion-reduce:transition-none",
            )}
          >
            <X className="size-4" />
            Cancelar
          </button>
          <button
            type="button"
            onClick={onParar}
            className={cn(
              "bg-primary text-primary-foreground inline-flex items-center gap-2",
              "rounded-full px-5 py-2.5 text-sm font-semibold shadow-sm transition",
              "hover:bg-primary/90 hover:scale-105 active:scale-95",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              "motion-reduce:transition-none motion-reduce:hover:scale-100",
            )}
          >
            <Square className="size-3.5 fill-current" />
            Pronto
          </button>
        </div>
      )}

      {/* O aviso de privacidade fica na tela, não num termo que ninguém lê: o
          áudio some assim que vira texto. */}
      <p className="text-muted-foreground/70 flex items-center gap-1.5 text-[11px]">
        <Mic className="size-3" />O áudio é apagado depois de transcrito.
      </p>
    </div>
  );
}

export default BitzEscuta;
