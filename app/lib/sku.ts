export const normalizeSku = (sku?: string | null): string | null => {
  if (typeof sku !== "string") {
    return null;
  }

  const normalized = sku.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};
