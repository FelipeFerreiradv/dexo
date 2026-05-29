/**
 * Utilitários puros de normalização e match de texto para a busca de
 * Localizações. Sem dependências de React/DOM — testáveis isoladamente.
 *
 * A busca é tolerante a: caixa, acentuação, espaços extras e múltiplos termos
 * (AND entre tokens, OR entre campos). Substring/match parcial por padrão.
 */

/**
 * Normaliza um texto para comparação: remove acentos/diacríticos, baixa a
 * caixa, apara as pontas e colapsa espaços internos.
 *
 * Ex.: "  Galpão   Norte " → "galpao norte"
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Quebra a query em tokens normalizados (split por espaço). Query vazia ou só
 * com espaços → lista vazia (que faz `matchesTokens` aceitar tudo).
 */
export function tokenize(query: string | null | undefined): string[] {
  const normalized = normalizeText(query);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** Campos textuais de uma localização considerados na busca. */
export interface SearchableFields {
  code: string;
  description?: string | null;
  fullPath?: string | null;
}

/**
 * Retorna true se TODOS os tokens casarem com ALGUM dos campos (AND entre
 * tokens, OR entre campos). Lista de tokens vazia → true (sem filtro).
 */
export function matchesTokens(
  tokens: string[],
  fields: SearchableFields,
): boolean {
  if (tokens.length === 0) return true;
  const haystacks = [
    normalizeText(fields.code),
    normalizeText(fields.description),
    normalizeText(fields.fullPath),
  ];
  return tokens.every((token) => haystacks.some((hay) => hay.includes(token)));
}

/**
 * Pontua a relevância de um match (menor = mais relevante). Usado apenas como
 * critério de desempate futuro — NÃO reordena a árvore (que preserva a
 * hierarquia por `code`). Mantido puro e barato.
 */
export function scoreMatch(tokens: string[], fields: SearchableFields): number {
  if (tokens.length === 0) return 0;
  const code = normalizeText(fields.code);
  const path = normalizeText(fields.fullPath);
  if (tokens.every((t) => code.startsWith(t))) return 0;
  if (tokens.some((t) => code.startsWith(t))) return 10;
  if (code.includes(tokens.join(" "))) return 20;
  if (tokens.every((t) => code.includes(t))) return 30;
  if (path && tokens.every((t) => path.includes(t))) return 40;
  return 100;
}
