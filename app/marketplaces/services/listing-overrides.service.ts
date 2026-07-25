/**
 * Helpers para "valor efetivo" de um anúncio.
 *
 * Cada ProductListing pode ter campos override que sobrescrevem o valor do
 * Product compartilhado APENAS para aquele anúncio. Quando override for null,
 * o anúncio herda o valor do produto.
 *
 * Use estes helpers em todos os pontos onde o backend constrói payload para
 * o Mercado Livre / Shopee (criação inicial, atualização, re-sync, retry).
 *
 * Estoque (stock) NÃO tem override por design (evita oversell — unidade
 * física é única por produto).
 */

// Aceita qualquer shape compatível com Product do Prisma. Mantém os campos
// como `unknown` para tolerar diferenças entre o Product completo (com mais
// campos) e mocks/projeções menores.
type AnyProduct = {
  id: string;
  name: string;
  [key: string]: unknown;
};

type AnyListingOverrides = {
  titleOverride?: string | null;
  descriptionOverride?: string | null;
  priceOverride?: { toNumber(): number } | number | null;
  brandOverride?: string | null;
  modelOverride?: string | null;
  yearOverride?: string | null;
  versionOverride?: string | null;
  categoryOverride?: string | null;
  mlCategoryOverride?: string | null;
  shopeeCategoryOverride?: string | null;
  partNumberOverride?: string | null;
  qualityOverride?: string | null;
  heightCmOverride?: number | null;
  widthCmOverride?: number | null;
  lengthCmOverride?: number | null;
  weightKgOverride?: number | null;
  imageUrlsOverride?: unknown;
  attributesOverride?: unknown;
  compatibilitiesOverride?: unknown;
  sourceVehicleOverride?: string | null;
};

function toNumber(
  value: number | { toNumber(): number } | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return value.toNumber();
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((v): v is string => typeof v === "string")
  );
}

/**
 * Resolve os valores efetivos de um anúncio: usa override quando presente,
 * caso contrário herda do produto.
 *
 * @returns Objeto plano com valores prontos para enviar à API do marketplace
 *          (title, description, price, attributes, dimensions, etc.).
 */
export function effectiveListingValues(
  listing: AnyListingOverrides,
  product: AnyProduct,
) {
  const p = product as Record<string, unknown>;
  const asString = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const asNumber = (v: unknown): number | null =>
    typeof v === "number"
      ? v
      : v && typeof v === "object" && "toNumber" in (v as object)
        ? (v as { toNumber(): number }).toNumber()
        : null;

  const productPrice = asNumber(p.price);
  const overridePriceRaw = toNumber(listing.priceOverride ?? null);
  // Override de preço <= 0 = ausente = herda o produto. `??` sozinho não basta:
  // ele só cai no fallback para null/undefined, então um override 0 viraria
  // preço efetivo 0 — contradizendo o contrato acima e publicando por R$ 0.
  const overridePrice =
    overridePriceRaw !== null && overridePriceRaw > 0 ? overridePriceRaw : null;

  const effectiveImages = isStringArray(listing.imageUrlsOverride)
    ? listing.imageUrlsOverride
    : Array.isArray(p.imageUrls) && (p.imageUrls as unknown[]).length > 0
      ? (p.imageUrls as string[])
      : asString(p.imageUrl)
        ? [asString(p.imageUrl) as string]
        : [];

  const effectiveAttributes =
    listing.attributesOverride && typeof listing.attributesOverride === "object"
      ? (listing.attributesOverride as Record<string, unknown>)
      : (p.attributes as Record<string, unknown> | null) ?? null;

  const effectiveCompatibilities = Array.isArray(listing.compatibilitiesOverride)
    ? (listing.compatibilitiesOverride as unknown[])
    : null;

  return {
    title: listing.titleOverride ?? (asString(p.name) as string),
    description: listing.descriptionOverride ?? asString(p.description),
    price: overridePrice ?? productPrice,
    brand: listing.brandOverride ?? asString(p.brand),
    model: listing.modelOverride ?? asString(p.model),
    year: listing.yearOverride ?? asString(p.year),
    version: listing.versionOverride ?? asString(p.version),
    category: listing.categoryOverride ?? asString(p.category),
    mlCategory:
      listing.mlCategoryOverride ??
      asString(p.mlCategory) ??
      asString(p.mlCategoryId),
    shopeeCategory:
      listing.shopeeCategoryOverride ?? asString(p.shopeeCategoryId),
    partNumber: listing.partNumberOverride ?? asString(p.partNumber),
    quality: listing.qualityOverride ?? asString(p.quality),
    heightCm: listing.heightCmOverride ?? asNumber(p.heightCm),
    widthCm: listing.widthCmOverride ?? asNumber(p.widthCm),
    lengthCm: listing.lengthCmOverride ?? asNumber(p.lengthCm),
    weightKg: listing.weightKgOverride ?? asNumber(p.weightKg),
    images: effectiveImages,
    attributes: effectiveAttributes,
    /** Lista de compatibilidades override; null = usar tabela Compatibility do produto. */
    compatibilities: effectiveCompatibilities,
    sourceVehicle: listing.sourceVehicleOverride ?? asString(p.sourceVehicle),
  };
}

export type EffectiveListingValues = ReturnType<typeof effectiveListingValues>;

/**
 * Funde o mapa de ficha técnica do produto com o override do anúncio.
 *
 * O override vence chave a chave; chaves que ele não menciona permanecem com o
 * valor herdado do produto (é o ponto todo — um override parcial não pode
 * apagar o lado/posição que o operador informou no cadastro). Para apagar um
 * atributo de propósito, o override manda `null` explicitamente naquela chave.
 *
 * Array não é ficha técnica válida (o formato é `{ [id]: { value_id?,
 * value_name? } }`); nesse caso devolve o override cru, preservando o
 * comportamento anterior em vez de tentar adivinhar.
 */
