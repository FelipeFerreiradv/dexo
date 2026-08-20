export type MLCatOption = { id: string; value: string };

export interface VehicularProductLike {
  brand?: string | null;
  model?: string | null;
  year?: string | null;
}

const VEHICLE_ROOT_KEYWORDS = [
  "acessórios para veículos",
  "acessorios para veiculos",
  "peças de carros",
  "pecas de carros",
  "motos",
  "caminhões",
  "caminhoes",
];

export function isProductVehicular(p: VehicularProductLike): boolean {
  return !!(p.brand && p.model && p.year);
}

/**
 * Decide se uma categoria ML (por id ou por fullPath) está sob o nicho
 * veicular usando a lista de categorias disponível no frontend (mlOptions).
 *
 * Retorna:
 *  - `true`  → categoria cai sob o nicho de veículos.
 *  - `false` → categoria encontrada e claramente FORA do nicho (ex: Gin).
 *  - `"unknown"` → não foi possível decidir (lista ainda não carregou ou
 *                  categoria não está na lista). Nesse caso, o caller deve
 *                  fail-open para não bloquear o usuário por falta de dados.
 */
export function isCategoryUnderVehicleRoot(
  categoryIdOrValue: string | null | undefined,
  mlOptions: MLCatOption[],
): boolean | "unknown" {
  if (!categoryIdOrValue) return "unknown";
  if (!mlOptions || mlOptions.length === 0) return "unknown";

  const target = mlOptions.find(
    (o) => o.id === categoryIdOrValue || o.value === categoryIdOrValue,
  );
  if (!target) return "unknown";

  const firstSegment = (target.value || "")
    .split(">")[0]
    .trim()
    .toLowerCase();
  if (!firstSegment) return "unknown";

  return VEHICLE_ROOT_KEYWORDS.some((k) => firstSegment.includes(k));
}

/**
 * Sanity-check para o estado inicial do modal ao abrir um produto.
 * Se o produto é veicular e a categoria persistida cai visivelmente fora
 * do nicho, retorna `{ clear: true, warning }` para o caller limpar o
 * campo e exibir aviso.
 */
export function sanityCheckInitialMlCategory(
  product: VehicularProductLike,
  persistedMlCategory: string | null | undefined,
  mlOptions: MLCatOption[],
): { clear: boolean; warning?: string } {
  if (!isProductVehicular(product)) return { clear: false };
  if (!persistedMlCategory) return { clear: false };
  const verdict = isCategoryUnderVehicleRoot(persistedMlCategory, mlOptions);
  if (verdict === false) {
    return {
      clear: true,
      warning:
        "Categoria ML persistida não pertence ao nicho de autopeças. Selecione uma categoria válida antes de publicar.",
    };
  }
  return { clear: false };
}

/** Os 9 settings ML que viajam no mesmo PUT dos overrides. */
export interface MLListingSettingsValues {
  listingType: string | null;
  itemCondition: string | null;
  hasWarranty: boolean | null;
  warrantyUnit: string | null;
  warrantyDuration: number | null;
  shippingMode: string | null;
  freeShipping: boolean | null;
  localPickup: boolean | null;
  manufacturingTime: number | null;
}

export interface ListingOverridesFormValues {
  name?: string | null;
  description?: string | null;
  price?: number | null;
  brand?: string | null;
  model?: string | null;
  year?: string | null;
  version?: string | null;
  category?: string | null;
  mlCategory?: string | null;
  shopeeCategory?: string | null;
  partNumber?: string | null;
  quality?: string | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
  weightKg?: number | null;
  imageUrls?: string[] | null;
  attributes?: unknown;
  sourceVehicle?: string | null;
}

export interface ListingOverridesProductSnapshot {
  name?: string | null;
  description?: string | null;
  price?: number | null;
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
  attributes?: unknown;
  sourceVehicle?: string | null;
}

export interface BuildListingOverridesInput {
  form: ListingOverridesFormValues;
  product: ListingOverridesProductSnapshot;
  compatibilities: Array<{
    brand: string;
    model: string;
    yearFrom?: number | null;
    yearTo?: number | null;
    version?: string | null;
  }>;
  mlSettings: MLListingSettingsValues;
  /**
   * Settings do listing no momento em que o modal abriu. `null` num campo =
   * não havia baseline confiável ⇒ o diff NÃO envia aquele setting. É a defesa
   * contra o ML rejeitar shipping/warranty/condition com `field_not_modifiable`
   * em anúncio com vendas. Snapshot inteiro `null` = não envia setting nenhum.
   */
  settingsSnapshot: MLListingSettingsValues | null;
  /**
   * Chaves que NÃO devem entrar no corpo. Chave ausente no `PUT /listings/:id`
   * significa "não mexer" — é assim que um campo exibido em modo leitura
   * (categoria do ML, por exemplo) deixa de virar override sem querer.
   */
  omitKeys?: readonly string[];
}

