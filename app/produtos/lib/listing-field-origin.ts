/**
 * Precedência de leitura de um campo no modo "editar anúncio".
 *
 * O modal mostra três fontes possíveis para o mesmo campo, e a ordem importa:
 *
 *   override do anúncio  ??  valor real do anúncio  ??  valor herdado do produto
 *
 * O motivo da fonte do meio existir: `ProductListing.requestedCategoryId` guarda
 * a categoria com que o anúncio foi publicado. Um anúncio pode ter sido criado
 * numa categoria diferente da do produto sem nunca ter recebido override — nesse
 * caso "override é null" NÃO significa "é igual ao produto".
 *
 * A `origin` não é enfeite: a convenção do `PUT /listings/:id` é `null = voltar a
 * herdar`, então o operador precisa ver se o que está na tela é personalização
 * dele ou herança, senão ele apaga uma sem querer.
 *
 * ⚠️ Isto é regra de LEITURA da UI. A regra de ESCRITA no marketplace continua
 * sendo `applyOverridesToProduct` (`app/marketplaces/services/listing-overrides.service.ts`),
 * que é consumida pelo sync, pelos cinco `update*ListingFields` e pelo republish
 * da OLX — não mexer lá.
 */

export type ListingFieldOrigin = "override" | "listing" | "product";

export interface ResolvedListingField<T> {
  value: T | null;
  origin: ListingFieldOrigin;
}

/**
 * Um valor "presente" é qualquer coisa que não seja `null`/`undefined`/`""`.
 * `0` e `false` SÃO presentes de propósito: `manufacturingTime: 0` e
 * `freeShipping: false` são configurações válidas, não ausência de valor.
 */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function resolveListingField<T>(input: {
  /** Override gravado neste anúncio. `null` = herda. */
  override?: T | null;
  /** Valor real do anúncio publicado (ex.: `requestedCategoryId`). */
  listingReal?: T | null;
  /** Valor do produto compartilhado. */
  product?: T | null;
}): ResolvedListingField<T> {
  if (isPresent(input.override)) {
    return { value: input.override as T, origin: "override" };
  }
  if (isPresent(input.listingReal)) {
    return { value: input.listingReal as T, origin: "listing" };
  }
  return {
    value: isPresent(input.product) ? (input.product as T) : null,
    origin: "product",
  };
}

export function listingFieldOriginLabel(origin: ListingFieldOrigin): string {
  switch (origin) {
    case "override":
      return "personalizado neste anúncio";
    case "listing":
      return "do anúncio publicado";
    default:
      return "herdado do produto";
  }
}

export interface ResolvedListingCategory {
  /** Id da categoria a exibir (nunca vazio quando `origin !== "product"`). */
  id: string | null;
  /** Rótulo legível. Cai no próprio id quando o catálogo local não conhece. */
  label: string | null;
  origin: ListingFieldOrigin;
}

/**
 * Categoria efetiva do anúncio, já com o rótulo pronto para a tela.
 *
 * `requestedCategoryPath` só existe para o Mercado Livre (a tabela
 * `MarketplaceCategory` é o catálogo do ML); nos outros canais o rótulo cai no
 * próprio id, que ainda é melhor do que mostrar a categoria errada.
 */
export function resolveListingCategory(input: {
  override?: string | null;
  requestedCategoryId?: string | null;
  requestedCategoryPath?: string | null;
  productCategoryId?: string | null;
  /** Rótulos conhecidos por id (a lista que o modal já carrega do ML). */
  labelById?: Map<string, string> | Record<string, string> | null;
}): ResolvedListingCategory {
  const { value, origin } = resolveListingField<string>({
    override: input.override,
    listingReal: input.requestedCategoryId,
    product: input.productCategoryId,
  });

  if (!value) return { id: null, label: null, origin };

  let label: string | null = null;

  // O path resolvido no backend só descreve `requestedCategoryId`. Usá-lo para
  // um override diferente rotularia a categoria errada com nome de gente.
  if (
    origin === "listing" &&
    input.requestedCategoryPath &&
    input.requestedCategoryPath.trim().length > 0
  ) {
    label = input.requestedCategoryPath;
  }

  if (!label && input.labelById) {
    label =
      input.labelById instanceof Map
        ? (input.labelById.get(value) ?? null)
        : (input.labelById[value] ?? null);
  }

  return { id: value, label: label || value, origin };
}
