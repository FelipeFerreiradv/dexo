export type MarketplaceListingPlatform =
  "MERCADO_LIVRE" | "SHOPEE" | "MAGALU" | "OLX" | "FACEBOOK";

export interface MarketplaceListingLinkInput {
  platform: MarketplaceListingPlatform;
  marketplaceAccountId?: string | null;
  externalListingId?: string | null;
  permalink?: string | null;
  shopId?: number | null;
  status?: string | null;
  updatedAt?: Date | string | null;
  /**
   * FACEBOOK: id do Catálogo da CONTA (`MarketplaceAccount.fbCatalogId`). É o
   * único dado que permite montar um destino real para o item — ver o bloco
   * FACEBOOK em `resolveMarketplaceListingLinkState`. Opcional: sem ele o
   * comportamento é exatamente o de antes (botão desabilitado).
   */
  fbCatalogId?: string | null;
}

export interface MarketplaceListingLinkState {
  href: string | null;
  isOpenable: boolean;
  disabledReason: string | null;
}

const ACTIVE_LISTING_STATUSES = new Set(["active", "normal"]);
export const MARKETPLACE_LISTING_PLATFORMS = [
  "MERCADO_LIVRE",
  "SHOPEE",
  "MAGALU",
  "OLX",
  "FACEBOOK",
] as const;

const PLATFORM_LABELS: Record<MarketplaceListingPlatform, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
  OLX: "OLX",
  FACEBOOK: "Facebook",
};

function normalizeText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isPlaceholderExternalListingId(externalListingId?: string | null) {
  return normalizeText(externalListingId)?.startsWith("PENDING_") ?? false;
}

/**
 * Monta a URL curta canônica do Mercado Livre a partir do externalListingId.
 * O ML exige o hífen entre o prefixo de site e os dígitos (`MLB-1234567890`);
 * o id é armazenado sem hífen (`MLB1234567890`). Aceita id já com hífen
 * (idempotente). Retorna null se o formato não casar (ex.: placeholder).
 */
export function buildMercadoLivreShortUrl(
  externalListingId?: string | null,
): string | null {
  const id = normalizeText(externalListingId);
  if (!id) return null;
  const match = id.match(/^([A-Za-z]{2,4})-?(\d+)$/);
  if (!match) return null;
  const site = match[1].toUpperCase();
  const num = match[2];
  return `https://produto.mercadolivre.com.br/${site}-${num}`;
}

/**
 * Texto único para o destino do Facebook. Fica aqui (e não repetido nas telas)
 * porque quem sabe PARA ONDE o link vai é este módulo.
 */
export const FACEBOOK_COMMERCE_MANAGER_HINT =
  "Abre os itens do catálogo no Commerce Manager — a peça aparece pelo SKU.";

/**
 * Monta a URL do Commerce Manager para o catálogo da conta.
 *
 * NÃO EXISTE URL POR ITEM. Isso foi medido, não suposto: o roteador da Meta
 * responde `permissions_needed?...&target_tab=products` para
 * `/commerce/catalogs/{id}/products/` (rota reconhecida) e cai no login
 * genérico para `/products/{itemId}/` — exatamente como responde para um
 * caminho inventado usado como controle negativo. Idem `/product/{id}/`,
 * `/items/`, `/products/edit/{id}/`. O que existe é a lista de itens DO
 * CATÁLOGO CERTO, onde o operador acha a peça pelo SKU que a própria tela
 * mostra ao lado do botão.
 *
 * O id é digitado pelo operador na aba de conexão, então só aceita dígitos:
 * qualquer outra coisa (texto colado, caminho com `../`, URL inteira) devolve
 * null e o botão volta ao estado desabilitado, em vez de virar link torto.
 */
export function buildFacebookCommerceManagerUrl(
  catalogId?: string | null,
): string | null {
  const id = normalizeText(catalogId);
  if (!id || !/^\d+$/.test(id)) return null;
  return `https://business.facebook.com/commerce/catalogs/${id}/products/`;
}

function getShopeeItemId(listing: MarketplaceListingLinkInput) {
  const externalListingId = normalizeText(listing.externalListingId);

  if (!externalListingId || isPlaceholderExternalListingId(externalListingId)) {
    return null;
  }

  const itemId = externalListingId.split(":")[0]?.trim();
  return itemId || null;
}

