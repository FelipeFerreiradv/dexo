/**
 * Imagens do Mercado Livre no CDN `http2.mlstatic.com` seguem o padrão
 * `D_<id>-MLB<pic>_<data>-<variante>.<ext>`, onde a letra final define o TAMANHO:
 *   -I = miniatura (~100px, ~3 KB)   -O = original (~40 KB)
 *
 * O campo `item.thumbnail` da API devolve a variante `-I`; já as
 * `item.pictures[].secure_url` vêm em `-O`. Gravar o `thumbnail` no produto
 * deixava a foto minúscula na Dexo.
 *
 * Este helper normaliza qualquer URL do mlstatic para a variante ORIGINAL e
 * para https. É idempotente (aplicar de novo em uma URL `-O` não muda nada) e
 * devolve URLs de outros domínios inalteradas.
 */

// Última letra de variante antes da extensão (ex.: "-I.jpg", "-V.webp").
const ML_VARIANT_RE = /-[A-Z](\.(?:jpg|jpeg|png|webp))$/i;

export function toFullSizeMLImage(
  url: string | null | undefined,
): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Não é CDN do Mercado Livre → devolve como está (nunca mexe em outra origem).
  if (!/mlstatic\.com/i.test(trimmed)) return trimmed;

  const secure = trimmed.replace(/^http:\/\//i, "https://");
  return secure.replace(ML_VARIANT_RE, "-O$1");
}

/** Aplica `toFullSizeMLImage` numa lista, descartando vazios. */
export function toFullSizeMLImages(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  return urls
    .map((u) => toFullSizeMLImage(typeof u === "string" ? u : null))
    .filter((u): u is string => Boolean(u));
}
