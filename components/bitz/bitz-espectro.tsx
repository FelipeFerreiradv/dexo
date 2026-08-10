"use client";

import * as React from "react";

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
 */

/** Ímpar de propósito: existe uma barra CENTRAL de verdade, não uma emenda. */
const BARRAS = 45;

/** Altura mínima: no silêncio as barras viram os pontinhos das pontas. */
const ALTURA_MINIMA = 0.035;

/**
 * Sobe rápido, desce devagar.
 *
 * A voz tem picos curtos; sem essa assimetria a onda pisca em vez de ondular, e
 * o resultado parece defeito de renderização, não energia sonora.
 */
const SUBIDA = 0.45;
const DESCIDA = 0.12;

/**
 * ⭐ AS CORES SÃO FIXAS, e é a única superfície do sistema onde isso é certo.
 *
 * Gravar é um estado modal deliberado — a tela escurece para dizer "o microfone
 * está aberto" —, então ela não segue o tema claro/escuro do usuário: ela é
 * sempre a mesma, em qualquer tema, como a tela de chamada de um telefone. As
 * cores são as da marca (`app/globals.css`): Amarelo Sinalização no centro,
 * Pergaminho Técnico nos flancos, Verde Operação apagando nas pontas.
 */
const PARADAS: Array<[number, string]> = [
  [0, "rgba(44,95,79,0.45)"],
  [0.22, "rgba(242,237,226,0.8)"],
  [0.5, "#f2c419"],
  [0.78, "rgba(242,237,226,0.8)"],
  [1, "rgba(44,95,79,0.45)"],
];

/**
 * O quanto uma barra pode crescer, conforme a distância do centro.
 *
 * É o que dá o formato de fuso da referência — alto no meio, sumindo nas
 * pontas — mesmo quando todas as faixas de frequência estão cheias.
 */
function tetoDaBarra(distanciaNormalizada: number): number {
  return Math.pow(Math.cos((distanciaNormalizada * Math.PI) / 2), 1.5);
}

/** A faixa de frequência que alimenta cada barra. Voz humana vive nas baixas. */
function binDaBarra(distancia: number, meio: number, bins: number): number {
  const t = distancia / meio;
  // Curva, não linear: as primeiras barras cobrem os graves (onde está a
  // energia da fala) e as últimas varrem o resto do espectro de uma vez.
  const alvo = Math.pow(t, 1.7) * 0.22;
  return Math.min(bins - 1, Math.floor(alvo * bins));
}

export function BitzEspectro({
  stream,
  ativo,
  className,
}: {
  /** O stream que está sendo gravado. `null` ⇒ linha de base parada. */
  stream: MediaStream | null;
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

      const meio = (BARRAS - 1) / 2;
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
        const h = Math.max(espessura, alturas[i] * metadeDaTela * 0.92);
        ctx.beginPath();
        ctx.moveTo(x, metadeDaTela - h);
        ctx.lineTo(x, metadeDaTela + h);
        ctx.stroke();
      }
    };

    // -----------------------------------------------------------------------
    // Sem movimento: uma linha de base desenhada UMA vez.
    //
    // `prefers-reduced-motion` não é preferência estética — há quem passe mal
    // com movimento. A tela continua dizendo tudo que precisa pelo cronômetro e
    // pela legenda; o que some é só a dança.
    // -----------------------------------------------------------------------
    const semMovimento =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (semMovimento || !stream || !ativo) {
      for (let i = 0; i < BARRAS; i++) {
        const d = Math.abs(i - (BARRAS - 1) / 2) / ((BARRAS - 1) / 2);
        alturas[i] = ALTURA_MINIMA * tetoDaBarra(d) * 3;
      }
      desenhar();
      const aoRedimensionar = () => {
        medir();
        desenhar();
      };
      window.addEventListener("resize", aoRedimensionar);
      return () => window.removeEventListener("resize", aoRedimensionar);
    }

    // -----------------------------------------------------------------------
    // O caminho vivo: analisador ligado no stream que já está gravando.
    // -----------------------------------------------------------------------
    const Contexto: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!Contexto) {
      desenhar();
      return;
    }

    let audio: AudioContext | null = null;
    let fonte: MediaStreamAudioSourceNode | null = null;
    let quadro = 0;

    try {
      audio = new Contexto();
      const analisador = audio.createAnalyser();
      // 1024 dá 512 faixas — resolução de sobra para 45 barras, e metade do
      // custo de 2048. O smoothing do próprio nó já tira o tremor mais fino.
      analisador.fftSize = 1024;
      analisador.smoothingTimeConstant = 0.7;

      fonte = audio.createMediaStreamSource(stream);
      fonte.connect(analisador);
      // ⚠️ E NÃO CONECTA NA SAÍDA. Ligar o analisador em `audio.destination`
      // devolveria a própria voz pelo alto-falante, com atraso — microfonia
      // garantida em quem estiver sem fone.

      const dados = new Uint8Array(analisador.frequencyBinCount);
      const meio = (BARRAS - 1) / 2;

      // Alguns navegadores criam o contexto suspenso; sem isto o analisador
      // devolve silêncio para sempre e a onda nunca se mexe.
      void audio.resume?.().catch(() => {});

      const passo = () => {
        analisador.getByteFrequencyData(dados);

        for (let i = 0; i < BARRAS; i++) {
          const d = Math.abs(i - meio);
          const bin = binDaBarra(d, meio, dados.length);
          const bruto = dados[bin] / 255;
          const alvo =
            ALTURA_MINIMA + bruto * tetoDaBarra(d / meio) * (1 - ALTURA_MINIMA);
          const atual = alturas[i];
          alturas[i] =
            atual + (alvo - atual) * (alvo > atual ? SUBIDA : DESCIDA);
        }

        desenhar();
        quadro = window.requestAnimationFrame(passo);
      };
      quadro = window.requestAnimationFrame(passo);
    } catch {
      // Navegador recusou o contexto. Linha de base, e a gravação segue.
      desenhar();
    }

    const aoRedimensionar = () => medir();
    window.addEventListener("resize", aoRedimensionar);

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
  }, [stream, ativo]);

  // `aria-hidden`: quem usa leitor de tela recebe a informação pelo cronômetro
  // e pela legenda. Uma canvas não tem o que anunciar.
  return <canvas ref={canvasRef} aria-hidden className={className} />;
}

export default BitzEspectro;
