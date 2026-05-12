/**
 * Helpers para gerar e interpretar payloads de QR Code do Dexo.
 *
 * Convenções:
 *  - QR de Produto: URL absoluta `${NEXT_PUBLIC_APP_URL}/produtos/{id}`
 *    (preservado do fluxo existente em app/produtos/lib/labels-pdf.ts).
 *  - QR de Localização: URL absoluta `${NEXT_PUBLIC_APP_URL}/scan/location/{id}`.
 *
 * O parser tolera variações comuns que aparecem em diferentes leitores:
 *  - URL absoluta (`https://app.dexo/scan/location/abc...`)
 *  - URL relativa (`/scan/location/abc...`)
 *  - ID puro (CUID), útil para leitores que removem prefixo
 *  - Whitespace e caracteres zero-width (alguns leitores adicionam)
 *  - Query string e fragments na URL (`?foo=bar`, `#section`)
 */

export type ScannedKind = "location" | "product" | "unknown";

export interface ScannedPayload {
  kind: ScannedKind;
  id?: string;
}

const CUID_REGEX = /^c[a-z0-9]{20,30}$/i;
// U+200B..U+200D (zero-width space/joiner/non-joiner) + U+FEFF (BOM)
const ZERO_WIDTH_REGEX = new RegExp("[\\u200B-\\u200D\\uFEFF]", "g");

function getAppBaseUrl(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL || "";
}

export function getProductScanUrl(productId: string): string {
  return `${getAppBaseUrl()}/produtos/${productId}`;
}

export function getLocationScanUrl(locationId: string): string {
  return `${getAppBaseUrl()}/scan/location/${locationId}`;
}

function sanitize(input: string): string {
  return input.replace(ZERO_WIDTH_REGEX, "").trim();
}

function matchPath(
  pathname: string,
  prefix: string,
): { id: string } | null {
  const lower = pathname.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  if (!lower.startsWith(prefixLower)) return null;

  const rest = pathname.slice(prefix.length);
  if (!rest) return null;
  const segment = rest.split("/")[0];
  if (!segment || !CUID_REGEX.test(segment)) return null;
  return { id: segment };
}

export function parseScannedPayload(
  raw: string | null | undefined,
): ScannedPayload {
  if (!raw) return { kind: "unknown" };
  const text = sanitize(raw);
  if (!text) return { kind: "unknown" };

  // Caso 1: URL absoluta
  try {
    const url = new URL(text);
    const pathname = url.pathname.replace(/\/+$/g, "");
    const locMatch = matchPath(pathname, "/scan/location/");
    if (locMatch) return { kind: "location", id: locMatch.id };
    const prodMatch = matchPath(pathname, "/produtos/");
    if (prodMatch) return { kind: "product", id: prodMatch.id };
    return { kind: "unknown" };
  } catch {
    // não é URL absoluta — segue
  }

  // Caso 2: URL relativa (começa com /)
  if (text.startsWith("/")) {
    const pathname = text.split("?")[0].split("#")[0].replace(/\/+$/g, "");
    const locMatch = matchPath(pathname, "/scan/location/");
    if (locMatch) return { kind: "location", id: locMatch.id };
    const prodMatch = matchPath(pathname, "/produtos/");
    if (prodMatch) return { kind: "product", id: prodMatch.id };
    return { kind: "unknown" };
  }

  // Caso 3: ID puro (CUID) — sem contexto não dá pra classificar como
  // product/location, o caller (ex: endpoint /scan/resolve) decide
  // consultando o banco. Devolve `unknown` com o id preservado.
  if (CUID_REGEX.test(text)) {
    return { kind: "unknown", id: text };
  }

  return { kind: "unknown" };
}
