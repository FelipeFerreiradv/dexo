import { describe, expect, it, vi } from "vitest";
import {
  parseScannedPayload,
  getLocationScanUrl,
  getProductScanUrl,
} from "../app/lib/qr-payloads";

const CUID = "cln1a2b3c4d5e6f7g8h9i0j1k";
const OTHER_CUID = "clz9y8x7w6v5u4t3s2r1q0p1o";

describe("getLocationScanUrl / getProductScanUrl", () => {
  it("usa NEXT_PUBLIC_APP_URL quando definido", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dexo.example.com");
    expect(getLocationScanUrl(CUID)).toBe(
      `https://dexo.example.com/scan/location/${CUID}`,
    );
    expect(getProductScanUrl(CUID)).toBe(
      `https://dexo.example.com/produtos/${CUID}`,
    );
    vi.unstubAllEnvs();
  });

  it("usa string vazia como base quando env não está definido (SSR)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(getLocationScanUrl(CUID)).toBe(`/scan/location/${CUID}`);
    expect(getProductScanUrl(CUID)).toBe(`/produtos/${CUID}`);
    vi.unstubAllEnvs();
  });
});

describe("parseScannedPayload — URL absoluta", () => {
  it("identifica localização em URL absoluta padrão", () => {
    expect(
      parseScannedPayload(`https://app.dexo.com/scan/location/${CUID}`),
    ).toEqual({ kind: "location", id: CUID });
  });

  it("identifica produto em URL absoluta padrão", () => {
    expect(parseScannedPayload(`https://app.dexo.com/produtos/${CUID}`)).toEqual({
      kind: "product",
      id: CUID,
    });
  });

  it("ignora query string e fragment", () => {
    expect(
      parseScannedPayload(
        `https://app.dexo.com/scan/location/${CUID}?utm=qr#card`,
      ),
    ).toEqual({ kind: "location", id: CUID });
    expect(
      parseScannedPayload(`https://app.dexo.com/produtos/${CUID}?ref=2`),
    ).toEqual({ kind: "product", id: CUID });
  });

  it("tolera trailing slash", () => {
    expect(
      parseScannedPayload(`https://app.dexo.com/scan/location/${CUID}/`),
    ).toEqual({ kind: "location", id: CUID });
  });

  it("é case-insensitive nas paths", () => {
    expect(
      parseScannedPayload(`https://app.dexo.com/Scan/Location/${CUID}`),
    ).toEqual({ kind: "location", id: CUID });
    expect(
      parseScannedPayload(`https://app.dexo.com/Produtos/${CUID}`),
    ).toEqual({ kind: "product", id: CUID });
  });

  it("ignora segmentos extras após o id", () => {
    expect(
      parseScannedPayload(`https://app.dexo.com/produtos/${CUID}/editar`),
    ).toEqual({ kind: "product", id: CUID });
  });

  it("retorna unknown para path sem id após o prefixo", () => {
    expect(
      parseScannedPayload("https://app.dexo.com/produtos"),
    ).toEqual({ kind: "unknown" });
    expect(
      parseScannedPayload("https://app.dexo.com/scan/location"),
    ).toEqual({ kind: "unknown" });
  });

  it("retorna unknown para id que não parece CUID", () => {
    expect(
      parseScannedPayload("https://app.dexo.com/produtos/123-not-cuid"),
    ).toEqual({ kind: "unknown" });
  });

  it("retorna unknown para URL sem nenhum prefixo reconhecido", () => {
    expect(
      parseScannedPayload("https://app.dexo.com/qualquer/coisa"),
    ).toEqual({ kind: "unknown" });
  });
});

describe("parseScannedPayload — URL relativa", () => {
  it("identifica localização", () => {
    expect(parseScannedPayload(`/scan/location/${CUID}`)).toEqual({
      kind: "location",
      id: CUID,
    });
  });

  it("identifica produto", () => {
    expect(parseScannedPayload(`/produtos/${CUID}`)).toEqual({
      kind: "product",
      id: CUID,
    });
  });

  it("ignora query e fragment em URL relativa", () => {
    expect(parseScannedPayload(`/produtos/${CUID}?x=1#y`)).toEqual({
      kind: "product",
      id: CUID,
    });
  });
});

describe("parseScannedPayload — ID puro", () => {
  it("retorna unknown com id preservado para CUID puro", () => {
    expect(parseScannedPayload(CUID)).toEqual({ kind: "unknown", id: CUID });
  });

  it("retorna unknown sem id quando texto não parece CUID", () => {
    expect(parseScannedPayload("abc123")).toEqual({ kind: "unknown" });
    expect(parseScannedPayload("not-a-cuid-at-all")).toEqual({ kind: "unknown" });
  });
});

describe("parseScannedPayload — entrada inválida", () => {
  it("retorna unknown para null/undefined/string vazia", () => {
    expect(parseScannedPayload(null)).toEqual({ kind: "unknown" });
    expect(parseScannedPayload(undefined)).toEqual({ kind: "unknown" });
    expect(parseScannedPayload("")).toEqual({ kind: "unknown" });
    expect(parseScannedPayload("   ")).toEqual({ kind: "unknown" });
  });

  it("sanitiza whitespace e zero-width chars", () => {
    const zwsp = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
    const bom = String.fromCharCode(0xfeff); // BOM
    expect(
      parseScannedPayload(`  ${zwsp}/produtos/${CUID}${bom}  `),
    ).toEqual({ kind: "product", id: CUID });
    expect(
      parseScannedPayload(`https://x.test/scan/location/${CUID}${zwsp}`),
    ).toEqual({ kind: "location", id: CUID });
  });

  it("nunca confunde produto com localização", () => {
    const a = parseScannedPayload(`/produtos/${CUID}`);
    const b = parseScannedPayload(`/scan/location/${OTHER_CUID}`);
    expect(a.kind).toBe("product");
    expect(b.kind).toBe("location");
    expect(a.id).not.toBe(b.id);
  });
});
