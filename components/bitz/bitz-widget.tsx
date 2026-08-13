"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { Session } from "next-auth";

import { cn } from "@/lib/utils";
import { useBitzAlertas } from "@/hooks/use-bitz-alertas";
import { useBitzEntitlement } from "@/hooks/use-bitz-entitlement";
import { useIsMobile } from "@/hooks/use-mobile";
import { type BitzPanelMode } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";
import { jaPassou, marcarPassou } from "./bitz-onboarding";

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
 * Teto ABSOLUTO da animação de entrada, contado do clique.
 *
 * ⭐ Esta constante é a rede de segurança final da promessa "enfeite nunca
 * quebra nada". Ela não confia em NADA lá de dentro: se o chunk da entrada não
 * chegar, se o WebP pendurar, se o componente ficar preso num estado que
 * ninguém previu — passados estes segundos o chat abre do mesmo jeito.
 *
 * 14 s = os 9,6 s da animação + 4,4 s de folga, quase o teto de carregamento
 * interno (5 s). Frouxo de propósito: quem manda no caso normal é o próprio
 * `BitzEntrada`; isto aqui só existe para o caso anormal.
 *
 * Não sobe junto com nada: o número existe para o caso em que o `BitzEntrada`
 * não termina sozinho, e afrouxá-lo só faria o Bitz demorar mais para ficar
 * alcançável. Na única sobreposição possível — download quase estourando os 5 s
 * e a animação inteira depois dele — o teto corta meio segundo de enfeite para
 * quem está numa rede ruim, que é exatamente a troca certa.
 */
const TETO_DA_ENTRADA_MS = 14_000;

