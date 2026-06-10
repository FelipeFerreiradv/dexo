import type { ListingFullEditInput } from "../usecases/listing.usercase";
import type { BulkOverrideTemplate } from "../repositories/bulk-listing-job.repository";

/**
 * Subset de campos do Product que esta service consome. Mantemos a tipagem
 * frouxa (price aceita number | Decimal) para que a função possa rodar tanto
 * no front (preview client-side) quanto no backend (cálculo real).
 */
export interface BulkRulesProductInput {
  id: string;
  name: string;
  price: number | { toNumber(): number };
  costPrice?: number | { toNumber(): number } | null;
  markup?: number | { toNumber(): number } | null;
}

export function toNum(
  v: number | { toNumber(): number } | null | undefined,
): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "toNumber" in v) return v.toNumber();
  return 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcula o preço final que o anúncio deve ter, a partir das regras de bulk.
 * Retorna `null` quando a regra é "manter" (não aplicar override de preço).
 */
export function computeBulkPrice(
  product: BulkRulesProductInput,
  rule: BulkOverrideTemplate["priceRule"] | undefined,
): number | null {
  const base = toNum(product.price);
  if (!rule || rule.type === "keep") return null;

  if (rule.type === "fixed") {
    return rule.value > 0 ? round2(rule.value) : null;
  }

  if (rule.type === "markup_pct") {
    const cost = toNum(product.costPrice);
    if (cost <= 0) return null; // sem custo cadastrado, não aplica
    const factor = 1 + rule.value / 100;
    return round2(cost * factor);
  }

  if (rule.type === "delta_pct") {
    const factor = 1 + rule.value / 100;
    const next = base * factor;
    return next > 0 ? round2(next) : null;
  }

  return null;
}

/**
 * Calcula o título final aplicando o sufixo (se houver). Aceita o título
 * original do produto (string vazia ⇒ não retorna override).
 */
export function computeBulkTitle(
  product: BulkRulesProductInput,
  template: BulkOverrideTemplate | undefined | null,
): string | null {
  const suffix = template?.titleSuffix?.trim();
  if (!suffix) return null;

  const base = product.name?.trim() ?? "";
  if (!base) return null;

  // Anexa sufixo com espaço único; respeita limite ML de 60 caracteres.
  const merged = `${base} ${suffix}`.replace(/\s+/g, " ").trim();
  return merged.length > 60 ? merged.slice(0, 60) : merged;
}

/**
 * Combina as duas regras acima num `Partial<ListingFullEditInput>` pronto
 * para passar ao `ListingUseCase.updateListingFields()` após a criação.
 *
 * Retorna `null` quando o template não produz NENHUM override (otimização:
 * o caller pula a chamada de update neste caso).
 */
export function applyRules(
  product: BulkRulesProductInput,
  template: BulkOverrideTemplate | undefined | null,
): Partial<ListingFullEditInput> | null {
  if (!template) return null;

  const overrides: Partial<ListingFullEditInput> = {};

  const newPrice = computeBulkPrice(product, template.priceRule);
  if (newPrice !== null) overrides.priceOverride = newPrice;

  const newTitle = computeBulkTitle(product, template);
  if (newTitle !== null) overrides.titleOverride = newTitle;

  if (Object.keys(overrides).length === 0) return null;
  return overrides;
}

/**
 * Retorna avisos textuais sobre o produto vs template. Usado no passo de
 * revisão (passo 3 do wizard) para alertar o usuário antes de disparar o job.
 */
export function previewWarnings(
  product: BulkRulesProductInput & {
    imageUrl?: string | null;
    imageUrls?: string[] | null;
    mlCategoryId?: string | null;
    shopeeCategoryId?: string | null;
    compatibilitiesCount?: number | null;
  },
  template: BulkOverrideTemplate | undefined | null,
  options?: { hasMl?: boolean; hasShopee?: boolean },
): string[] {
  const out: string[] = [];

  const hasImage =
    !!product.imageUrl ||
    (Array.isArray(product.imageUrls) && product.imageUrls.length > 0);
  if (!hasImage) {
    out.push("Sem imagem cadastrada — anúncio pode falhar.");
  }

  if (options?.hasMl !== false && !product.mlCategoryId) {
    out.push("Sem categoria ML — será resolvida automaticamente no servidor.");
  }

  if (options?.hasShopee && !product.shopeeCategoryId) {
    out.push(
      "Sem categoria Shopee — Shopee exige subcategoria final no produto.",
    );
  }

  if (
    options?.hasShopee &&
    typeof product.compatibilitiesCount === "number" &&
    product.compatibilitiesCount > 80
  ) {
    out.push(
      `Produto com ${product.compatibilitiesCount} compatibilidades — Shopee limita descrição a 5000 chars; lista será truncada.`,
    );
  }

  if (
    template?.priceRule?.type === "markup_pct" &&
    toNum(product.costPrice) <= 0
  ) {
    out.push("Sem preço de custo — regra de markup será ignorada.");
  }

  return out;
}
