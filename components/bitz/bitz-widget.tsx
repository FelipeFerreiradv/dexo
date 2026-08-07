"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { Session } from "next-auth";

import { cn } from "@/lib/utils";
import { useBitzEntitlement } from "@/hooks/use-bitz-entitlement";
import { useIsMobile } from "@/hooks/use-mobile";
import { MASCOT, type BitzPanelMode } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";

/**
 * O painel inteiro (chat, markdown, composer) só é baixado DEPOIS do primeiro
 * clique. O que entra no shell de todas as páginas é apenas este arquivo mais
 * o launcher — poucos KB.
 *
 * Padrão da casa: app/produtos/components/location-scan-button.tsx:27-33.
 */
const BitzPanel = dynamic(
  () => import("./bitz-panel").then((m) => m.BitzPanel),
  { ssr: false },
);

/**
 * O widget propriamente dito: launcher + painel.
 *
 * Este arquivo NÃO é importado estaticamente por ninguém — `bitz-root.tsx` o
 * carrega por `dynamic()`. É o que mantém tudo isto (mascote, hooks, ícones)
 * fora do shell de todas as páginas quando o módulo está desligado.
 *
 * A terceira e última porta mora aqui: `GET /ai/entitlement`, o plano por
 * tenant. Sem ele o launcher não é renderizado — nada de cadeado, nada de
 * tooltip de upsell. Quem não contratou não descobre que existe.
 */
// `bitz-root.tsx` só renderiza este componente depois de garantir a sessão,
// então aqui ela não é mais nullable. Tipar como não-nulo evita um `?.`
// defensivo que esconderia uma quebra futura daquele contrato.
export function BitzWidget({ session }: { session: Session }) {
  const enabled = useBitzEntitlement();
  const isMobile = useIsMobile();

  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [greeting, setGreeting] = React.useState(false);
  const [mode, setMode] = React.useState<BitzPanelMode>("docked");
  /**
   * Quantas vezes o painel foi aberto nesta aba.
   *
   * ⚠️ NÃO É TELEMETRIA — é o que faz a animação de saudação TOCAR DE NOVO.
   * O painel é montado uma vez e nunca desmontado (fechar só faz `open=false`),
   * então o `<img>` da animação também nunca remonta. WebP animado com contador
   * de loop 1 toca uma vez e congela no último quadro: sem esta chave, o
   * lojista via a animação na primeira abertura da aba e NUNCA MAIS.
   */
  const [aberturas, setAberturas] = React.useState(0);

  const abrir = () => {
    // No celular o padrão é tela cheia; no desktop abre docado e o usuário
    // expande quando quiser. Decidido na hora do clique (e não por CSS) porque
    // o modo é estado, não layout.
    setMode(isMobile ? "fullscreen" : "docked");
    setMounted(true);
    setOpen(true);
    setGreeting(true);
    setAberturas((n) => n + 1);
  };

  if (!enabled) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={abrir}
          // Pré-aquece o chunk do painel enquanto o mouse ainda vem chegando.
          onPointerEnter={() => {
            void import("./bitz-panel").catch(() => {});
            // Pré-busca a animação junto do chunk: sem isso o primeiro clique
            // gasta o começo dela baixando 237 KB, e o que o usuário vê é o
            // robô entrando pela metade.
            new Image().src = MASCOT.animacao;
          }}
          onAnimationEnd={() => setGreeting(false)}
          aria-label="Abrir o Bitz, assistente do Dexo"
          className={cn(
            // z-40: acima de todo conteúdo em árvore (máx. z-30) e abaixo de
            // todo Radix (z-50) e de todo toast (z-[100]).
            // bottom-20 no mobile livra a faixa onde os toasts pousam
            // (fixed bottom-4 right-4 em 17 telas).
            "fixed right-4 bottom-20 z-40 md:right-6 md:bottom-6",
            "inline-flex items-center justify-center rounded-full",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
            "transition-transform hover:scale-105 active:scale-95",
            "motion-reduce:transition-none motion-reduce:hover:scale-100",
            greeting &&
              "animate-[bitz-greet_620ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none",
          )}
        >
          <BitzMascot size={56} aura priority />
        </button>
      )}

      {mounted && (
        <BitzPanel
          open={open}
          onOpenChange={setOpen}
          mode={mode}
          onModeChange={setMode}
          abertura={aberturas}
          userName={session.user?.name}
        />
      )}
    </>
  );
}

export default BitzWidget;
