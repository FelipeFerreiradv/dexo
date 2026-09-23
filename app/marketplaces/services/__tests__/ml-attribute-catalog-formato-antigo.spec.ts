import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Cache de atributos gravado ANTES dos metadados de valor (sem `readOnlyTag`
 * em nenhum atributo) é renovado UMA vez. Achado da revisão de 23/09/2026:
 * sem isso, por até 24-48 h depois do deploy, um GTIN read_only inválido era
 * BLOQUEADO (a regra não sabia que o atributo era read_only) em vez de sair
 * do payload.
 */

const { findUnique, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/prisma", () => ({
  default: { mLCategoryAttributeCache: { findUnique, upsert } },
}));

import { MLApiService } from "../ml-api.service";
import { MLAttributeCatalogService } from "../ml-attribute-catalog.service";

const futuro = () => new Date(Date.now() + 3600_000);
const ANTIGO = [
  { id: "GTIN", name: "GTIN", valueType: "string", required: false, variationRequired: false },
];
const RAW_NOVO = [
  { id: "GTIN", name: "GTIN", value_type: "string", tags: { read_only: true, hidden: true } },
];

beforeEach(() => {
  vi.restoreAllMocks();
  findUnique.mockReset();
  upsert.mockClear();
  MLAttributeCatalogService._clearMemory();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("MLAttributeCatalogService.getAll — cache de formato antigo", () => {
  it("linha válida SEM os campos novos ⇒ busca de novo no ML e grava o formato novo", async () => {
    findUnique.mockResolvedValue({ attributes: ANTIGO, ttlExpiresAt: futuro() });
    const api = vi
      .spyOn(MLApiService, "getCategoryAttributes")
      .mockResolvedValue(RAW_NOVO as any);
    const attrs = await MLAttributeCatalogService.getAll("MLB1");
    expect(api).toHaveBeenCalledTimes(1);
    expect(attrs[0].readOnlyTag).toBe(true);
    expect(upsert).toHaveBeenCalled();
  });

  it("linha no formato novo ⇒ não chama o ML (cache de sempre)", async () => {
    findUnique.mockResolvedValue({
      attributes: [{ ...ANTIGO[0], readOnlyTag: false }],
      ttlExpiresAt: futuro(),
    });
    const api = vi.spyOn(MLApiService, "getCategoryAttributes");
    await MLAttributeCatalogService.getAll("MLB2");
    expect(api).not.toHaveBeenCalled();
  });

  it("ML fora do ar ⇒ serve a linha antiga (nunca [] — isso desligaria o preflight)", async () => {
    findUnique.mockResolvedValue({ attributes: ANTIGO, ttlExpiresAt: futuro() });
    vi.spyOn(MLApiService, "getCategoryAttributes").mockRejectedValue(new Error("503"));
    const attrs = await MLAttributeCatalogService.getAll("MLB3");
    expect(attrs).toEqual(ANTIGO);
  });

  it("depois de falhar, não martela o ML a cada chamada (serve da memória por um tempo)", async () => {
    findUnique.mockResolvedValue({ attributes: ANTIGO, ttlExpiresAt: futuro() });
    const api = vi
      .spyOn(MLApiService, "getCategoryAttributes")
      .mockRejectedValue(new Error("503"));
    await MLAttributeCatalogService.getAll("MLB4");
    await MLAttributeCatalogService.getAll("MLB4");
    await MLAttributeCatalogService.getAll("MLB4");
    expect(api).toHaveBeenCalledTimes(1);
  });
});
