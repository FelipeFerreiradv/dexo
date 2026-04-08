import { Platform } from "@prisma/client";

const FILTER_PLATFORMS = new Set<Platform>(["MERCADO_LIVRE", "SHOPEE"]);

export interface ParsedProductListingCategoryValue {
  value: string;
  platform: Platform;
  categoryId: string;
  requestedCategoryIds: string[];
}

export function normalizeProductListingCategoryId(
  platform: Platform,
  categoryId: string,
) {
  const trimmed = categoryId.trim();
  if (!trimmed) return "";

  if (platform === "SHOPEE") {
    return trimmed.replace(/^SHP_/i, "").length > 0
      ? `SHP_${trimmed.replace(/^SHP_/i, "")}`
      : "";
  }

  return trimmed;
}

export function getRequestedCategoryIdsForPlatform(
  platform: Platform,
  categoryId: string,
) {
  const normalizedCategoryId = normalizeProductListingCategoryId(
    platform,
    categoryId,
  );

  if (!normalizedCategoryId) {
    return [];
  }

  if (platform === "SHOPEE") {
    return Array.from(
      new Set([
        normalizedCategoryId,
        normalizedCategoryId.replace(/^SHP_/i, ""),
      ]),
    );
  }

  return [normalizedCategoryId];
}

export function buildProductListingCategoryValue(
  platform: Platform,
  categoryId: string,
) {
  const normalizedCategoryId = normalizeProductListingCategoryId(
    platform,
    categoryId,
  );

  return normalizedCategoryId ? `${platform}:${normalizedCategoryId}` : "";
}

export function parseProductListingCategoryValue(
  value?: string | null,
): ParsedProductListingCategoryValue | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }

  const platform = trimmed.slice(0, separatorIndex) as Platform;
  if (!FILTER_PLATFORMS.has(platform)) {
    return null;
  }

  const categoryId = normalizeProductListingCategoryId(
    platform,
    trimmed.slice(separatorIndex + 1),
  );
  if (!categoryId) {
    return null;
  }

  return {
    value: buildProductListingCategoryValue(platform, categoryId),
    platform,
    categoryId,
    requestedCategoryIds: getRequestedCategoryIdsForPlatform(
      platform,
      categoryId,
    ),
  };
}