/**
 * Monta o corpo do `PUT /listings/:id` no modo "editar anúncio".
 *
 * Cada campo do produto só vira override quando DIFERE do produto; igual vira
 * `null`, que na convenção da rota significa "limpa o override e volta a
 * herdar". Isso é o que evita mandar `title`/`attributes` ao ML em anúncios que
 * não aceitam alterar esses campos (autopeças/catálogo) — o clássico
 * `BODY_INVALID_FIELDS`.
 *
 * Função pura de propósito: o comportamento do save precisa ser testável sem
 * renderizar um componente de 4.400 linhas.
 */
export function buildListingOverridesPayload(
  input: BuildListingOverridesInput,
): Record<string, unknown> {
  const { form, product, compatibilities, mlSettings, settingsSnapshot } = input;

  const diffStr = (
    newVal: string | null | undefined,
    productVal: string | null | undefined,
  ): string | null => {
    const a = newVal == null || newVal === "" ? null : String(newVal);
    const b =
      productVal == null || productVal === "" ? null : String(productVal);
    return a === b ? null : a;
  };
  const diffNum = (
    newVal: number | null | undefined,
    productVal: number | null | undefined,
  ): number | null => {
    const a = newVal == null ? null : Number(newVal);
    const b = productVal == null ? null : Number(productVal);
    return a === b ? null : a;
  };
  // Preço do anúncio zerado significa "herdar o preço do produto", nunca
  // "publicar por R$ 0" (o ML rejeita price=0). Um override <= 0 nunca é
  // persistido: vira null = herda.
  const diffPrice = (
    newVal: number | null | undefined,
    productVal: number | null | undefined,
  ): number | null => {
    const diff = diffNum(newVal, productVal);
    return diff !== null && diff > 0 ? diff : null;
  };
  const diffJson = (newVal: unknown, productVal: unknown): unknown => {
    try {
      return JSON.stringify(newVal ?? null) === JSON.stringify(productVal ?? null)
        ? null
        : (newVal ?? null);
    } catch {
      return newVal ?? null;
    }
  };

  const productImages: string[] = Array.isArray(product.imageUrls)
    ? product.imageUrls
    : product.imageUrl
      ? [product.imageUrl]
      : [];
  const formImages: string[] = Array.isArray(form.imageUrls)
    ? form.imageUrls
    : [];

  // Settings ML: só vão no payload quando o usuário REALMENTE alterou.
  const mlSettingsDiff: Record<string, unknown> = {};
  if (settingsSnapshot) {
    const keys = Object.keys(settingsSnapshot) as Array<
      keyof MLListingSettingsValues
    >;
    for (const key of keys) {
      if (settingsSnapshot[key] === null) continue;
      if (mlSettings[key] !== settingsSnapshot[key]) {
        mlSettingsDiff[key] = mlSettings[key];
      }
    }
  }

  const payload: Record<string, unknown> = {
    titleOverride: diffStr(form.name, product.name),
    descriptionOverride: diffStr(form.description, product.description),
    priceOverride: diffPrice(form.price, product.price),
    brandOverride: diffStr(form.brand, product.brand),
    modelOverride: diffStr(form.model, product.model),
    yearOverride: diffStr(form.year, product.year),
    versionOverride: diffStr(form.version, product.version),
    categoryOverride: diffStr(form.category, product.category),
    mlCategoryOverride: diffStr(
      form.mlCategory,
      product.mlCategory ?? product.mlCategoryId,
    ),
    shopeeCategoryOverride: diffStr(
      form.shopeeCategory,
      product.shopeeCategoryId,
    ),
    partNumberOverride: diffStr(form.partNumber, product.partNumber),
    qualityOverride: diffStr(form.quality, product.quality),
    heightCmOverride: diffNum(form.heightCm, product.heightCm),
    widthCmOverride: diffNum(form.widthCm, product.widthCm),
    lengthCmOverride: diffNum(form.lengthCm, product.lengthCm),
    weightKgOverride: diffNum(form.weightKg, product.weightKg),
    imageUrlsOverride: diffJson(formImages, productImages),
    attributesOverride: diffJson(form.attributes, product.attributes),
    compatibilitiesOverride: compatibilities,
    sourceVehicleOverride: diffStr(form.sourceVehicle, product.sourceVehicle),
    ...mlSettingsDiff,
  };

  for (const key of input.omitKeys ?? []) {
    delete payload[key];
  }

  return payload;
}
