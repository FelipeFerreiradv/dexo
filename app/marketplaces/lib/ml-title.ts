/**
 * Título de anúncio do Mercado Livre: sanitização (o que É publicado) e
 * comparação (o "mudou?" que decide propagar título / republicar item UP).
 *
 * Existe porque os dois lados divergiam. `ListingUseCase.buildMLTitle` publica
 * o nome SANITIZADO, mas `SyncUseCase.syncMLProductData` comparava o nome CRU
 * contra o `title` que o ML devolve. Em item User Product (UP) o ML ainda:
 *   - Title-Case-ia o `family_name` que enviamos, e
 *   - ANEXA ao título os atributos que diferenciam a família.
 *
 * Medido em produção (SKU 500542, MLB101763): enviamos family_name
 * "PORTA DIANTEIRA DIREITA BYD DOLPHIN PLUS 2024 2025 2026" e o item volta com
 * family_name "Porta Dianteira Direita Byd Dolphin Plus 2024 2025 2026" e title
 * "Porta ... 2026 Dianteira Direita Branco". Ou seja `product.name !== title`
 * é verdadeiro por construção, mesmo com o nome em Title Case perfeito — e a
 * consequência era republicar (fechar o anúncio e criar outro). 4.671 de 9.315
 * anúncios UP da base caíam nisso a cada save, sem nenhuma renomeação.
 *
 * Módulo PURO e folha do grafo de imports de propósito: `listing.usercase` e
 * `sync.usercase` formam um ciclo (contornado com `await import`), então a
 * primitiva compartilhada não pode morar em nenhum dos dois. Mesmo lugar e
 * mesmo espírito de `./listing-status.ts`.
 */

import { titleTokens } from "@/app/lib/title-similarity";

import { normalizeText } from "./title-parse";

/** Limite de título do ML usado em toda a criação de anúncio. */
export const ML_TITLE_MAX_LEN = 60;

/** Último recurso quando não sobra nada utilizável do nome nem do SKU. */
export const ML_TITLE_FALLBACK = "Produto";

/**
 * Piso para aceitar contenção como "mesmo título, truncado ou decorado".
 *
 * Sem ele um desejado curto ("Porta") seria engolido por qualquer remoto que o
 * contenha, e uma renomeação real de nome curto passaria despercebida.
 */
export const ML_TITLE_CONTAINMENT_FLOOR = 12;

/**
 * Algoritmo EXATO que `ListingUseCase.sanitizeTitle` aplicava inline — movido
 * para cá sem alteração de comportamento para que o re-sync consiga comparar
 * contra o MESMO valor que o caminho de criação publica.
 *
 * Ordem load-bearing: o fallback de SKU entra ANTES do truncamento (um SKU
 * longo é cortado igual), e o SKU NÃO passa pela regex de pontuação.
 *
 * Idempotente: `sanitizeMLTitle(sanitizeMLTitle(x)) === sanitizeMLTitle(x)`.
 * É o que garante que a republicação não derive o título a cada rodada.
 */
export function sanitizeMLTitle(
  raw?: string | null,
  fallbackSku?: string | null,
  maxLen: number = ML_TITLE_MAX_LEN,
): string {
  let fullTitle = (raw ?? "")
    .toString()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!fullTitle && fallbackSku) {
    fullTitle = String(fallbackSku);
  }

  if (fullTitle.length > maxLen) {
    fullTitle = fullTitle.substring(0, maxLen).trim();
  }

  return fullTitle || ML_TITLE_FALLBACK;
}

/** O título que o Dexo REALMENTE publica para este produto. */
export function buildMLTitleFrom(
  product?: { name?: string | null; sku?: string | null } | null,
): string {
  return sanitizeMLTitle(
    product?.name ?? "",
    product?.sku ?? null,
    ML_TITLE_MAX_LEN,
  );
}

/**
 * Forma canônica de comparação: sem acento, sem caixa, sem pontuação (hífen
 * incluído), espaço colapsado.
 *
 * A ORDEM É LOAD-BEARING: `normalizeText` faz NFD e remove as marcas
 * combinantes; só DEPOIS disso é seguro rodar a classe de pontuação. Aplicada
 * antes, `[^\p{L}\p{N}\s]` comeria os acentos decompostos (marca combinante é
 * \p{M}, não \p{L}) e "Reservatório" viraria "reservato rio".
 */
