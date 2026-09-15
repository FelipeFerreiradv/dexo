/**
 * Similaridade de títulos de anúncio, usada para distinguir:
 *  - MESMO produto anunciado várias vezes (títulos ~idênticos) → agrupar;
 *  - produtos DIFERENTES colapsados por um SKU de caixa reutilizado (títulos
 *    claramente distintos, ex.: "Mangueira Kangoo" vs "Mangueira Pajero") →
 *    separar.
 *
 * Jaccard de tokens (interseção/união), ignorando acentos e palavras genéricas
 * (usado/novo/par/kit…) que inflam a similaridade entre peças diferentes.
 */

const STOPWORDS = new Set([
  "usado",
  "usada",
  "novo",
  "nova",
  "seminovo",
  "par",
  "kit",
  "jogo",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "com",
  "sem",
  "para",
  "pra",
  "the",
]);

export function titleTokens(value: string): Set<string> {
  return new Set(
    (value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Acima disto os títulos são considerados o MESMO produto (agrupa). Abaixo, são
// produtos diferentes (separa). Conservador: só separa quando CLARAMENTE difere,
// preservando o comportamento atual (agrupar) na dúvida.
export const TITLE_GROUP_THRESHOLD = 0.4;

export function areTitlesSimilar(
  a: string,
  b: string,
  threshold = TITLE_GROUP_THRESHOLD,
): boolean {
  return titleSimilarity(a, b) >= threshold;
}

// ===========================================================================
// LADO E EIXO — o ponto cego do Jaccard num desmanche
// ===========================================================================
//
// `titleTokens` descarta tokens de 1 caractere (`w.length >= 2`). A notação
// compacta do ramo — `L/e`, `L/d`, `T/e`, `T/d` — vira `["l","e"]` e `["l","d"]`
// e os QUATRO tokens são jogados fora. Resultado medido em produção:
//
//   "Amortecedor Tampa Do Porta Malas L/e Volkswagen Gol 2021"
//   "Amortecedor Tampa Do Porta Malas L/d Volkswagen Gol 2021"
//   titleSimilarity = 1,00
//
// Peças OPOSTAS com semelhança PERFEITA. Mesmo escrito por extenso o Jaccard
// aprova, porque o lado é 1 token entre 7:
//
//   "Pinça Freio Dianteira Esquerda Gol G5" x "...Direita Gol G5"  -> 0,82
//   "Alça Teto Traseiro Jetta 2011..."      x "...Dianteiro..."    -> 0,83
//
// Num desmanche lado e eixo são justamente o que separa duas peças físicas
// distintas, e o tokenizador apaga exatamente esse sinal.
//
// ⚠️ USAR JUNTO de `areTitlesSimilar`, NUNCA no lugar dela: esta função
// responde "são peças opostas?", não "são a mesma peça?".
//
// A regra é assimétrica de propósito: só acusa quando os DOIS títulos declaram
// e eles divergem. Título omisso não acusa nada — silêncio não é evidência.
// Isso mantém o falso positivo em zero no caso comum ("Farol Esquerdo Gol" x
// "Farol Gol"), e é o que permite ligar a guarda sem regressão.

export type TitleSide = "E" | "D";
export type TitleAxis = "DIANT" | "TRAS";

function withoutAccents(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Lado declarado pelo título, ou `null` quando omisso ou ambíguo (os dois lados
 * no mesmo título, como em "Par Lanterna Esquerda e Direita").
 *
 * ⚠️ As bordas `\b` das formas compactas são obrigatórias: sem elas o "le" de
 * "Lente Do Farol" casaria como lado esquerdo.
 */
export function titleSide(title: string): TitleSide | null {
  const s = withoutAccents(title);
  // Além de "esquerda/esquerdo": l/e (lado esq), t/e (traseira esq) e
  // d/e (dianteira esq) — com separador opcional, como o ramo escreve.
  const left = /\besquerd[ao]\b/.test(s) || /\b[ltd][/.\s-]?e\b/.test(s);
  const right = /\bdireit[ao]\b/.test(s) || /\b[ltd][/.\s-]?d\b/.test(s);
  if (left && !right) return "E";
  if (right && !left) return "D";
  return null;
}

/** Eixo declarado pelo título, ou `null` quando omisso ou ambíguo. */
export function titleAxis(title: string): TitleAxis | null {
  const s = withoutAccents(title);
  const front = /\bdianteir[ao]s?\b/.test(s);
  const rear = /\btraseir[ao]s?\b/.test(s);
  if (front && !rear) return "DIANT";
  if (rear && !front) return "TRAS";
  return null;
}

/** `true` quando os dois títulos declaram lado ou eixo e se contradizem. */
export function isOppositeSideOrAxis(a: string, b: string): boolean {
  const sideA = titleSide(a);
  const sideB = titleSide(b);
  if (sideA && sideB && sideA !== sideB) return true;
  const axisA = titleAxis(a);
  const axisB = titleAxis(b);
  return Boolean(axisA && axisB && axisA !== axisB);
}

/** Texto curto para log: "lado ExD", "eixo DIANTxTRAS", ou "" quando não há. */
export function oppositionReason(a: string, b: string): string {
  const parts: string[] = [];
  const sideA = titleSide(a);
  const sideB = titleSide(b);
  if (sideA && sideB && sideA !== sideB) parts.push(`lado ${sideA}x${sideB}`);
  const axisA = titleAxis(a);
  const axisB = titleAxis(b);
  if (axisA && axisB && axisA !== axisB) parts.push(`eixo ${axisA}x${axisB}`);
  return parts.join(" + ");
}
