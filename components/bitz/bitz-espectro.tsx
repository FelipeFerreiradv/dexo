"use client";

import * as React from "react";

import {
  ALTURA_MINIMA,
  BARRAS,
  DESCIDA,
  DESCIDA_CALMA,
  PARADAS,
  SUBIDA,
  SUBIDA_CALMA,
  alturaDaBarra,
  alturaEmRepouso,
  binDaBarra,
} from "./bitz-espectro-math";

/**
 * O ESPECTRO DE ONDAS da tela de escuta — barras simétricas que reagem à voz.
 *
 * ⭐ ELE LÊ O ÁUDIO DE VERDADE. `AnalyserNode` pendurado no MESMO `MediaStream`
 * que o `MediaRecorder` está gravando. Isso não é preciosismo estético: uma
 * animação em CSS ou um vídeo em loop se mexem igual quando o lojista fala e
 * quando ele está calado — e a única pergunta que essa tela precisa responder é
 * "o microfone está me ouvindo?". Uma onda que dança no silêncio responde
 * "sim" quando a resposta é "não", que é pior do que não ter onda nenhuma.
 *
 * ⚠️ NENHUM `useState` NO LOOP. O desenho roda em `requestAnimationFrame`
 * escrevendo direto no `<canvas>`; 60 quadros por segundo virando 60 renders do
 * React travariam o painel inteiro no celular do galpão, que é exatamente onde
 * este recurso é usado. O React monta o canvas uma vez e sai da frente.
 *
 * ⚠️ E NADA DISSO É A GRAVAÇÃO. Se o `AudioContext` não existir, se o navegador
 * recusar, se qualquer coisa aqui falhar — as barras ficam na linha de base e a
 * gravação segue intacta. Este arquivo é enfeite com opinião, nunca caminho
 * crítico.
 *
 * A matemática mora em `bitz-espectro-math.ts`, sem React e sem JSX, para poder
 * ser testada com números em vez de asserções sobre texto de arquivo — e não é
 * zelo abstrato: o defeito que deixou a primeira versão desta onda parada era
 * exatamente do tipo que só um teste numérico pega.
 */
