"use client";

import * as React from "react";
import { Loader2, Mic, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { BitzEspectro } from "./bitz-espectro";
import type { EstadoDoAudio } from "@/hooks/use-bitz-audio";

/**
 * A TELA DE ESCUTA.
 *
 * ⭐ POR QUE COBRE O PAINEL INTEIRO. Gravar é um estado modal de verdade: o
 * microfone está aberto, e a única coisa que importa é o lojista saber disso e
 * poder parar. Uma barrinha discreta no rodapé deixaria dúvida sobre se está
 * gravando — e dúvida sobre microfone aberto é a pior forma de dúvida.
 *
 * ⭐ E POR QUE ELA É ESCURA, SEMPRE, EM QUALQUER TEMA. É a mesma razão: a tela
 * apaga para dizer "agora é só você falando", como a tela de chamada de um
 * telefone. É a única superfície do sistema que não segue o tema do usuário, e
 * o desvio é deliberado — não um esquecimento de token.
 *
 * ⭐ O ESPECTRO SUBSTITUIU O MASCOTE, que antes ocupava o centro. O mascote já
 * está no cabeçalho do painel e no botão que abre o chat; ninguém esquece com
 * quem está falando em quinze segundos. O que faltava era a resposta à única
 * pergunta desta tela — "ele está me ouvindo?" —, e ela agora é literal: a onda
 * sobe quando você fala e achata quando você para, porque lê o áudio de verdade
 * (ver `bitz-espectro.tsx`).
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
  stream,
  onParar,
  onCancelar,
}: {
  estado: EstadoDoAudio;
  segundos: number;
  maxSegundos: number;
  /** O stream vivo, para o espectro desenhar. `null` ⇒ onda em repouso. */
  stream?: MediaStream | null;
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
        "absolute inset-0 z-20 flex flex-col items-center justify-center",
        "gap-8 px-6 text-center",
        // Petróleo Profundo (--foreground do tema claro), fixo. Ver o cabeçalho.
        "bg-[#0e1f2a]",
        "animate-in fade-in-0 duration-200 motion-reduce:animate-none",
      )}
      role="dialog"
      aria-modal="true"
      aria-label={gravando ? "Gravando áudio" : "Transcrevendo áudio"}
    >
      {/* O halo. É CSS puro e lento de propósito: o brilho dá a profundidade da
          referência sem custar um único pixel do orçamento por quadro do
          espectro, que é quem precisa dos 60fps.
          ⚠️ SÃO DOIS ELEMENTOS, e precisam ser: `bitz-escuta-aura` anima
          `transform: scale()`, e uma classe de posicionamento com `translate`
          no MESMO elemento seria sobrescrita no primeiro quadro — o brilho
          saltaria para o canto. O de fora posiciona, o de dentro pulsa. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 -inset-x-[15%] h-64 -translate-y-1/2"
      >
        <span
          className={cn(
            "block h-full w-full rounded-[50%] blur-3xl",
            "bg-[radial-gradient(ellipse_at_center,rgba(242,196,25,0.22),rgba(44,95,79,0.14)_45%,transparent_72%)]",
            gravando &&
              "animate-[bitz-escuta-aura_3.2s_ease-in-out_infinite] motion-reduce:animate-none",
          )}
        />
      </span>

      {/* ⭐ O ESPECTRO. Largura cheia e altura generosa: é o protagonista da
          tela, e uma onda pequena voltaria a ser um enfeite de canto. */}
      <BitzEspectro
        stream={gravando ? (stream ?? null) : null}
        ativo={gravando}
        className="relative h-32 w-full max-w-[22rem] sm:h-36"
      />

      <div className="relative flex flex-col items-center gap-2">
        <p
          className={cn(
            "font-mono text-3xl tabular-nums",
            perto ? "text-[#ff8a7a]" : "text-[#f2ede2]",
          )}
          aria-live="off"
        >
          {mm}:{ss}
        </p>
        <p className="max-w-[26ch] text-sm text-balance text-[#f2ede2]/65">
          {enviando
            ? "Transcrevendo o que você falou…"
            : perto
              ? "Chegando no limite da gravação."
              : "Estou ouvindo. Fale a sua pergunta."}
        </p>
      </div>

      {enviando ? (
        <Loader2 className="relative size-6 animate-spin text-[#f2ede2]/60 motion-reduce:animate-none" />
      ) : (
        <div className="relative flex items-center gap-3">
          <button
            type="button"
            onClick={onCancelar}
            className={cn(
              "inline-flex items-center gap-2 text-[#f2ede2]/70",
              "hover:bg-[#f2ede2]/10 hover:text-[#f2ede2]",
              "rounded-full px-4 py-2.5 text-sm font-medium transition",
              "focus-visible:ring-2 focus-visible:ring-[#f2c419] focus-visible:outline-none",
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
              "inline-flex items-center gap-2 bg-[#f2c419] text-[#0e1f2a]",
              "rounded-full px-5 py-2.5 text-sm font-semibold shadow-sm transition",
              "hover:bg-[#f2c419]/90 hover:scale-105 active:scale-95",
              "focus-visible:ring-2 focus-visible:ring-[#f2ede2] focus-visible:outline-none",
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
      <p className="relative flex items-center gap-1.5 text-[11px] text-[#f2ede2]/45">
        <Mic className="size-3" />O áudio é apagado depois de transcrito.
      </p>
    </div>
  );
}

export default BitzEscuta;
