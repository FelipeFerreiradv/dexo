"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { MASCOT } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";

/**
 * O mascote ANIMADO da saudação — toca uma vez e para no último quadro.
 *
 * ⭐ REGRA QUE GOVERNA ESTE ARQUIVO: a animação é enfeite, e enfeite nunca
 * atrasa nem quebra nada. Se o arquivo não carregar, ou o usuário pedir menos
 * movimento, cai no mascote estático e ninguém percebe.
 *
 * ⚠️ POR QUE `<img>` E NÃO `<video>`. O material original é um MP4 de 4K, 10 s
 * e 4,9 MB, com FUNDO BRANCO CHAPADO. Três problemas de uma vez: peso
 * indefensável para um mascote, decodificação 4K para exibir a 90 px, e — o
 * pior — no tema escuro do Dexo o fundo branco vira uma placa luminosa atrás do
 * robô, porque MP4/H.264 não tem canal alpha.
 *
 * O que existe aqui é o mesmo material recortado (branco → transparente),
 * cortado nos 3 segundos que interessam e reencodado como WebP animado:
 * 224×305, 45 quadros, **237 KB**. WebP animado tem alpha, é suportado por
 * Chrome, Edge, Firefox e Safari 16+, e como é `<img>` não esbarra em política
 * de autoplay, não precisa de `muted`/`playsInline` e não devolve promise que
 * rejeita.
 *
 * O "toca uma vez" está DENTRO do arquivo (contador de loop = 1), não no
 * código. Reabrir o painel remonta o `<img>` e a animação recomeça.
 *
 * ⚠️ CUSTO. Só é buscado quando este componente monta — dentro do chunk
 * dinâmico do painel, ou seja, depois do primeiro clique. Quem nunca abre o
 * chat não baixa um byte.
 */
export function BitzMascotAnimado({
  height = 92,
  className,
}: {
  /** Altura em px. A largura acompanha a proporção do arquivo (224×305). */
  height?: number;
  className?: string;
}) {
  const [falhou, setFalhou] = React.useState(false);

  // Quem pediu menos movimento no sistema operacional não recebe a animação —
  // nem o download dela. Lido depois da montagem: `matchMedia` no primeiro
  // render dispararia divergência de hidratação.
  const [menosMovimento, setMenosMovimento] = React.useState(false);
  React.useEffect(() => {
    setMenosMovimento(
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    );
  }, []);

  if (falhou || menosMovimento) {
    return (
      <BitzMascot
        size={Math.round(height * 0.62)}
        aura
        priority
        className={className}
      />
    );
  }

  const width = Math.round((height * 224) / 305);

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width, height }}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-[-30%] bottom-0 h-1/2 rounded-[50%] opacity-60 blur-xl",
          "bg-[conic-gradient(from_140deg,var(--color-chart-1),var(--color-chart-3),var(--color-primary),var(--color-chart-2),var(--color-chart-1))]",
        )}
      />
      {/* `<picture>` com fallback de verdade: navegador sem WebP animado pega o
          PNG estático e vê o mascote parado, em vez de um quadrado vazio. */}
      <picture className="relative size-full">
        <source srcSet={MASCOT.animacao} type="image/webp" />
        <img
          src={MASCOT.png256}
          alt=""
          width={width}
          height={height}
          // `sync` porque a animação já está no chunk do painel e precisa
          // começar junto com a saudação — decodificar depois faria o robô
          // "aparecer" com atraso, o oposto do efeito pretendido.
          decoding="sync"
          draggable={false}
          aria-hidden
          onError={() => setFalhou(true)}
          className="relative size-full object-contain select-none"
        />
      </picture>
    </span>
  );
}