/** O contrato do módulo carregado sob demanda, para o `import()` manual abaixo. */
type ComponenteDaEntrada = React.ComponentType<{
  onFim: () => void;
  onComecou?: () => void;
}>;

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
  /** A animação de entrada está tocando neste instante (uma vez na vida). */
  const [entrando, setEntrando] = React.useState(false);
  /** O componente da entrada, depois que o chunk dele chegou. */
  const [Entrada, setEntrada] = React.useState<ComponenteDaEntrada | null>(null);
  const relogio = React.useRef<number | null>(null);

  const usuarioId = session.user.id;

  /**
   * ⭐ O BADGE. Só acende para o que é inequivocamente DEFEITO — venda que não
   * virou pedido (estoque não baixado) e conta com autorização caída —, e só
   * quando algum desses números SUBIU desde a última vez que o lojista
   * dispensou. O porquê de cada exclusão está medido em
   * `app/ai/alertas/alertas.service.ts`; a catraca, em `bitz-alerta-catraca.ts`.
   *
   * `enabled` como gatilho: quem não contratou o módulo não faz a consulta.
   */
  const alerta = useBitzAlertas(enabled, usuarioId);

  const abrirDeFato = React.useCallback(() => {
    if (relogio.current !== null) {
      window.clearTimeout(relogio.current);
      relogio.current = null;
    }
    setEntrando(false);
    setOpen(true);
    setGreeting(true);
  }, []);

  // Timer pendente com o componente desmontado vira setState em árvore morta.
  React.useEffect(
    () => () => {
      if (relogio.current !== null) window.clearTimeout(relogio.current);
    },
    [],
  );

  const abrir = () => {
    // Clique repetido durante a entrada não reinicia nada.
    if (entrando) return;

    // No celular o padrão é tela cheia; no desktop abre docado e o usuário
    // expande quando quiser. Decidido na hora do clique (e não por CSS) porque
    // o modo é estado, não layout.
    setMode(isMobile ? "fullscreen" : "docked");

    // ⭐ O chunk do painel começa a carregar AGORA, não daqui a 9,6 s. A espera
    // da animação passa a ser tempo útil: quando o painel aparece, ele já está
    // pronto. Sem isso a animação seria custo puro.
    setMounted(true);

    // ⭐ A ENTRADA TOCA UMA VEZ NA VIDA DO USUÁRIO. São 9,6 s e 1 MB: encantador
    // na primeira vez, pedágio da segunda em diante. Quem já viu abre o chat na
    // hora, como sempre foi.
    //
    // ⚠️ AQUI HAVIA TAMBÉM UM GATE DE `prefers-reduced-motion`, E ELE FOI
    // REMOVIDO DE PROPÓSITO. No Windows, "Efeitos de animação" é o mesmo
    // interruptor que muita gente desliga por DESEMPENHO, e o navegador reporta
    // `reduce` igual — o efeito prático era apagar a animação de marca para uma
    // fatia enorme de usuários que nunca pediram isso. O resto do módulo segue
    // respeitando a preferência: toda transição, hover e keyframe de interface
    // tem `motion-reduce:*`. A entrada tem saída imediata por clique, Esc ou
    // "Pular", então quem não quiser vê-la sai em um gesto.
    if (jaPassou(usuarioId, "entrada")) {
      abrirDeFato();
      return;
    }

    // ⭐ O MARCO NÃO É QUEIMADO AQUI. Quem o queima é o `onComecou` da própria
    // entrada, no PRIMEIRO QUADRO EXIBIDO. Assim, quem clicou e não viu nada —
    // arquivo que não chegou, teto de carregamento, falha de rede — continua
    // com direito a ver na próxima vez.
    //
    // A versão anterior queimava no clique, para que fechar a aba no meio dos
    // 9,6 s não cobrasse o usuário de novo. Estava errado na direção mais cara:
    // transformava qualquer falha em perda DEFINITIVA de uma animação que só
    // toca uma vez na vida. Fechar a aba no meio custa, no máximo, ver a
    // animação uma segunda vez; nunca ver custa a animação inteira.
    //
    // O anti-pedágio continua garantido pelo teto de carregamento: rede que não
    // entrega 1 MB em 5 s abre o chat na hora, toda vez, sem espera acumulada.
    setEntrando(true);

    // ⭐ `import()` MANUAL, e não `dynamic()`. O repositório não tem error
    // boundary nenhum: um chunk que falha dentro de `dynamic()` lança DURANTE O
    // RENDER e leva a árvore do React junto — a página inteira do lojista, por
    // causa de um enfeite. Aqui a falha cai no `.catch`, que simplesmente abre
    // o chat sem animação.
    import("./bitz-entrada")
      .then((m) => setEntrada(() => m.BitzEntrada))
      .catch(abrirDeFato);

    // ⭐ E a rede final: aconteça o que acontecer lá dentro — chunk que nunca
    // chega, WebP que pendura, estado que ninguém previu — o chat abre. Sem
    // isto, `entrando` ficaria true para sempre, o launcher some, `abrir()`
    // volta no `if (entrando) return` e o marco já foi queimado: o Bitz fica
    // INALCANÇÁVEL para aquele usuário até ele recarregar a página.
    relogio.current = window.setTimeout(abrirDeFato, TETO_DA_ENTRADA_MS);
  };

  if (!enabled) return null;

  return (
    <>
      {/* ⭐ O launcher só sai de cena quando o overlay JÁ TEM o que pintar. Sair
          no clique deixava a tela sem launcher, sem véu e sem painel durante
          todo o round-trip do chunk — num 4G, meio segundo em que tocar no
          mascote não produz retorno visual nenhum. */}
      {!open && !(entrando && Entrada) && (
        <button
          type="button"
          onClick={abrir}
          disabled={entrando}
          // Pré-aquece o chunk do painel enquanto o mouse ainda vem chegando.
          //
          // ⚠️ NADA DE PRÉ-CARREGAR ARQUIVO DE ANIMAÇÃO AQUI. O navegador mantém
          // UMA linha do tempo POR RECURSO, compartilhada por todos os <img> da
          // mesma URL: tocar o arquivo no hover faz o <img> de verdade nascer
          // numa animação já adiantada — ou já encerrada, quando o loop é
          // finito, exibindo um robô parado. Foi exatamente esse bug na versão
          // anterior, e ele custou várias rodadas para ser isolado porque o
          // arquivo, o servidor e o CSS estavam todos corretos.
          onPointerEnter={() => {
            void import("./bitz-panel").catch(() => {});
          }}
          onAnimationEnd={() => setGreeting(false)}
          aria-label={
            alerta.avisar
              ? "Abrir o Bitz, assistente do Dexo — há um problema novo na operação"
              : "Abrir o Bitz, assistente do Dexo"
          }
          className={cn(
            // z-40: acima de todo conteúdo em árvore (máx. z-30) e abaixo de
            // todo Radix (z-50) e de todo toast (z-[100]).
            // bottom-20 no mobile livra a faixa onde os toasts pousam
            // (fixed bottom-4 right-4 em 17 telas).
            "fixed right-4 bottom-20 z-40 md:right-6 md:bottom-6",
            // ⛔⛔ NÃO ACRESCENTE `relative` AQUI. Já aconteceu, e o estrago é
            // grande: `fixed` e `relative` são a MESMA propriedade CSS, e o
            // Tailwind emite `relative` DEPOIS de `fixed` na ordem canônica de
            // posicionamento — então `relative` vence, o botão sai da camada
            // fixa, volta para o fluxo do documento e passa a ROLAR COM A
            // PÁGINA. O mascote deixa de ficar no canto e some da tela.
            //
            // Ele entrou aqui para "sustentar" o ponto do badge, e era
            // desnecessário: `position: absolute` resolve contra o ancestral
            // posicionado mais próximo, e `fixed` já é um deles. O ponto abaixo
            // se posiciona certo sem ajuda nenhuma.
            //
            // `tests/ai-widget-contract.spec.ts` prende isto.
            "inline-flex items-center justify-center rounded-full",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
            "transition-transform hover:scale-105 active:scale-95",
            "motion-reduce:transition-none motion-reduce:hover:scale-100",
            greeting &&
              "animate-[bitz-greet_620ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none",
            // Esperando o chunk: o mascote continua ali, mas inerte.
            entrando && "pointer-events-none scale-100",
          )}
        >
          <BitzMascot size={56} aura priority />

          {/* ⭐ UM PONTO, E NÃO UM NÚMERO. Somar "61 pendências" com "2 contas
              caídas" daria um "63" que não é nada: são unidades diferentes, e o
              badge só acende na SUBIDA, então o total nem seria o que mudou. O
              ponto diz "olha aqui"; a faixa dentro do painel diz o quê, e o
              `diagnostico_operacional` diz o resto. */}
          {alerta.avisar && (
            <span
              aria-hidden
              className={cn(
                "bg-destructive absolute top-0.5 right-0.5 size-3.5 rounded-full",
                "border-background border-2",
              )}
            />
          )}
        </button>
      )}

      {/* ⭐ A ENTRADA. Ela SUBSTITUI o launcher enquanto toca (a condição
          acima), então não há dois robôs na tela, e o overlay é a única coisa
          clicável — clique, Esc ou "Pular" abrem o chat na hora. */}
      {entrando && Entrada && (
        <Entrada
          onFim={abrirDeFato}
          onComecou={() => marcarPassou(usuarioId, "entrada")}
        />
      )}

      {mounted && (
        <BitzPanel
          open={open}
          onOpenChange={setOpen}
          mode={mode}
          onModeChange={setMode}
          userName={session.user?.name}
          usuarioId={usuarioId}
          // ⭐ O alerta desce do widget em vez de o painel ter o próprio hook:
          // são DOIS lugares mostrando a MESMA decisão, e com dois hooks
          // dispensar na faixa deixaria o ponto do mascote aceso.
          alerta={alerta.avisar ? alerta.contagem : null}
          onAlertaVisto={alerta.marcarVisto}
        />
      )}
    </>
  );
}

export default BitzWidget;
