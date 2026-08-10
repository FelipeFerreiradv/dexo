// A matemática do espectro de ondas da tela de escuta.
//
// ⭐ ARQUIVO SEPARADO, SEM REACT E SEM JSX, e é o que torna esta parte
// TESTÁVEL DE VERDADE. A suíte roda em `environment: "node"`: um componente com
// `<canvas>` só pode ser verificado lendo o próprio código-fonte, o que prova
// que uma linha existe — não que ela calcula certo. Aqui não: cada função
// abaixo recebe número e devolve número, e o spec pergunta pelo resultado.
//
// ⚠️ E ISSO NÃO É ZELO ABSTRATO. O defeito que deixou a primeira versão da onda
// praticamente parada era exatamente desta natureza: as barras centrais liam o
// bin 0 da FFT. Nenhuma asserção sobre texto de arquivo pegaria; uma sobre o
// número pega na hora.

/** Ímpar de propósito: existe uma barra CENTRAL de verdade, não uma emenda. */
export const BARRAS = 45;

/** Altura mínima: no silêncio as barras viram os pontinhos das pontas. */
export const ALTURA_MINIMA = 0.03;

/**
 * ⭐⭐ A FAIXA DE FREQUÊNCIA QUE CADA BARRA LÊ — e o conserto do defeito que
 * deixou a primeira versão desta tela praticamente parada.
 *
 * ⚠️ A VERSÃO ANTERIOR MANDAVA AS BARRAS CENTRAIS LEREM O BIN 0. Numa FFT o bin
 * 0 é a componente CONTÍNUA (0 Hz) — ele é ~zero por definição, aconteça o que
 * acontecer com a voz — e o 1 é infrassom. Como o centro é onde ficam as barras
 * mais altas e mais visíveis, o efeito era o pior possível: a parte da onda que
 * a pessoa olha era exatamente a que nunca se mexia.
 *
 * Agora o centro começa no bin 2 e a distribuição concentra barras na região em
 * que a fala vive de verdade: fundamental de 85–255 Hz e formantes fortes até
 * ~2 kHz. As pontas varrem o resto até ~7 kHz, onde só sobra sopro e chiado.
 */
export const BIN_MINIMO = 2;
export const BIN_MAXIMO = 160;

/**
 * ⭐ PISO DE RUÍDO. `getByteFrequencyData` mapeia dB para 0–255 numa janela que
 * começa em −100 dB, então uma sala silenciosa ainda devolve algo em torno de
 * 40–60 em várias faixas. Sem descontar isso, a onda fica com uma barriga
 * permanente e o contraste entre "calado" e "falando" some — que é justamente o
 * contraste que esta tela existe para mostrar.
 */
export const PISO_DE_RUIDO = 0.22;

/**
 * Sobe rápido, desce devagar.
 *
 * A voz tem picos curtos; sem essa assimetria a onda pisca em vez de ondular, e
 * o resultado parece defeito de renderização, não energia sonora.
 */
export const SUBIDA = 0.5;
export const DESCIDA = 0.14;

/** Com movimento reduzido a onda continua reagindo, só que mais calma. */
export const SUBIDA_CALMA = 0.16;
export const DESCIDA_CALMA = 0.07;

/**
 * ⭐ AS CORES SÃO FIXAS, e é a única superfície do sistema onde isso é certo.
 *
 * Gravar é um estado modal deliberado — a tela escurece para dizer "o microfone
 * está aberto" —, então ela não segue o tema claro/escuro do usuário: ela é
 * sempre a mesma, em qualquer tema, como a tela de chamada de um telefone. As
 * cores são as da marca (`app/globals.css`): Amarelo Sinalização no centro,
 * Pergaminho Técnico nos flancos, Verde Operação apagando nas pontas.
 */
export const PARADAS: Array<[number, string]> = [
  [0, "rgba(44,95,79,0.45)"],
  [0.22, "rgba(242,237,226,0.8)"],
  [0.5, "#f2c419"],
  [0.78, "rgba(242,237,226,0.8)"],
  [1, "rgba(44,95,79,0.45)"],
];

/**
 * O quanto uma barra pode crescer, conforme a distância do centro (0 a 1).
 *
 * É o que dá o formato de fuso da referência — alto no meio, sumindo nas
 * pontas — mesmo quando todas as faixas de frequência estão cheias.
 */
export function tetoDaBarra(distanciaNormalizada: number): number {
  return Math.pow(Math.cos((distanciaNormalizada * Math.PI) / 2), 1.5);
}

/** A faixa de frequência que alimenta cada barra. Ver `BIN_MINIMO`. */
export function binDaBarra(
  distancia: number,
  meio: number,
  bins: number,
): number {
  const teto = Math.min(BIN_MAXIMO, bins - 1);
  const faixa = Math.max(1, teto - BIN_MINIMO);
  // Curva, não linear: mais barras cobrindo os graves e médios (onde está a
  // energia da fala) e menos varrendo os agudos, que numa voz são quase nada.
  //
  // ⚠️ O EXPOENTE É CALIBRADO, não escolhido a gosto: com 1.6 apenas 43% das
  // barras caíam abaixo de 2 kHz, e a onda ficava tímida numa conversa normal.
  // Com 2.4 são 56% — o teste da distribuição prende esse número.
  const t = Math.min(1, Math.max(0, distancia / meio));
  return Math.min(teto, BIN_MINIMO + Math.floor(Math.pow(t, 2.4) * faixa));
}

/** Byte cru (0–255) → energia útil (0–1), já sem o ruído de fundo da sala. */
export function energiaDaBarra(byte: number): number {
  const bruto = byte / 255;
  if (bruto <= PISO_DE_RUIDO) return 0;
  const acima = (bruto - PISO_DE_RUIDO) / (1 - PISO_DE_RUIDO);
  // Expoente < 1 levanta os valores médios: fala normal, a alguns palmos do
  // microfone, tem de encher a onda — não fazer cócegas nela.
  return Math.pow(acima, 0.7);
}

/** Altura final (0–1) de uma barra, dado o byte da FFT e a posição dela. */
export function alturaDaBarra(byte: number, distanciaNormalizada: number): number {
  return (
    ALTURA_MINIMA +
    energiaDaBarra(byte) * tetoDaBarra(distanciaNormalizada) * (1 - ALTURA_MINIMA)
  );
}

/** Altura de repouso: o fuso baixinho de quando não há o que ouvir. */
export function alturaEmRepouso(distanciaNormalizada: number): number {
  return ALTURA_MINIMA * tetoDaBarra(distanciaNormalizada) * 2;
}
