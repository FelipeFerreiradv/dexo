/**
 * Normalização de plataforma de marketplace para LEITURA/agregação dos logs de
 * criação de anúncio (`CREATE_LISTING`).
 *
 * Os logs gravam `details.marketplace` em formatos históricos diferentes:
 * `"MercadoLivre"` (rotas ML), `"SHOPEE"` (via enum `Platform` nas rotas Shopee),
 * `"Shopee"` (dispatcher) e possíveis variações antigas. Para CONTAR/agrupar por
 * plataforma de forma confiável — sem reprocessar o histórico — normalizamos na
 * leitura para um valor canônico. Nunca lança; entradas desconhecidas ou vazias
 * caem em `"OUTRO"` (entram no total, num bucket "Outro/Não identificado").
 */
export type CanonPlatform = "ML" | "SHOPEE" | "OUTRO";

export function canonPlatform(raw?: string | null): CanonPlatform {
  if (!raw) return "OUTRO";
  // Mantém só letras (remove espaços, hífens, underscores, dígitos e acentos),
  // em minúsculas. Ex.: "MERCADO_LIVRE" → "mercadolivre"; "Mercado Livre" →
  // "mercadolivre"; "SHOPEE" → "shopee".
  const s = String(raw)
    .normalize("NFKD")
    .replace(/[^A-Za-z]/g, "")
    .toLowerCase();

  if (!s) return "OUTRO";
  if (
    s.includes("mercadolivre") ||
    s.includes("mercadolibre") ||
    s === "ml" ||
    s === "meli"
  ) {
    return "ML";
  }
  if (s.includes("shopee")) return "SHOPEE";
  return "OUTRO";
}
