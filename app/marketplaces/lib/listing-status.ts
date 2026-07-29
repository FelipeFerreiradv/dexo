export type MirrorPlatform =
  | "MERCADO_LIVRE"
  | "SHOPEE"
  | "MAGALU"
  | "OLX"
  | "FACEBOOK";

// Vocabulário FECHADO do espelhamento: apenas valores que os read-sites já
// entendem (PUBLICATION_STATUS_VALUES em app/repositories/product.repository.ts,
// LISTING_STATUS_LABELS no front e o guard anti-duplicata do
// listing.repository). Status remoto fora da tabela ⇒ null (não escrever) —
// nunca gravar um valor que faria o produto sumir dos filtros ou furar o guard.
const ML_STATUS_MAP: Record<string, string> = {
  active: "active",
  paused: "paused",
  closed: "closed",
  inactive: "inactive",
  // ML "under_review" vira o canônico "reviewing" (bucket PENDING, label
  // "Em revisão") — "under_review" cru não existe em nenhum read-site.
  under_review: "reviewing",
};

const SHOPEE_STATUS_MAP: Record<string, string> = {
  NORMAL: "active",
  UNLINKED: "pending",
  UNLIST: "unlist",
  BANNED: "banned",
  REVIEWING: "reviewing",
  DELETED: "deleted",
  SELLER_DELETED: "seller_deleted",
  // Grafias reais da API v2 (sem o D final) — mesmos destinos canônicos.
  SELLER_DELETE: "seller_deleted",
  SHOPEE_DELETE: "deleted",
};

// Facebook/Meta Commerce Catalog: o item expõe `availability` (in/out of stock,
// available for order, discontinued) e `review_status` (approved/rejected/
// pending). Mapeamos ambos para o vocabulário canônico fechado. "rejected" cai
// em "closed" (item barrado); "pending" em "reviewing"; disponibilidade → active
// vs. paused (a baixa de estoque grava "out of stock", que já vira paused).
const FACEBOOK_STATUS_MAP: Record<string, string> = {
  "in stock": "active",
  "available for order": "active",
  "out of stock": "paused",
  discontinued: "closed",
  approved: "active",
  active: "active",
  pending: "reviewing",
  rejected: "closed",
};

/**
 * Normaliza o status remoto de um anúncio para o vocabulário canônico da Dexo
 * (lowercase). USO EXCLUSIVO do espelhamento marketplace→Dexo (webhook, sync,
 * refresh, sweep). Os fluxos de IMPORT mantêm suas normalizações locais — lá,
 * vazio defaulta "active" porque a criação da row exige status NOT NULL.
 * Aqui, retorna `null` quando não há status confiável OU quando o valor está
 * fora do vocabulário fechado: o caller NÃO deve escrever.
 */
export function normalizeListingStatus(
  platform: MirrorPlatform | string,
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (platform === "SHOPEE") {
    return SHOPEE_STATUS_MAP[trimmed.toUpperCase()] ?? null;
  }

  if (platform === "FACEBOOK") {
    return FACEBOOK_STATUS_MAP[trimmed.toLowerCase()] ?? null;
  }

  // MERCADO_LIVRE, MAGALU e OLX falam o mesmo vocabulário base.
  return ML_STATUS_MAP[trimmed.toLowerCase()] ?? null;
}
