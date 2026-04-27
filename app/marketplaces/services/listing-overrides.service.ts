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
  const overridePrice = toNumber(listing.priceOverride ?? null);

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
  // Preço: mantém o tipo original quando override é null (preserva Decimal),
  // só sobrescreve se houver override explícito.
  if (listing.priceOverride !== null && listing.priceOverride !== undefined) {
    result.price = eff.price ?? result.price;
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
    result.attributes = eff.attributes;
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
