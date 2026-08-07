"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { Session } from "next-auth";

import { cn } from "@/lib/utils";
import { useBitzEntitlement } from "@/hooks/use-bitz-entitlement";
import { useIsMobile } from "@/hooks/use-mobile";
import { MASCOT, type BitzPanelMode } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";
import { BitzMascotAnimado } from "./bitz-mascot-animado";

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
 * Quanto o painel espera a animação do mascote antes de aparecer.
 *
 * O arquivo tem 1,6 s — já recortado no trecho em que o robô se mexe. Abrir em
 * 1,2 s mostra o essencial e deixa uma folga de 0,4 s: subir esta constante
 * para 1600 faz a animação terminar antes de o painel entrar, sem reexportar
 * nada. Passar muito disso cobra a espera em TODA abertura do chat, e o
 * lojista abre isso dezenas de vezes por dia.
 */
const ESPERA_DA_ANIMACAO_MS = 1200;

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
  /** O mascote está tocando a animação de abertura neste instante. */
  const [animando, setAnimando] = React.useState(false);
  const relogio = React.useRef<number | null>(null);

  // Timer pendente com o componente desmontado vira setState em árvore morta.
  React.useEffect(
    () => () => {
      if (relogio.current !== null) window.clearTimeout(relogio.current);
    },
    [],
  );

  const abrir = () => {
    // Clique repetido durante a animação não empilha timer nem reinicia nada.
    if (animando) return;

    // No celular o padrão é tela cheia; no desktop abre docado e o usuário
    // expande quando quiser. Decidido na hora do clique (e não por CSS) porque
    // o modo é estado, não layout.
    setMode(isMobile ? "fullscreen" : "docked");

    // ⭐ O chunk do painel começa a carregar AGORA, não daqui a 1,2 s. A espera
    // da animação passa a ser tempo útil: quando o painel aparece, ele já está
    // pronto. Sem isso a animação seria custo puro.
    setMounted(true);

    const abrirDeFato = () => {
      setOpen(true);
      setGreeting(true);
      setAnimando(false);
    };

    // Quem pediu menos movimento no sistema não espera nada: abre na hora.
    const menosMovimento =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (menosMovimento) {
      abrirDeFato();
      return;
    }

    setAnimando(true);
    relogio.current = window.setTimeout(abrirDeFato, ESPERA_DA_ANIMACAO_MS);
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
            // ⚠️ `fetch`, NUNCA `new Image()`. Navegador mantém UMA linha do
            // tempo de animação POR RECURSO, compartilhada por todos os <img>
            // que apontam para a mesma URL. `new Image().src = ...` já INICIA
            // essa linha do tempo aqui no hover — e quando o usuário clicava,
            // segundos depois, o <img> de verdade entrava numa animação já
            // adiantada (ou encerrada, quando o arquivo tinha loop finito) e
            // exibia um robô parado. `fetch` aquece o cache HTTP sem criar
            // imagem nenhuma, então a linha do tempo só nasce no clique.
            void fetch(MASCOT.animacao).catch(() => {});
          }}
          onAnimationEnd={() => setGreeting(false)}
          // Durante a animação o botão para de responder: um segundo clique não
          // teria o que abrir, e o `active:scale-95` piscaria por nada.
          disabled={animando}
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
            // Enquanto anima, o botão sai do caminho do próprio mascote: sem
            // pulo de escala e sem cursor de clique.
            animando && "pointer-events-none scale-100",
          )}
        >
          {/* ⭐ O launcher NÃO precisa de `key` para a animação repetir: ele é
              desmontado quando o painel abre (`{!open && ...}`) e montado de
              novo quando fecha, então o <img> nasce novo a cada abertura e o
              WebP recomeça sozinho.

              ⚠️ Isso NÃO vale dentro do painel. Lá o componente fica montado
              para sempre (fechar só faz `open=false`), e um WebP com contador
              de loop 1 congela no último quadro. A animação que vier para o
              painel aberto vai precisar de uma chave que mude a cada abertura. */}
          {animando ? (
            <BitzMascotAnimado height={72} />
          ) : (
            <BitzMascot size={56} aura priority />
          )}
        </button>
      )}

      {mounted && (
        <BitzPanel
          open={open}
          onOpenChange={setOpen}
          mode={mode}
          onModeChange={setMode}
          userName={session.user?.name}
        />
      )}
    </>
  );
}

export default BitzWidget;
