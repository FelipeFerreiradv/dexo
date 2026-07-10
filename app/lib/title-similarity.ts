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