function getStatusPriority(status?: string | null) {
  return ACTIVE_LISTING_STATUSES.has(normalizeText(status)?.toLowerCase() ?? "")
    ? 1
    : 0;
}

function getUpdatedAtPriority(updatedAt?: Date | string | null) {
  if (!updatedAt) return -1;

  const timestamp =
    updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);

  return Number.isNaN(timestamp) ? -1 : timestamp;
}

export function resolveMarketplaceListingLinkState(
  listing?: MarketplaceListingLinkInput | null,
): MarketplaceListingLinkState {
  if (!listing) {
    return {
      href: null,
      isOpenable: false,
      disabledReason: "Anuncio indisponivel.",
    };
  }

  const label = PLATFORM_LABELS[listing.platform];
  const permalink = normalizeText(listing.permalink);
  const externalListingId = normalizeText(listing.externalListingId);
  const isPlaceholder = isPlaceholderExternalListingId(externalListingId);

  if (isPlaceholder) {
    return {
      href: null,
      isOpenable: false,
      disabledReason: `Anuncio do ${label} ainda esta pendente de publicacao.`,
    };
  }

  // FACEBOOK: o `permalink` gravado é a página fixa do vendedor
  // (FB_PRODUCT_URL_BASE), que a Meta exige em todo item do catálogo — não a
  // peça. Por isso o Facebook é resolvido ANTES do bloco de permalink: deixá-lo
  // cair lá é o que fazia "Ver anúncio" abrir a loja em vez do anúncio.
  //
  // O destino real é a lista de itens DO CATÁLOGO DA CONTA no Commerce Manager
  // (ver `buildFacebookCommerceManagerUrl` para por que não há URL por item).
  // Sem catálogo configurado na conta, permanece o estado desabilitado — o
  // mesmo de antes, agora dizendo o que fazer para destravá-lo.
  if (listing.platform === "FACEBOOK") {
    const href = buildFacebookCommerceManagerUrl(listing.fbCatalogId);
    if (href) {
      return { href, isOpenable: true, disabledReason: null };
    }
    return {
      href: null,
      isOpenable: false,
      disabledReason:
        "Informe o ID do Catálogo na conta do Facebook para abrir a peça no Commerce Manager.",
    };
  }

  if (permalink) {
    return {
      href: permalink,
      isOpenable: true,
      disabledReason: null,
    };
  }

  if (!externalListingId) {
    return {
      href: null,
      isOpenable: false,
      disabledReason: `Anuncio do ${label} ainda nao tem link disponivel.`,
    };
  }

  if (listing.platform === "MERCADO_LIVRE") {
    // A URL curta pública do ML exige o hífen entre o site e os dígitos
    // (`MLB-1234567890`). O externalListingId é gravado sem hífen
    // (`MLB1234567890`), e sem ele o ML não resolve o item e cai na
    // busca/categoria. Insere o hífen (idempotente se já vier com ele).
    const href = buildMercadoLivreShortUrl(externalListingId);
    if (href) {
      return { href, isOpenable: true, disabledReason: null };
    }
    // Formato inesperado do id → degrada como o Magalu (não abre link torto).
    return {
      href: null,
      isOpenable: false,
      disabledReason: `Anuncio do ${label} ainda nao tem link disponivel.`,
    };
  }

  // Magalu: a URL pública usa slug do produto, que não é derivável só do
  // externalListingId. Quando há link, ele vem em `permalink` (tratado acima).
  // Sem permalink, degrada graciosamente — nunca cai na lógica da Shopee.
  if (listing.platform === "MAGALU") {
    return {
      href: null,
      isOpenable: false,
      disabledReason: `Anuncio do ${label} ainda nao tem link disponivel.`,
    };
  }

  // OLX: a URL pública (permalink) vem na consulta de status (tratada acima
  // quando presente). Sem permalink não é derivável do externalListingId (SKU),
  // então degrada como o Magalu — nunca cai na lógica da Shopee.
  if (listing.platform === "OLX") {
    return {
      href: null,
      isOpenable: false,
      disabledReason: `Anuncio do ${label} ainda nao tem link disponivel.`,
    };
  }

  if (!listing.shopId) {
    return {
      href: null,
      isOpenable: false,
      disabledReason:
        "Anuncio da Shopee ainda nao tem shopId para abrir o link.",
    };
  }

  const itemId = getShopeeItemId({
    ...listing,
    externalListingId,
  });
  if (!itemId) {
    return {
      href: null,
      isOpenable: false,
      disabledReason:
        "Anuncio da Shopee ainda nao tem itemId valido para abrir o link.",
    };
  }

  return {
    href: `https://shopee.com.br/product/${listing.shopId}/${itemId}`,
    isOpenable: true,
    disabledReason: null,
  };
}

