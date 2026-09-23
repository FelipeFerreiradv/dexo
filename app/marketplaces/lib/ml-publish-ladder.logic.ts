/**
 * Decisões puras da escada de retentativas do `createMLListing`.
 *
 * 1. family_name de primeira para vendedor "User Products".
 *    Conta com a tag `user_product_seller` (GET /users/me) só publica item
 *    novo com `family_name` e sem `title` (documentação User Products do ML).
 *    Sem saber disso, a 1ª tentativa ia com `title` e SEMPRE levava 369
 *    ("body.required_fields [family_name]") — 2.917 vezes em 6 dias de log —
 *    e só a retentativa acertava. O corpo que a Dexo passa a mandar de
 *    primeira é EXATAMENTE o que o degrau `family_name` já mandava depois do
 *    369 (payload + family_name − title).
 *
 * 2. Categoria sugerida pelo ML só por erro DE CATEGORIA.
 *    O último degrau pedia uma categoria ao domain_discovery para QUALQUER
 *    erro. Nos logs de 16-22/09/2026 nenhum erro foi de categoria: todas as
 *    238 tentativas em categoria sugerida vieram de erro de DADO (INMETRO,
 *    unidade, GTIN...). 221 falharam com uma mensagem da categoria errada e
 *    17 publicaram em categoria que a pessoa não escolheu, sem aviso.
 */

export interface LadderCause {
  code?: string | null;
  message?: string | null;
  type?: string | null;
}

export const ML_USER_PRODUCT_SELLER_TAG = "user_product_seller";

export function isUserProductSeller(tags: unknown): boolean {
  return Array.isArray(tags) && tags.includes(ML_USER_PRODUCT_SELLER_TAG);
}

/**
 * Causa que diz "a categoria não serve para este item" (e não "um dado do
 * item está errado"). Lista FECHADA de códigos: um regex solto pegaria o 7712
 * (`product_identifier.invalid_by_domain_catalog`, que é GTIN errado).
 */
export function isCategoryShapedCause(c: LadderCause | null | undefined): boolean {
  const code = String(c?.code ?? "").toLowerCase();
  if (!code) return false;
  return (
    code.startsWith("item.category_id.") ||
    code.startsWith("item.domain_id.") ||
    code === "item.condition.invalid"
  );
}

/**
 * Pode tentar a categoria sugerida pelo ML? Só se alguma tentativa NA
 * CATEGORIA PEDIDA recebeu erro de categoria. ML_SUGGESTED_CATEGORY_ANY_ERROR=1
 * devolve o comportamento anterior (qualquer erro).
 */
export function maySuggestAnotherCategory(i: {
  requestedCategoryCauses: Array<LadderCause[] | null | undefined>;
  anyErrorOverride?: boolean;
}): boolean {
  if (i.anyErrorOverride) return true;
  return i.requestedCategoryCauses.some(
    (causes) => Array.isArray(causes) && causes.some(isCategoryShapedCause),
  );
}

/**
 * Depois do family_name de primeira, o ML pediu `title` ou recusou o
 * `family_name`? Então o degrau reverso manda o corpo de antes (com título,
 * sem family_name). Qualquer outra recusa (dado da ficha, foto, medida) segue
 * a escada normal — reenviar com título só repetiria a recusa.
 */
export function shouldRetryWithTitle(
  causes: LadderCause[] | null | undefined,
  message?: string | null,
): boolean {
  const lista = Array.isArray(causes) ? causes : [];
  const pedeTitulo = (texto: string) =>
    /required_fields[^a-z]*\[?[^\]]*\btitle\b/.test(texto) ||
    /\btitle\b[^.]*\brequired\b/.test(texto) ||
    /\bitem\.title\.required\b/.test(texto);
  const recusaFamily = (texto: string) => /family_name/.test(texto);
  for (const c of lista) {
    if (String(c?.type ?? "error").toLowerCase() === "warning") continue;
    const texto = `${c?.code ?? ""} ${c?.message ?? ""}`.toLowerCase();
    if (pedeTitulo(texto) || recusaFamily(texto)) return true;
  }
  const msg = String(message ?? "").toLowerCase();
  return pedeTitulo(msg) || recusaFamily(msg);
}
