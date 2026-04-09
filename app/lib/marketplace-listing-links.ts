export type MarketplaceListingPlatform = "MERCADO_LIVRE" | "SHOPEE";

export interface MarketplaceListingLinkInput {
  platform: MarketplaceListingPlatform;
  marketplaceAccountId?: string | null;
  externalListingId?: string | null;
  permalink?: string | null;
  shopId?: number | null;
  status?: string | null;
  updatedAt?: Date | string | null;
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
] as const;

const PLATFORM_LABELS: Record<MarketplaceListingPlatform, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
};

function normalizeText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isPlaceholderExternalListingId(externalListingId?: string | null) {
  return normalizeText(externalListingId)?.startsWith("PENDING_") ?? false;
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
    return {
      href: `https://produto.mercadolivre.com.br/${externalListingId}`,
      isOpenable: true,
      disabledReason: null,
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
