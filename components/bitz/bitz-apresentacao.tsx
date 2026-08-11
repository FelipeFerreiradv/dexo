"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { BitzMascotAnimado } from "./bitz-mascot-animado";

/**
 * A tela "conheça o bitz." — o que o usuário vê ao abrir o chat pela PRIMEIRA
 * VEZ, com o robô animado em loop, até enviar a primeira mensagem.
 *
 * ⭐ O DESENHO SEGUE A REFERÊNCIA, NESTA ORDEM, e a ordem é o pedido:
 *
 *        conheça o bitz.        ← wordmark, "bitz" em amarelo
 *      ┌───────────────┐
 *      │ Precisa de... │        ← balãozinho
 *      └──────┬────────┘
 *          🤖                   ← o robô, em loop
 *   [ Pergunte alguma coisa 🎤 ] ← o composer, que JÁ é irmão desta tela
 *
 * ⭐ TIPOGRAFIA: o mesmo wordmark do herói das páginas
 * (`components/page-header.tsx`): Outfit, `font-black`, minúsculas, tracking
 * fechado. A diferença é que aqui a palavra em destaque é "bitz", em amarelo —
 * nas páginas quem fica amarelo é só o ponto final. `style={{fontFamily}}`
 * porque a regra base de `h2` já aponta para `--font-display` (Bricolage) e
 * precisa ser vencida.
 *
 * ⭐ SEM CABEÇALHO. Esta tela é a primeira impressão do produto e não divide
 * espaço com barra de título, botão de expandir nem breadcrumb — o painel
 * esconde o header enquanto ela está no ar (`bitz-panel.tsx`). O × flutuante
 * abaixo é a ÚNICA exceção, e é deliberada: sem ele, no modo docado (que não
 * fecha por clique fora nem por Esc) não sobraria nenhuma forma de sair — a
 * primeira tela do produto viraria uma armadilha.
 *
 * ⭐ NÃO HÁ BOTÃO DE AÇÃO. A referência tem um "Get started", mas aqui ele
 * seria um caminho paralelo ao campo de texto que está logo abaixo, fazendo a
 * mesma coisa. O pedido foi literal: a tela vale "até a pessoa enviar sua
 * primeira mensagem" — quem manda a mensagem é o composer.
 *
 * ⚠️ O LOOP É INFINITO DE PROPÓSITO. A linha do tempo da animação é
 * compartilhada por URL entre todos os `<img>`: com contador finito, um arquivo
 * que já tocou nasce congelado no último quadro na exibição seguinte. O arquivo
 * do loop tem `loop_count 0`, e há um spec que lê isso dos bytes.
 *
 * ⚠️ Com `prefers-reduced-motion` o `BitzMascotAnimado` cai sozinho no mascote
 * estático. A tela continua existindo, só não se mexe — que é exatamente o
 * pedido de quem ligou essa preferência.
 */
export function BitzApresentacao({
  nome,
  onFechar,
  className,
}: {
  nome?: string | null;
  onFechar?: () => void;
  className?: string;
}) {
  const primeiroNome = nome?.trim().split(/\s+/)[0];

  return (
    // `flex-1` e não `min-h-full`: o pai (bitz-panel.tsx) é um flex column de
    // altura mínima cheia, mas altura CALCULADA auto — um percentual aqui
    // resolveria contra indefinido e viraria zero, deixando tudo colado no topo.
    <div
      className={cn(
        "relative flex min-h-full flex-1 flex-col items-center justify-center",
        "gap-6 px-6 py-10 text-center",
        className,
      )}
    >
      {/* Halo quente atrás de tudo — a mesma leitura "glass" do painel, mas
          centrada na cena em vez de colada no topo. Decorativo. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-1/4 -z-10 mx-auto h-64 max-w-sm",
          "from-primary/25 rounded-[50%] bg-gradient-to-b to-transparent blur-3xl",
        )}
      />

      {onFechar && (
        <button
          type="button"
          onClick={onFechar}
          aria-label="Fechar o Bitz"
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-muted absolute top-3 right-3",
            "inline-flex size-8 items-center justify-center rounded-xl transition",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            "motion-reduce:transition-none",
          )}
        >
          <X className="size-4" />
        </button>
      )}

      <h2
        className={cn(
          "text-foreground max-w-[11ch] text-5xl leading-[0.9] font-black",
          "tracking-[-0.04em] text-balance select-none sm:text-6xl",
        )}
        style={{ fontFamily: "var(--font-outfit)" }}
      >
        conheça o <span className="text-primary">bitz</span>
        <span className="text-primary">.</span>
      </h2>

      {/* O balãozinho. `rounded-br-md` quebra a simetria do canto de baixo e é
          de onde o rabinho sai — mesmo truque das bolhas de `bitz-message`. */}
      <div className="relative">
        <div
          className={cn(
            "bg-card/80 border-border/60 max-w-[16rem] rounded-2xl rounded-br-md border px-4 py-2.5 backdrop-blur",
            "text-foreground text-sm leading-snug shadow-sm",
          )}
        >
          {primeiroNome ? `Oi, ${primeiroNome}! ` : "Oi! "}
          Precisa de ajuda com alguma coisa?
        </div>
        {/* O rabinho, desenhado com as MESMAS cores da bolha para emendar sem
            costura visível — inclusive a borda, que só aparece nos dois lados
            externos. */}
        <div
          aria-hidden
          className="bg-card/80 border-border/60 absolute -bottom-1 right-5 size-3 rotate-45 border-r border-b backdrop-blur"
        />
      </div>

      <BitzMascotAnimado height={190} />
    </div>
  );
}

export default BitzApresentacao;