export function BitzEspectro({
  streamRef,
  ativo,
  className,
}: {
  /**
   * ⭐⭐ REF, NÃO PROP DE VALOR — e a diferença é a razão de esta tela ter
   * ficado parada uma vez.
   *
   * Com o stream vindo como prop, o espectro dependia de o React re-renderizar
   * no instante certo entre `getUserMedia` resolver e o `MediaRecorder` começar.
   * Ele lia o valor UMA vez, na montagem, e se naquele render o stream ainda
   * fosse `null`, ficava na linha de base para sempre — sem erro, sem aviso,
   * com a tela inteira parecendo funcionar.
   *
   * Com o ref, o laço pergunta a cada quadro: apareceu stream? Liga o
   * analisador. Sumiu? Desliga e volta ao repouso. Não existe mais um instante
   * crítico para errar.
   */
  streamRef: React.RefObject<MediaStream | null>;
  /** Gravando? Fora disso a onda descansa (transcrevendo, por exemplo). */
  ativo: boolean;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Alturas atuais (0..1), suavizadas quadro a quadro. Fora do React de
    // propósito — ver o cabeçalho.
    const alturas = new Float32Array(BARRAS).fill(0);
    const meio = (BARRAS - 1) / 2;

    let largura = 0;
    let altura = 0;

    /** Redimensiona respeitando a densidade da tela — senão a barra fica borrada. */
    const medir = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      largura = Math.max(1, Math.floor(r.width));
      altura = Math.max(1, Math.floor(r.height));
      canvas.width = largura * dpr;
      canvas.height = altura * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    medir();

    const desenhar = () => {
      ctx.clearRect(0, 0, largura, altura);

      const passo = largura / BARRAS;
      const espessura = Math.max(2, Math.min(6, passo * 0.42));
      const metadeDaTela = altura / 2;

      const gradiente = ctx.createLinearGradient(0, 0, largura, 0);
      for (const [pos, cor] of PARADAS) gradiente.addColorStop(pos, cor);
      ctx.strokeStyle = gradiente;
      ctx.lineWidth = espessura;
      ctx.lineCap = "round";

      for (let i = 0; i < BARRAS; i++) {
        const x = passo * (i + 0.5);
        // Metade da altura para cada lado: a barra cresce do centro para fora,
        // simétrica, como no espectro de referência.
        const h = Math.max(espessura / 2, alturas[i] * metadeDaTela * 0.94);
        ctx.beginPath();
        ctx.moveTo(x, metadeDaTela - h);
        ctx.lineTo(x, metadeDaTela + h);
        ctx.stroke();
      }
    };

    /** O repouso: o fuso baixinho da referência, quando não há o que ouvir. */
    const repousar = () => {
      for (let i = 0; i < BARRAS; i++) {
        const alvo = alturaEmRepouso(Math.abs(i - meio) / meio);
        alturas[i] += (alvo - alturas[i]) * 0.15;
      }
    };

    const aoRedimensionar = () => medir();
    window.addEventListener("resize", aoRedimensionar);

    // -----------------------------------------------------------------------
    // ⭐ MOVIMENTO REDUZIDO NÃO CONGELA A ONDA — e a decisão merece o parágrafo.
    //
    // A primeira versão desenhava uma linha estática e ia embora. Está errado:
    // `prefers-reduced-motion` existe para tirar movimento DECORATIVO, e esta
    // onda não é decoração — ela é a única confirmação visual de que o
    // microfone está captando. Congelá-la remove a informação junto com a
    // animação, e quem ligou a preferência fica sem saber se pode falar.
    //
    // O que muda é o TEMPERAMENTO: a onda passa a subir e descer devagar, sem
    // o repique nervoso dos picos. Continua respondendo à voz, sem piscar.
    // -----------------------------------------------------------------------
    const calmo =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const subida = calmo ? SUBIDA_CALMA : SUBIDA;
    const descida = calmo ? DESCIDA_CALMA : DESCIDA;

    const Contexto: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    // Sem Web Audio, ou fora de uma gravação: o desenho é o repouso, uma vez.
    if (!Contexto || !ativo) {
      for (let i = 0; i < 30; i++) repousar();
      desenhar();
      return () => window.removeEventListener("resize", aoRedimensionar);
    }

    let audio: AudioContext | null = null;
    let analisador: AnalyserNode | null = null;
    let fonte: MediaStreamAudioSourceNode | null = null;
    let ligadoEm: MediaStream | null = null;
    // ⚠️ `Uint8Array<ArrayBuffer>`, e não o `Uint8Array` solto: desde o TS 5.7 o
    // tipo é genérico sobre o buffer, e `getByteFrequencyData` exige um apoiado
    // em `ArrayBuffer` de verdade — um `ArrayBufferLike` (que aceitaria
    // `SharedArrayBuffer`) não compila.
    let dados: Uint8Array<ArrayBuffer> | null = null;
    let quadro = 0;

    /** Liga (ou religa) o analisador no stream que estiver no ref agora. */
    const conectar = (stream: MediaStream) => {
      if (!audio || !analisador) return;
      try {
        fonte?.disconnect();
      } catch {
        // Nó já solto não é problema de ninguém.
      }
      fonte = audio.createMediaStreamSource(stream);
      fonte.connect(analisador);
      // ⚠️ E NÃO LIGA NA SAÍDA DE ÁUDIO. Pendurar o analisador na saída
      // devolveria a própria voz pelo alto-falante, com atraso — microfonia
      // garantida em quem estiver sem fone.
      ligadoEm = stream;
    };

    try {
      audio = new Contexto();
      analisador = audio.createAnalyser();
      // 1024 dá 512 faixas — resolução de sobra para 45 barras, e metade do
      // custo de 2048. O smoothing do próprio nó já tira o tremor mais fino.
      analisador.fftSize = 1024;
      analisador.smoothingTimeConstant = 0.62;
      dados = new Uint8Array(analisador.frequencyBinCount);

      // Alguns navegadores criam o contexto suspenso; sem isto o analisador
      // devolve silêncio para sempre e a onda nunca se mexe.
      void audio.resume?.().catch(() => {});
    } catch {
      for (let i = 0; i < 30; i++) repousar();
      desenhar();
      return () => window.removeEventListener("resize", aoRedimensionar);
    }

    const passoDoQuadro = () => {
      const atual = streamRef.current;

      // ⭐ O ref é lido A CADA QUADRO. Stream que chega atrasado entra sozinho;
      // stream que morre (o `stop()` das trilhas) devolve a onda ao repouso no
      // quadro seguinte — ela nunca sobrevive ao microfone.
      if (atual && atual !== ligadoEm) conectar(atual);

      if (!atual || !analisador || !dados) {
        repousar();
      } else {
        analisador.getByteFrequencyData(dados);
        for (let i = 0; i < BARRAS; i++) {
          const d = Math.abs(i - meio);
          const byte = dados[binDaBarra(d, meio, dados.length)];
          const alvo = alturaDaBarra(byte, d / meio);
          const anterior = alturas[i];
          alturas[i] =
            anterior + (alvo - anterior) * (alvo > anterior ? subida : descida);
        }
      }

      desenhar();
      quadro = window.requestAnimationFrame(passoDoQuadro);
    };
    quadro = window.requestAnimationFrame(passoDoQuadro);

    return () => {
      window.removeEventListener("resize", aoRedimensionar);
      if (quadro) window.cancelAnimationFrame(quadro);
      // ⚠️ FECHAR O CONTEXTO É OBRIGATÓRIO, não higiene. O navegador limita
      // quantos `AudioContext` uma aba pode ter (~6 no Chrome); vazar um por
      // gravação faz o sétimo áudio do dia lançar — e o sintoma apareceria como
      // "a onda parou de funcionar", longe daqui.
      try {
        fonte?.disconnect();
        void audio?.close();
      } catch {
        // Contexto já fechado não é problema de ninguém.
      }
    };
  }, [streamRef, ativo]);

  // `aria-hidden`: quem usa leitor de tela recebe a informação pelo cronômetro
  // e pela legenda. Uma canvas não tem o que anunciar.
  return <canvas ref={canvasRef} aria-hidden className={className} />;
}

export { ALTURA_MINIMA };
export default BitzEspectro;
