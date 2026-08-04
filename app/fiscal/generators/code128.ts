/**
 * Encoder Code-128 subconjunto C — usado pelo DANFE para a chave de acesso.
 *
 * O DANFE oficial (ATO COTEPE/ICMS 51/15, item 3.1) exige a chave de 44 dígitos
 * impressa em CODE-128C no quadro "CONTROLE DO FISCO". O projeto não tem lib de
 * código de barras e não vale adicionar uma por ~120 linhas de tabela — o Code-128
 * é só uma sequência de larguras de barra/espaço somada a um checksum mod 103.
 *
 * Módulo PURO: sem pdf-lib, sem I/O. `drawCode128C` recebe a `page` por parâmetro
 * para manter o desenho testável e este arquivo livre de dependências.
 *
 * CONTRATO DE ROBUSTEZ: nada aqui lança. Entrada inválida (não-numérica, vazia,
 * comprimento ímpar) devolve `null` e o chamador simplesmente não desenha as
 * barras. O DANFE nunca deve falhar por causa do código de barras — a chave
 * também sai em texto logo abaixo, e o dado fiscal canônico está no XML.
 */

/**
 * Tabela canônica dos 107 símbolos do Code-128 (ISO/IEC 15417).
 *
 * Cada string tem 6 dígitos = larguras, em módulos, de barra/espaço alternados
 * começando por barra (b s b s b s), somando 11 módulos. A única exceção é o
 * símbolo 106 (STOP), com 7 elementos e 13 módulos — a barra final extra é o que
 * fecha o símbolo.
 *
 * Os índices 0..99 são os valores de dados; no subconjunto C cada um representa
 * o par de dígitos "00".."99". 105 = START C, 106 = STOP.
 */
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

/** Valor do símbolo START C. */
const START_C = 105;
/** Valor do símbolo STOP. */
const STOP = 106;

/**
 * Converte uma string de dígitos nos VALORES dos símbolos Code-128C, já com
 * START C na frente e checksum + STOP no fim.
 *
 * Devolve `null` quando a entrada não é codificável em subconjunto C: vazia,
 * com caractere não-numérico ou com quantidade ímpar de dígitos (o subconjunto C
 * codifica estritamente pares).
 */
export function code128cSymbols(digits: string): number[] | null {
  const s = String(digits ?? "");
  if (s.length === 0 || s.length % 2 !== 0 || !/^\d+$/.test(s)) return null;

  const symbols: number[] = [START_C];
  for (let i = 0; i < s.length; i += 2) {
    symbols.push(Number(s.slice(i, i + 2)));
  }

  // Checksum mod 103: valor do START + Σ (posição × valor), posição começando
  // em 1 no primeiro símbolo de dados.
  let sum = START_C;
  for (let i = 1; i < symbols.length; i++) {
    sum += i * symbols[i];
  }
  symbols.push(sum % 103);
  symbols.push(STOP);
  return symbols;
}

/**
 * Sequência plana de larguras de elementos, em módulos, alternando
 * barra/espaço e SEMPRE começando por barra.
 *
 * Para a chave de 44 dígitos: START C + 22 pares + checksum = 24 símbolos de 6
 * elementos (144) + STOP com 7 = **151 elementos** e 24×11 + 13 = **277 módulos**.
 */
export function code128cBars(digits: string): number[] | null {
  const symbols = code128cSymbols(digits);
  if (!symbols) return null;

  const widths: number[] = [];
  for (const sym of symbols) {
    const pattern = PATTERNS[sym];
    // Defensivo: símbolo fora da tabela nunca deve acontecer (o checksum é
    // mod 103 e os dados são pares 0..99), mas não vale arriscar um NaN
    // silencioso virando retângulo de largura inválida no PDF.
    if (!pattern) return null;
    for (const ch of pattern) widths.push(Number(ch));
  }
  return widths;
}

/** Soma dos módulos de uma sequência devolvida por `code128cBars`. */
export function totalModules(bars: number[]): number {
  return bars.reduce((acc, w) => acc + w, 0);
}

/** Alvo mínimo de desenho — abaixo disso o leitor óptico não resolve as barras. */
export const MIN_MODULE_PT = 0.5;

export interface Code128DrawOptions {
  /** Borda esquerda da ÁREA disponível (inclui as zonas mudas). */
  x: number;
  /** Borda inferior das barras. */
  y: number;
  /** Largura total disponível, incluindo as zonas mudas dos dois lados. */
  width: number;
  /** Altura das barras. */
  height: number;
  /** Zona muda de cada lado, em módulos (mínimo normativo = 10). */
  quietModules?: number;
}

/**
 * Superfície mínima de desenho que precisamos — mantém este módulo livre de
 * pdf-lib e testável com um objeto de mentira.
 *
 * Campos opcionais e `color` frouxo de propósito: é o que torna `PDFPage`
 * estruturalmente compatível sem importar os tipos do pdf-lib aqui.
 */
export interface RectTarget {
  drawRectangle(options: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    color?: any;
  }): void;
}

/**
 * Desenha a chave em Code-128C dentro da área dada, centralizada, com as zonas
 * mudas respeitadas. Devolve `true` quando desenhou.
 *
 * Devolve `false` (sem desenhar e sem lançar) quando a chave não é codificável
 * ou quando a área é tão estreita que o módulo cairia abaixo de `MIN_MODULE_PT`
 * — melhor não imprimir código de barras nenhum do que imprimir um ilegível que
 * o fiscal tenta bipar e falha.
 */
export function drawCode128C(
  page: RectTarget,
  black: unknown,
  digits: string,
  opts: Code128DrawOptions,
): boolean {
  try {
    const bars = code128cBars(digits);
    if (!bars) return false;

    const quiet = opts.quietModules ?? 10;
    const modules = totalModules(bars) + quiet * 2;
    if (modules <= 0) return false;

    const moduleW = opts.width / modules;
    if (!Number.isFinite(moduleW) || moduleW < MIN_MODULE_PT) return false;

    // Centraliza o símbolo na área: a sobra depois das zonas mudas mínimas é
    // dividida igualmente, então o código nunca fica colado numa das bordas.
    let cursor = opts.x + quiet * moduleW;
    for (let i = 0; i < bars.length; i++) {
      const w = bars[i] * moduleW;
      // Índices pares são barras, ímpares são espaços — só as barras são tinta.
      if (i % 2 === 0) {
        page.drawRectangle({
          x: cursor,
          y: opts.y,
          width: w,
          height: opts.height,
          color: black,
        });
      }
      cursor += w;
    }
    return true;
  } catch {
    // Blindagem final: o DANFE inteiro não pode cair por causa do código de
    // barras (a chave sai em texto logo abaixo de qualquer forma).
    return false;
  }
}
