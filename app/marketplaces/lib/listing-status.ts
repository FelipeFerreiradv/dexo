export type MirrorPlatform = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

/**
 * Normaliza o status remoto de um anúncio para o vocabulário canônico da Dexo
 * (lowercase: active, paused, closed, under_review, inactive, pending, unlist,
 * banned, deleted, seller_deleted, reviewing...).
 *
 * USO EXCLUSIVO do espelhamento marketplace→Dexo (webhook, sync, refresh,
 * sweep). Os fluxos de IMPORT mantêm suas normalizações locais — lá, vazio
 * defaulta "active" porque a criação da row exige status NOT NULL. Aqui,
 * retorna `null` quando não há status confiável: o caller NÃO deve escrever
 * (nunca sobrescrever um status real com um default inventado).
 */
export function normalizeListingStatus(
  platform: MirrorPlatform | string,
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (platform === "SHOPEE") {
    const upper = trimmed.toUpperCase();
    if (upper === "NORMAL") return "active";
    if (upper === "UNLINKED") return "pending";
    return upper.toLowerCase();
  }

  // MERCADO_LIVRE e MAGALU: a API já fala o vocabulário canônico (active,
  // paused, closed, under_review, inactive) — passthrough lowercased.
  return trimmed.toLowerCase();
}