export function normalizeMLTitleForCompare(value?: string | null): string {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type MLTitleCompareReason =
  | "empty_desired"
  | "empty_remote"
  | "exact"
  | "remote_contains_desired"
  | "desired_contains_remote"
  | "different";

export interface MLTitleComparison {
  /** true = tratar como o MESMO título (não propagar, não republicar). */
  equivalent: boolean;
  reason: MLTitleCompareReason;
  normalizedDesired: string;
  normalizedRemote: string;
}

/**
 * Compara o título DESEJADO (`buildMLTitleFrom`) com o REMOTO (o que o ML
 * devolve em `family_name` ou `title`).
 *
 * Descritiva de propósito: devolve o motivo e deixa cada call-site decidir a
 * ação, porque o custo de errar difere muito entre eles — no sync de item UP a
 * ação é DESTRUTIVA (fecha o anúncio e cria outro); na criação é só um PUT.
 *
 * Fail-closed: qualquer lado vazio devolve `equivalent: true`, ou seja "não
 * age". Deixar de propagar um título custa infinitamente menos que duplicar um
 * anúncio.
 */
export function compareMLTitles(
  desired?: string | null,
  remote?: string | null,
  /**
   * Piso de contenção. O default protege o caminho DESTRUTIVO (republicação).
   * O caminho de criação passa 0 porque o `includes()` que ele tinha inline
   * nunca teve piso — manter o default ali mudaria o comportamento de 12 dos
   * 220.737 anúncios ativos, e a regra da casa é zero regressão, não "regressão
   * pequena".
   */
  containmentFloor: number = ML_TITLE_CONTAINMENT_FLOOR,
): MLTitleComparison {
  const normalizedDesired = normalizeMLTitleForCompare(desired);
  const normalizedRemote = normalizeMLTitleForCompare(remote);
  const base = { normalizedDesired, normalizedRemote };

  if (!normalizedDesired) {
    return { equivalent: true, reason: "empty_desired", ...base };
  }
  if (!normalizedRemote) {
    return { equivalent: true, reason: "empty_remote", ...base };
  }
  if (normalizedDesired === normalizedRemote) {
    return { equivalent: true, reason: "exact", ...base };
  }

  // Item UP: o ML deriva o title do family_name e ANEXA os atributos que
  // diferenciam a família ("... 2026 Dianteira Direita Branco").
  if (
    normalizedDesired.length >= containmentFloor &&
    normalizedRemote.includes(normalizedDesired)
  ) {
    return { equivalent: true, reason: "remote_contains_desired", ...base };
  }

  // Truncamento: o remoto é prefixo do desejado (anúncio publicado sob um cap
  // menor, ou family_name clipado pelo ML).
  if (
    normalizedRemote.length >= containmentFloor &&
    normalizedDesired.includes(normalizedRemote)
  ) {
    return { equivalent: true, reason: "desired_contains_remote", ...base };
  }

  return { equivalent: false, reason: "different", ...base };
}

/**
 * Guard de MATERIALIDADE, para o caminho DESTRUTIVO (republicação de item UP).
 *
 * Renomeação de verdade = o CONJUNTO DE TOKENS mudou. Reordenação, caixa,
 * acento, pontuação e palavras genéricas (usado/novo/par/kit — a stopword list
 * do `titleTokens`) não valem fechar um anúncio vivo e perder o MLB, as visitas
 * e a reputação.
 *
 * Reusa o tokenizador já testado de app/lib/title-similarity, mas NÃO o
 * `areTitlesSimilar`: o threshold 0.4 dele é heurístico de AGRUPAMENTO e
 * suprimiria renomeações legítimas (trocar o ano, acrescentar o modelo). Aqui a
 * regra é igualdade exata de conjunto — crisp e testável.
 *
 * Fail-closed: sem tokens de um dos lados, devolve false (não republica).
 */
export function isMaterialMLTitleChange(
  desired?: string | null,
  remote?: string | null,
): boolean {
  const a = titleTokens(normalizeMLTitleForCompare(desired));
  const b = titleTokens(normalizeMLTitleForCompare(remote));

  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return true;
  for (const token of a) {
    if (!b.has(token)) return true;
  }
  return false;
}