export function buildHref(listing?: MarketplaceListingLinkInput | null) {
  return resolveMarketplaceListingLinkState(listing).href;
}

export function isOpenable(listing?: MarketplaceListingLinkInput | null) {
  return resolveMarketplaceListingLinkState(listing).isOpenable;
}

export function disabledReason(listing?: MarketplaceListingLinkInput | null) {
  return resolveMarketplaceListingLinkState(listing).disabledReason;
}

type ListingPreference<T extends MarketplaceListingLinkInput> = {
  listing: T;
  linkState: MarketplaceListingLinkState;
  statusPriority: number;
  updatedAtPriority: number;
  marketplaceAccountKey: string;
  externalListingKey: string;
  permalinkKey: string;
};

function buildListingPreference<T extends MarketplaceListingLinkInput>(
  listing: T,
): ListingPreference<T> {
  return {
    listing,
    linkState: resolveMarketplaceListingLinkState(listing),
    statusPriority: getStatusPriority(listing.status),
    updatedAtPriority: getUpdatedAtPriority(listing.updatedAt),
    marketplaceAccountKey: normalizeText(listing.marketplaceAccountId) ?? "",
    externalListingKey: normalizeText(listing.externalListingId) ?? "",
    permalinkKey: normalizeText(listing.permalink) ?? "",
  };
}

function compareListingPreferences<T extends MarketplaceListingLinkInput>(
  left: ListingPreference<T>,
  right: ListingPreference<T>,
) {
  const openableDiff =
    Number(right.linkState.isOpenable) - Number(left.linkState.isOpenable);
  if (openableDiff !== 0) return openableDiff;

  const statusDiff = right.statusPriority - left.statusPriority;
  if (statusDiff !== 0) return statusDiff;

  const updatedAtDiff = right.updatedAtPriority - left.updatedAtPriority;
  if (updatedAtDiff !== 0) return updatedAtDiff;

  const accountDiff = left.marketplaceAccountKey.localeCompare(
    right.marketplaceAccountKey,
    "pt-BR",
  );
  if (accountDiff !== 0) return accountDiff;

  const listingIdDiff = left.externalListingKey.localeCompare(
    right.externalListingKey,
    "pt-BR",
  );
  if (listingIdDiff !== 0) return listingIdDiff;

  return left.permalinkKey.localeCompare(right.permalinkKey, "pt-BR");
}

export function pickPreferredListingsByPlatform<
  T extends MarketplaceListingLinkInput,
>(
  listings: T[] | null | undefined,
  platforms: readonly MarketplaceListingPlatform[] = MARKETPLACE_LISTING_PLATFORMS,
) {
  const preferredByPlatform = new Map<
    MarketplaceListingPlatform,
    ListingPreference<T>
  >();

  for (const listing of listings ?? []) {
    if (!listing || !platforms.includes(listing.platform)) {
      continue;
    }

    const candidate = buildListingPreference(listing);
    const current = preferredByPlatform.get(listing.platform);

    if (!current || compareListingPreferences(candidate, current) < 0) {
      preferredByPlatform.set(listing.platform, candidate);
    }
  }

  return platforms.flatMap((platform) => {
    const preferred = preferredByPlatform.get(platform);

    return preferred
      ? [
          {
            platform,
            listing: preferred.listing,
            linkState: preferred.linkState,
          },
        ]
      : [];
  });
}

export function pickPreferredListingForPlatform<
  T extends MarketplaceListingLinkInput,
>(listings: T[] | null | undefined, platform: MarketplaceListingPlatform) {
  return (
    pickPreferredListingsByPlatform(listings, [platform])[0]?.listing ?? null
  );
}
