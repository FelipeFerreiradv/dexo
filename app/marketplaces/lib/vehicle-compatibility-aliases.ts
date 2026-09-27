/** Names stored in Dexo remain unchanged; only ML lookups use these aliases. */
export function marketplaceVehicleBrandName(brand: string): string {
  const key = brand
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  // The Brazilian joint venture is displayed as CAOA Chery locally, while the
  // MLB-CARS_AND_VANS brand is Chery (value_id 389168, checked 2026-09-27).
  return key === "caoa chery" ? "Chery" : brand;
}

/** A partial name is usable only when it identifies one marketplace value. */
export function findExactOrUniqueCompatName<T extends { name: string }>(
  values: T[],
  name: string,
): T | null {
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  const key = normalize(name);
  if (!key) return null;
  const exact = values.find((value) => normalize(value.name) === key);
  if (exact) return exact;
  const partial = values.filter((value) => normalize(value.name).includes(key));
  return partial.length === 1 ? partial[0] : null;
}

/** "Tiggo" is an older model, never an abbreviation for Tiggo 2/5X/7/8. */
export function findMarketplaceVehicleModel<T extends { name: string }>(
  values: T[],
  name: string,
): T | null {
  if (name.trim().toLowerCase() === "tiggo") {
    return values.find((value) => value.name.trim().toLowerCase() === "tiggo") ?? null;
  }
  return findExactOrUniqueCompatName(values, name);
}
