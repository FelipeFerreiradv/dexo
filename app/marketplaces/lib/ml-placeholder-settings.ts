/**
 * Configurações de anúncio guardadas no PRÓPRIO placeholder, para o cron de
 * retentativa publicar com o que a pessoa escolheu na criação.
 *
 * Antes o cron chamava `createMLListing` sem configurações, que caía no padrão
 * ATUAL do usuário (e regravava a linha com ele): um lote publicado como
 * Premium numa conta cujo padrão é Clássico virava Clássico na retentativa,
 * em silêncio. Frete grátis e garantia idem.
 *
 * `itemCondition` fica DE FORA de propósito: `createMLListing` trata condição
 * vinda em `mlSettings` como "escolha explícita" e BLOQUEIA quando a categoria
 * não aceita — enquanto a condição derivada (padrão do usuário / qualidade)
 * é trocada sozinha pela única que a categoria aceita. O placeholder guarda a
 * condição mesmo quando ela veio do padrão, então repassá-la mudaria esse
 * comportamento.
 *
 * Sem nenhuma configuração gravada ⇒ `undefined` (a chamada segue igual à de
 * sempre).
 */
export interface PlaceholderSettingsRow {
  listingType?: string | null;
  hasWarranty?: boolean | null;
  warrantyUnit?: string | null;
  warrantyDuration?: number | null;
  shippingMode?: string | null;
  freeShipping?: boolean | null;
  localPickup?: boolean | null;
  manufacturingTime?: number | null;
}

export interface PlaceholderMlSettings {
  listingType?: string;
  hasWarranty?: boolean;
  warrantyUnit?: string;
  warrantyDuration?: number;
  shippingMode?: string;
  freeShipping?: boolean;
  localPickup?: boolean;
  manufacturingTime?: number;
}

export function placeholderMlSettings(
  row: PlaceholderSettingsRow | null | undefined,
): PlaceholderMlSettings | undefined {
  if (!row) return undefined;
  const out: PlaceholderMlSettings = {};
  if (typeof row.listingType === "string" && row.listingType.trim()) {
    out.listingType = row.listingType;
  }
  if (typeof row.hasWarranty === "boolean") out.hasWarranty = row.hasWarranty;
  if (typeof row.warrantyUnit === "string" && row.warrantyUnit.trim()) {
    out.warrantyUnit = row.warrantyUnit;
  }
  if (typeof row.warrantyDuration === "number") {
    out.warrantyDuration = row.warrantyDuration;
  }
  if (typeof row.shippingMode === "string" && row.shippingMode.trim()) {
    out.shippingMode = row.shippingMode;
  }
  if (typeof row.freeShipping === "boolean") out.freeShipping = row.freeShipping;
  if (typeof row.localPickup === "boolean") out.localPickup = row.localPickup;
  if (typeof row.manufacturingTime === "number") {
    out.manufacturingTime = row.manufacturingTime;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