export function mergeAttributeOverride(
  productAttributes: unknown,
  overrideAttributes: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (overrideAttributes === null || overrideAttributes === undefined) {
    return overrideAttributes ?? null;
  }
  if (Array.isArray(overrideAttributes)) return overrideAttributes;
  if (
    !productAttributes ||
    typeof productAttributes !== "object" ||
    Array.isArray(productAttributes)
  ) {
    return overrideAttributes;
  }

  const merged: Record<string, unknown> = {
    ...(productAttributes as Record<string, unknown>),
  };
  for (const [id, value] of Object.entries(overrideAttributes)) {
    if (value === null) {
      delete merged[id];
      continue;
    }
    merged[id] = value;
  }
  return merged;
}

/**
 * Retorna uma cópia do produto com os campos override do listing aplicados
 * in-memory. Usado em pontos do backend (sync, retry, dispatch) que constroem
 * payload para o ML/Shopee — substituindo `product` por `effectiveProduct`
 * sem precisar refatorar cada chamada interna.
 *
 * Importante: NÃO sobrescreve `stock` (estoque é compartilhado por design).
 */
export function applyOverridesToProduct<T extends AnyProduct>(
  product: T,
  listing: AnyListingOverrides | null | undefined,
): T {
  if (!listing) return product;

  const eff = effectiveListingValues(listing, product);

  // Constrói um shallow clone preservando a forma original (Prisma model).
  const result = { ...product } as T & {
    name?: string;
    description?: string | null;
    price?: number | { toNumber(): number } | null;
    brand?: string | null;
    model?: string | null;
    year?: string | null;
    version?: string | null;
    category?: string | null;
    mlCategory?: string | null;
    mlCategoryId?: string | null;
    shopeeCategoryId?: string | null;
    partNumber?: string | null;
    quality?: string | null;
    heightCm?: number | null;
    widthCm?: number | null;
    lengthCm?: number | null;
    weightKg?: number | null;
    imageUrl?: string | null;
    imageUrls?: string[] | null;
    attributes?: Record<string, unknown> | null;
    sourceVehicle?: string | null;
  };

  result.name = eff.title;
  result.description = eff.description;
  // Preço: mantém o tipo original quando não há override (preserva Decimal),
  // só sobrescreve com override explícito e válido (> 0). Um override <= 0
  // significa herdar — sem o guard, zerava o price do produto efetivo e fazia
  // os callers acharem que o produto não tem preço.
  const overridePrice = toNumber(listing.priceOverride ?? null);
  if (overridePrice !== null && overridePrice > 0) {
    result.price = overridePrice;
  }
  result.brand = eff.brand;
  result.model = eff.model;
  result.year = eff.year;
  result.version = eff.version;
  result.category = eff.category;
  if (listing.mlCategoryOverride !== null && listing.mlCategoryOverride !== undefined) {
    result.mlCategory = eff.mlCategory;
    result.mlCategoryId = eff.mlCategory;
  }
  if (
    listing.shopeeCategoryOverride !== null &&
    listing.shopeeCategoryOverride !== undefined
  ) {
    result.shopeeCategoryId = eff.shopeeCategory;
  }
  result.partNumber = eff.partNumber;
  result.quality = eff.quality;
  result.heightCm = eff.heightCm;
  result.widthCm = eff.widthCm;
  result.lengthCm = eff.lengthCm;
  result.weightKg = eff.weightKg;
  if (eff.images.length > 0) {
    result.imageUrl = eff.images[0];
    result.imageUrls = eff.images;
  }
  if (
    listing.attributesOverride !== null &&
    listing.attributesOverride !== undefined
  ) {
    // Por padrão o override SUBSTITUI o mapa inteiro. Isso é correto para a
    // edição unitária (o modal manda a ficha técnica completa), mas apaga
    // atributos herdados quando o override é parcial — que é o caso da Revisão
    // individual em massa, onde só os campos tocados viram override. Efeito
    // prático: o lado/posição do produto some do anúncio no re-sync seguinte.
    // O merge fica atrás de flag porque muda o payload de anúncios vivos.
    result.attributes =
      process.env.ML_ATTR_OVERRIDE_MERGE_ENABLED === "true"
        ? mergeAttributeOverride(product.attributes, eff.attributes)
        : eff.attributes;
  }
  result.sourceVehicle = eff.sourceVehicle;

  return result;
}

/**
 * Detecta se o listing tem QUALQUER override preenchido.
 * Útil para skipar re-sync de campos do produto quando o anúncio está
 * personalizado (em pontos onde queremos respeitar 100% o override).
 */
export function listingHasAnyOverride(listing: AnyListingOverrides): boolean {
  return (
    listing.titleOverride != null ||
    listing.descriptionOverride != null ||
    listing.priceOverride != null ||
    listing.brandOverride != null ||
    listing.modelOverride != null ||
    listing.yearOverride != null ||
    listing.versionOverride != null ||
    listing.categoryOverride != null ||
    listing.mlCategoryOverride != null ||
    listing.shopeeCategoryOverride != null ||
    listing.partNumberOverride != null ||
    listing.qualityOverride != null ||
    listing.heightCmOverride != null ||
    listing.widthCmOverride != null ||
    listing.lengthCmOverride != null ||
    listing.weightKgOverride != null ||
    listing.imageUrlsOverride != null ||
    listing.attributesOverride != null ||
    listing.compatibilitiesOverride != null ||
    listing.sourceVehicleOverride != null
  );
}
