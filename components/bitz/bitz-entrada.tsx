"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { MASCOT } from "./bitz-constants";
import { BitzMascot } from "./bitz-mascot";

/**
 * Duração real do arquivo: 144 quadros × 66,7 ms = 9,6 s.
 *
 * ⚠️ Este número tem que acompanhar o asset. Se a animação for reexportada com
 * outro corte, sobra tela parada no fim (número alto demais) ou o painel corta
 * a animação no meio (número baixo demais). O spec lê a duração dos BYTES do
 * WebP e compara com esta constante, justamente para a dupla não derivar.
 *
 * ⚠️ POR QUE 9,6 s E NÃO OS 10 s DO MATERIAL. O vídeo original foi feito para
 * rodar em loop, e por isso ele já EMENDA a volta ao começo dentro do próprio
 * arquivo: no quadro 144 (9,60 s) o robô que vai embora ainda está na tela e a
 * cabeça do começo JÁ ESTÁ ENTRANDO pela direita; do 145 em diante só existe o
 * robô do quadro 0. Como aqui a animação toca UMA vez e tem fim narrativo, essa
 * emenda aparecia como um solavanco de meio segundo — o robô sumia e voltava do
 * início. O corte é no último quadro em que só existe o robô indo embora.
 */
const DURACAO_MS = 9_600;

/**
 * Teto para os bytes chegarem. Passou disso, abre o chat e deixa a animação
 * para lá.
 *
 * São 1.045 KB: num 4G ruim de galpão isso pode levar mais que o filme inteiro.
 * Enfeite nunca vira sala de espera — quem clicou quer o assistente, não o
 * robô. E como o marco já foi gravado antes de chegar aqui, o usuário não é
 * cobrado de novo na próxima abertura.
 *
 * 5 s cobre até ~1,7 Mbps. Abaixo disso o download já levaria mais tempo que a
 * própria animação, e segurar o chat por isso seria o oposto do pedido.
 */
const TETO_DE_CARREGAMENTO_MS = 5_000;

/**
 * A ANIMAÇÃO DE ENTRADA — toca UMA VEZ NA VIDA do usuário, no primeiro clique
 * de todos no launcher, e só então o painel abre.
 *
 * ⭐ Quem decide se isto aparece é `bitz-widget.tsx`, consultando
 * `jaPassou(id, "entrada")`. Este componente não sabe de marco nenhum: ele
 * toca e avisa quando acabou. Um único jeito de sair (`encerrar`), e ele é
 * idempotente — o overlay some pelo fim natural, pelo Esc, pelo clique ou pelo
 * teto de carregamento, e nenhuma dessas rotas pode abrir o painel duas vezes.
 *
 * ⭐ POR QUE OS BYTES SÃO BAIXADOS ANTES DE EXISTIR UM `<img>`. Esta é a decisão
 * central do arquivo, e ela foi tomada com número na mão.
 *
 * O navegador decodifica imagem animada de forma INCREMENTAL: o quadro 0 deste
 * arquivo termina em 0,32% dos bytes, e reproduzir o filme inteiro exige só
 * 0,87 Mbps. Ou seja, apontar um `<img>` direto para a URL faz a animação
 * COMEÇAR quase imediatamente — mas `onLoad` só dispara quando o último byte
 * chega. Medido na versão de 10 s, antes do corte da emenda do loop:
 *
 *     2,5 Mbps → download 3,5 s → animação acaba em ~10,2 s,
 *                relógio armado em 3,5 s vence em 13,5 s
 *                = 3,4 s olhando o robô CONGELADO no último quadro
 *      5  Mbps → 1,7 s congelado
 *     10  Mbps → 0,9 s congelado
 *
 * Ancorar o relógio mais cedo (no `naturalWidth > 0`, por exemplo) não resolve:
 * as dimensões ficam conhecidas na leitura do cabeçalho em QUALQUER navegador,
 * inclusive nos que não animam progressivamente — e nesses o relógio começaria
 * antes da animação e a CORTARIA, que é pior. Não há como perguntar ao DOM
 * quando a animação de fato começou.
 *
 * A saída determinística é tirar a rede da equação: `fetch` traz os bytes (e
 * `fetch` NÃO inicia linha do tempo de animação — só `<img>`/`new Image` fazem),
 * e o `<img>` nasce apontando para um blob local. Aí decodificação e exibição
 * são imediatas, `onLoad` coincide com o primeiro quadro em todo navegador, e
 * os 9,6 s medem exatamente a animação. De brinde, um blob é um recurso PRÓPRIO:
 * a armadilha da linha do tempo compartilhada por URL deixa de existir aqui.
 *
 * O preço é honesto: até os bytes chegarem aparece o mascote estático no lugar
 * do robô — uma espera visível em vez de uma pose congelada.
 *
 * ⚠️ NADA DE PRÉ-CARREGAR ESTE ARQUIVO NO HOVER COM `new Image()`. O navegador
 * mantém UMA linha do tempo de animação por RECURSO: `new Image().src` no hover
 * já a inicia, e como este arquivo tem loop finito, ele chegaria no clique já
 * congelado no último quadro. Foi esse exato bug que custou rodadas de
 * investigação na animação anterior.
 */
