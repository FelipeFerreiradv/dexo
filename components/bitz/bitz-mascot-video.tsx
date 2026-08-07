"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { MASCOT } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";

/**
 * O mascote ANIMADO — toca o vídeo uma vez e para no último quadro.
 *
 * ⭐ REGRA QUE GOVERNA ESTE ARQUIVO: a animação é enfeite, e enfeite nunca
 * atrasa nem quebra nada. Se o vídeo não carregar, não tocar, ou o usuário
 * pedir menos movimento, cai no mascote estático e ninguém percebe.
 *
 * ⚠️ POR QUE ELE NÃO MORA NO LAUNCHER. O vídeo tem 10 segundos e 4,9 MB. Tocar
 * no botão flutuante significaria: ou segurar a abertura do painel por até 10 s
 * (inaceitável — o lojista abre o chat dezenas de vezes por dia), ou cortar a
 * animação em ~400 ms, que é quando o painel cobre o botão. Aqui, na saudação
 * do painel, ela toca inteira, num tamanho em que dá para ver, e sem segurar
 * nada.
 *
 * ⚠️ CUSTO. O arquivo só é buscado quando este componente monta — ou seja,
 * depois do primeiro clique, dentro do chunk dinâmico do painel. Quem nunca
 * abre o chat não baixa um byte. Mesmo assim, 4,9 MB numa saudação é muito:
 * `preload="none"` garante que nem o painel aberto puxe o arquivo antes da
 * hora, e o `poster` mostra o mascote parado enquanto o vídeo não chega.
 */
export function BitzMascotVideo({
  size = 52,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const [falhou, setFalhou] = React.useState(false);

  React.useEffect(() => {
    const v = ref.current;
    if (!v) return;

    // Quem pediu menos movimento no sistema operacional não recebe vídeo
    // nenhum — nem o download.
    const menosMovimento =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (menosMovimento) {
      setFalhou(true);
      return;
    }

    v.load();
    // `play()` devolve promise e REJEITA quando a política de autoplay do
    // navegador barra. Sem o catch, isso vira "Unhandled promise rejection" no
    // console do cliente por causa de uma animação.
    void v.play().catch(() => setFalhou(true));
  }, []);

  if (falhou) {
    return <BitzMascot size={size} aura priority className={className} />;
  }

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden
        className={cn(
          "absolute -inset-[18%] rounded-full opacity-70 blur-xl",
          "bg-[conic-gradient(from_140deg,var(--color-chart-1),var(--color-chart-3),var(--color-primary),var(--color-chart-2),var(--color-chart-1))]",
        )}
      />
      <video
        ref={ref}
        // `muted` + `playsInline` não são estilo: sem os dois o iOS recusa
        // tocar sem tela cheia, e o Chrome recusa tocar sem som ligado.
        muted
        playsInline
        // Uma vez só. Mascote em loop eterno no canto da tela vira distração
        // para quem está trabalhando.
        loop={false}
        preload="none"
        poster={MASCOT.png256}
        aria-hidden
        onError={() => setFalhou(true)}
        className="relative size-full rounded-full object-contain select-none"
        style={{ width: size, height: size }}
      >
        <source src={MASCOT.video} type="video/mp4" />
      </video>
    </span>
  );
}
