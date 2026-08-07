"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { MASCOT } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";

/**
 * Largura ÷ altura do arquivo (190×294). Se o asset for reexportado com outro
 * enquadramento, este número muda junto — senão o robô estica ou achata. Há um
 * spec que lê as dimensões do VP8X do arquivo e compara com estes números.
 */
const PROPORCAO = 190 / 294;

/**
 * O mascote ANIMADO em LOOP — usado na tela "Conheça o Bitz".
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
 * O que existe aqui é o material de boas-vindas recortado (branco →
 * transparente), enquadrado no robô e cortado NO TRECHO DO ACENO: 190×294,
 * 29 quadros, 2,4 s, **235 KB**.
 *
 * ⚠️ O RECORTE DO TEMPO É LOAD-BEARING, e errar isso já custou uma rodada. No
 * começo do material o robô ainda está ENTRANDO no quadro, pela direita, e no
 * fim ele fica parado. O aceno — que é o que faz sentido repetir para sempre —
 * vive entre 7,0 s e 9,4 s, e é de lá que este arquivo sai.
 *
 * WebP animado tem alpha, é suportado por Chrome, Edge, Firefox e Safari 16+,
 * e como é `<img>` não esbarra em política de autoplay, não precisa de
 * `muted`/`playsInline` e não devolve promise que rejeita.
 *
 * ⚠️ O ARQUIVO TEM LOOP INFINITO, E É ASSIM QUE TEM QUE SER. O navegador
 * compartilha UMA linha do tempo de animação por URL entre todos os `<img>`:
 * com contador de loop finito, qualquer coisa que tenha tocado o arquivo antes
 * (um pré-carregamento, uma exibição anterior) faz a próxima exibição nascer
 * congelada no último quadro. Em loop infinito a imagem está SEMPRE em
 * movimento, venha de onde vier — e não é preciso `key` nenhuma.
 *
 * A animação que toca UMA VEZ e tem fim é outra: a de entrada, em
 * `bitz-entrada.tsx`, com arquivo próprio e loop 1.
 *
 * ⚠️ CUSTO. Só é buscado quando este componente monta — dentro do chunk
 * dinâmico do painel, ou seja, depois do primeiro clique. Quem nunca abre o
 * chat não baixa um byte.
 */
export function BitzMascotAnimado({
  height = 92,
  className,
}: {
  /** Altura em px. A largura acompanha a proporção do arquivo. */
  height?: number;
  className?: string;
}) {
  const [falhou, setFalhou] = React.useState(false);

  // ⭐ ESTA ANIMAÇÃO NÃO É GATEADA POR `prefers-reduced-motion`, E ISSO FOI
  // DECIDIDO COM DADO NA MÃO.
  //
  // A regra existe para quem tem enjoo de movimento, e o resto do módulo
  // continua respeitando: toda transição, hover, pulo de escala e keyframe da
  // interface tem `motion-reduce:*`. O que mudou é o tratamento do MASCOTE.
  //
  // Motivo: no Windows, "Efeitos de animação" vem no mesmo interruptor que a
  // maioria das pessoas desliga por DESEMPENHO, não por acessibilidade — e o
  // navegador reporta `reduce` do mesmo jeito. Na prática isso apagava a
  // animação que define a marca do produto para uma fatia enorme de usuários,
  // sem que nenhum deles tivesse pedido isso. Foi exatamente o que aconteceu na
  // máquina do dono do produto, e levou quatro rodadas para ser isolado.
  //
  // O que sobra de proteção: a animação é curta, sem flash, sem parallax e sem
  // movimento de tela inteira — é um bonequinho acenando dentro de uma caixa de
  // 190 px. Fica bem longe do que a regra foi escrita para evitar.
  //
  // A rede de segurança do `onError` continua: arquivo que não carrega cai no
  // mascote estático e ninguém percebe.

  if (falhou) {
    return (
      <BitzMascot
        size={Math.round(height * 0.62)}
        aura
        priority
        className={className}
      />
    );
  }

  const width = Math.round(height * PROPORCAO);

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
        <source srcSet={MASCOT.loop} type="image/webp" />
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