export function BitzEntrada({
  onFim,
  onComecou,
}: {
  onFim: () => void;
  /**
   * Disparado no PRIMEIRO QUADRO exibido — não na montagem, não no clique.
   *
   * ⭐ É o gatilho do "já viu", e a diferença importa: o marco só é queimado
   * quando a animação de fato apareceu na tela. Quem clicou e não viu nada
   * (arquivo que não chegou, teto de carregamento, falha de rede) continua com
   * direito a ver na próxima vez. Antes o marco queimava no clique, e um
   * usuário azarado — ou alguém testando — perdia a animação para sempre sem
   * nunca tê-la visto.
   */
  onComecou?: () => void;
}) {
  const [carregou, setCarregou] = React.useState(false);
  /** URL do blob local. Enquanto for null, os bytes ainda não chegaram. */
  const [fonte, setFonte] = React.useState<string | null>(null);

  // `useRef` e não `useState`: o encerramento pode ser disparado por vários
  // caminhos independentes e precisa ser à prova de corrida SEM esperar
  // re-render.
  const encerrado = React.useRef(false);
  const encerrar = React.useCallback(() => {
    if (encerrado.current) return;
    encerrado.current = true;
    onFim();
  }, [onFim]);

  // Os bytes, antes de qualquer <img>. Ver o bloco grande acima.
  React.useEffect(() => {
    let vivo = true;
    let url: string | null = null;
    const controle = new AbortController();

    fetch(MASCOT.entrada, { signal: controle.signal })
      .then((r) =>
        r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((blob) => {
        if (!vivo) return;
        url = URL.createObjectURL(blob);
        setFonte(url);
      })
      // Rede caiu, 404, CORS, abort — nada disso pode segurar o chat. E o
      // `vivo` impede que o abort da própria desmontagem chame `encerrar`.
      .catch(() => {
        if (vivo) encerrar();
      });

    return () => {
      vivo = false;
      controle.abort();
      // Sem isto o megabyte fica preso na memória até a aba fechar.
      if (url) URL.revokeObjectURL(url);
    };
  }, [encerrar]);

  // Rede lenta não vira tela travada.
  React.useEffect(() => {
    if (fonte) return;
    const t = window.setTimeout(encerrar, TETO_DE_CARREGAMENTO_MS);
    return () => window.clearTimeout(t);
  }, [fonte, encerrar]);

  // O relógio da animação. Como a fonte é um blob local, `onLoad` coincide com
  // o primeiro quadro: estes 9,6 s medem a animação, e não o download.
  React.useEffect(() => {
    if (!carregou) return;
    const t = window.setTimeout(encerrar, DURACAO_MS);
    return () => window.clearTimeout(t);
  }, [carregou, encerrar]);

  // Esc pula, como em qualquer camada sobreposta do sistema.
  React.useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") encerrar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [encerrar]);

  // ⭐ O foco vem PARA CÁ. O launcher, que estava focado quando o usuário
  // apertou Enter, é desmontado neste mesmo instante — sem isto o foco cai no
  // `document.body` e, por quase 10 segundos, quem navega por teclado fica tabulando
  // a página ATRÁS do overlay, sem nenhum controle alcançável e sem saber o que
  // está acontecendo. Com o botão focado, Enter/Espaço pulam e a pílula "Pular"
  // desenha o anel de foco.
  const botao = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    botao.current?.focus();
  }, []);

  return (
    // z-50 porque durante estes segundos ele É a camada da vez e precisa cobrir
    // o header sticky — e continua abaixo dos toasts (z-[100]), que devem
    // aparecer por cima de qualquer coisa.
    <div className="fixed inset-0 z-50">
      {/* Véu leve: o suficiente para o robô se destacar sobre uma tela cheia de
          tabela, longe do preto de modal. Mesma cor do overlay do painel. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 bg-[#0e1f2a]/40 backdrop-blur-[1px]",
          "animate-in fade-in-0 duration-500 motion-reduce:animate-none",
        )}
      />

      {/* ⭐ A SUPERFÍCIE DE PULAR é um <button> que cobre a tela inteira: clicar
          em qualquer lugar pula, e quem navega por teclado ou usa leitor de tela
          enxerga a mesma saída — coisa que um <div onClick> não daria.

          Ele contém APENAS a pílula, que é um <span>: `<button>` só aceita
          conteúdo de frase, e um `<div>` aqui dentro deixaria o HTML inválido,
          livre para o navegador reorganizar a árvore por conta própria. Por isso
          o robô é irmão do botão, e não filho. */}
      <button
        ref={botao}
        type="button"
        onClick={encerrar}
        aria-label="Pular a animação e abrir o Bitz"
        className={cn(
          "group absolute inset-0 block cursor-pointer",
          // Um anel em volta de um botão de tela inteira seria uma moldura na
          // viewport. O foco é desenhado na pílula, logo abaixo — por isso o
          // `group`, e por isso este `outline-none` NÃO é perda de acessibilidade.
          "focus-visible:outline-none",
        )}
      >
        <span
          className={cn(
            "absolute top-4 right-4 rounded-full px-3 py-1.5 text-xs font-medium md:top-6 md:right-6",
            "bg-background/80 text-foreground border-border/60 border backdrop-blur",
            "group-focus-visible:ring-ring group-focus-visible:ring-2 group-focus-visible:ring-offset-2",
          )}
        >
          Pular
        </span>
      </button>

      {/* ⭐ RENTE AO CANTO — `right-0 bottom-0`, sem respiro.
          O pedido foi que o robô pareça APOIADO no canto da tela, e é isso que
          o material entrega: o quadro do WebP já tem o robô encostado na borda
          e caminhando para dentro. Qualquer `right-6` aqui abre um vão entre
          ele e a borda, e ele passa a flutuar em vez de se apoiar.

          Este é o único lugar do módulo que encosta na borda; o launcher e o
          painel mantêm o respiro de sempre, porque ali não há metáfora de apoio
          e a faixa dos toasts precisa ficar livre.

          ⚠️ `pointer-events-none`: o robô é pintado DEPOIS do botão e ficaria por
          cima dele. Sem isto, clicar no próprio robô — o alvo mais óbvio da tela
          — não pularia nada. */}
      <div
        className={cn(
          "pointer-events-none absolute right-0 bottom-0",
          // ⚠️ O deslize só é aplicado DEPOIS que o arquivo chegou. Aplicá-lo na
          // montagem faz os 720 ms correrem enquanto o <img> ainda não tem
          // pixel nenhum: numa rede lenta a animação inteira termina antes de o
          // robô existir, e ele aparece de estalo, já parado, na posição final —
          // justamente a leitura de "saiu do canto da tela" que se queria.
          carregou &&
            "animate-[bitz-entrada_720ms_cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none",
        )}
      >
        <div
          aria-hidden
          className={cn(
            "absolute inset-x-[-25%] bottom-0 h-1/3 rounded-[50%] opacity-70 blur-2xl",
            "bg-[conic-gradient(from_140deg,var(--color-chart-1),var(--color-chart-3),var(--color-primary),var(--color-chart-2),var(--color-chart-1))]",
          )}
        />
        {/* Enquanto os bytes não chegam, o mascote estático segura o lugar — no
            mesmo canto e no mesmo tamanho em que o launcher estava um instante
            atrás, então o canto nunca fica vazio nem parece quebrado. */}
        {fonte === null ? (
          <span className="flex h-[min(354px,38svh)] w-[min(260px,28svh)] items-end justify-center">
            <BitzMascot size={56} aura priority />
          </span>
        ) : (
          /* Exibido em 1x (354 px de altura nativa) ou menos: ampliar um WebP de
             260 px de largura deixaria o robô borrado.

             `width`/`height` são a proporção intrínseca do arquivo. Com `w-auto`
             e sem eles, a caixa mede 0 px de largura e a aura colapsa junto. Se
             o asset for reexportado com outro enquadramento, mudam junto. */
          <img
            src={fonte}
            alt=""
            aria-hidden
            width={260}
            height={354}
            draggable={false}
            decoding="sync"
            // Fonte é um blob local: isto dispara no primeiro quadro. É daqui
            // que os 9,6 s passam a contar E que o marco "já viu" é queimado.
            onLoad={() => {
              setCarregou(true);
              onComecou?.();
            }}
            // Blob que não decodifica não pode segurar a abertura do chat.
            onError={encerrar}
            className="relative block h-[min(354px,38svh)] w-auto object-contain select-none"
          />
        )}
      </div>
    </div>
  );
}

export default BitzEntrada;
