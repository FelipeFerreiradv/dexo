import XLSX from "xlsx";

export type ParsedRow = {
  sku: string;
  rawPath?: string;
  segments: string[];
};

export const DEFAULT_SHEET_NAME = "Result 1";

export function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
}

export function normalizeCode(code: string): string {
  return code
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function parseLocationPath(raw: unknown): string[] {
  const text = asString(raw);
  if (!text) return [];

  return text
    .split(">")
    .map((part) => normalizeCode(part))
    .filter(Boolean);
}

export function buildPath(segments: string[]): string {
  return segments.join(" > ");
}

export function readSheetRows(
  workbook: XLSX.WorkBook,
  sheetName: string,
): Record<string, unknown>[] {
  const sheet = workbook.Sheets[sheetName] ?? workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error(`Sheet '${sheetName}' not found in workbook`);
  }
  return XLSX.utils.sheet_to_json(sheet, { defval: null }) as Record<string, unknown>[];
}

export function extractProductsFromRows(rows: Record<string, unknown>[]): {
  products: ParsedRow[];
  duplicatePathConflicts: Array<{ sku: string; first: string[]; second: string[] }>;
} {
  const products = new Map<string, ParsedRow>();
  const conflicts: Array<{ sku: string; first: string[]; second: string[] }> = [];

  for (const row of rows) {
    const sku =
      asString(row["Código"]) ||
      asString(row["Codigo"]) ||
      asString(row["SKU"]) ||
      asString(row["sku"]);

    if (!sku) continue;

    const segments = parseLocationPath(row["Hierarquia Localização"] ?? row["Hierarquia Localizaçao"]);

    if (products.has(sku)) {
      const existing = products.get(sku)!;
      if (
        segments.length > 0 &&
        existing.segments.length > 0 &&
        buildPath(existing.segments) !== buildPath(segments)
      ) {
        conflicts.push({ sku, first: existing.segments, second: segments });
      }
      continue; // keep first occurrence to stay deterministic
    }

    products.set(sku, {
      sku,
      rawPath: asString(row["Hierarquia Localização"] ?? row["Hierarquia Localizaçao"]),
      segments,
    });
  }

  return { products: Array.from(products.values()), duplicatePathConflicts: conflicts };
}
