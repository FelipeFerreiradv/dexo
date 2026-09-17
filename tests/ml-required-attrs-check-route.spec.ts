import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// Stub do prisma client (importado por dependências transitivas).
vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));

// Auth permissivo que injeta o usuário (a rota lê dataOwnerId).
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "colab-1", dataOwnerId: "dono-1" };
  },
}));

import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { marketplaceRoutes } from "../app/routes/marketplace.routes";
import { determineActionType } from "../app/middlewares/logging.middleware";

/**
 * POST /marketplace/ml/required-attributes/check e GET .../status.
 *
 * O endpoint não tem lógica própria de avaliação: delega a
 * `ListingUseCase.evaluateMLRequiredAttributesForProduct` (mesmo motor do
 * create). Aqui se prova o contrato: flag desligada sem tocar em nada,
 * validação do corpo, dono, rascunho, falha isolada por item e cache de
 * categoria compartilhado.
 */

const M1 =
  "Esta categoria do Mercado Livre exige o preenchimento do Part Number. Preencha esse campo antes de continuar.";

const ok = (categoryId = "MLB46723") => ({
  status: "ok" as const,
  blocking: [],
  warnings: [],
  message: null,
  categoryId,
  legacyMissingRequired: ["X"],
});

describe("POST /marketplace/ml/required-attributes/check", () => {
  let app: ReturnType<typeof fastify>;
  let antes: Record<string, string | undefined>;
  // `any`: o MockInstance tipado da assinatura não é atribuível ao genérico.
  let avaliar: any;
  let buscar: any;

  beforeEach(async () => {
    antes = {
      ML_REQUIRED_ATTRS_BLOCK: process.env.ML_REQUIRED_ATTRS_BLOCK,
      ML_CATALOG_LISTING_ENABLED: process.env.ML_CATALOG_LISTING_ENABLED,
    };
    delete process.env.ML_REQUIRED_ATTRS_BLOCK;
    delete process.env.ML_CATALOG_LISTING_ENABLED;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    avaliar = vi
      .spyOn(ListingUseCase, "evaluateMLRequiredAttributesForProduct")
      .mockResolvedValue(ok() as any);
    buscar = vi
      .spyOn(ProductRepositoryPrisma.prototype, "findMlRequiredAttrsInput")
      .mockResolvedValue([]);
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/marketplace/ml/required-attributes/check",
      payload: payload as any,
    });

  it("E1: flag ausente → 200 {enabled:false, results:[]} sem banco nem avaliação (nem valida o corpo)", async () => {
    for (const corpo of [{ items: [{ key: "a", productId: "p1" }] }, {}]) {
      const res = await post(corpo);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ enabled: false, results: [] });
    }
    process.env.ML_REQUIRED_ATTRS_BLOCK = "true";
    const res = await post({ items: [{ key: "a", productId: "p1" }] });
    expect(JSON.parse(res.payload)).toEqual({ enabled: false, results: [] });
    expect(buscar).not.toHaveBeenCalled();
    expect(avaliar).not.toHaveBeenCalled();
  });

  it("E1b: a rota não é gravada no SystemLog, e as vizinhas continuam como antes", () => {
    expect(
      determineActionType("POST", "/marketplace/ml/required-attributes/check"),
    ).toBeNull();
    expect(
      determineActionType(
        "POST",
        "/marketplace/ml/required-attributes/check?x=1",
      ),
    ).toBeNull();
    expect(
      determineActionType("GET", "/marketplace/ml/required-attributes/status"),
    ).toBeNull();
    expect(determineActionType("POST", "/marketplace/ml/auth/callback")).toEqual({
      action: "CONNECT_MARKETPLACE",
      resource: "MarketplaceAccount",
    });
    expect(determineActionType("POST", "/marketplace/ml/sync")).toEqual({
      action: "SYNC_STOCK",
      resource: "Sync",
    });
    expect(determineActionType("POST", "/marketplace/ml/questions/1/answer")).toEqual({
      action: "USER_ACTIVITY",
      resource: "System",
    });
  });

  it("E2: flag 1 + corpo inválido → 400", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const invalidos = [
      {},
      { items: [] },
      { items: "x" },
      { items: Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, productId: "p" })) },
      { items: [{ key: "a" }] },
      { items: [{ key: "", productId: "p1" }] },
      { items: [{ key: "a", productId: "p1", categoryId: 123 }] },
      { items: [{ key: "a", productId: "p1", attributeOverrides: [] }] },
      { items: [{ key: "a", product: [] }] },
    ];
    for (const corpo of invalidos) {
      const res = await post(corpo);
      expect(res.statusCode, JSON.stringify(corpo).slice(0, 80)).toBe(400);
      expect(JSON.parse(res.payload).error).toBe("Dados inválidos");
    }
    expect(avaliar).not.toHaveBeenCalled();
  });

  it("E3: produto de outro dono (repositório não devolve) → unknown/product_not_found", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    const res = await post({ items: [{ key: "a", productId: "de-outro" }] });
    expect(res.statusCode).toBe(200);
    expect(buscar).toHaveBeenCalledWith(["de-outro"], "dono-1");
    expect(JSON.parse(res.payload)).toEqual({
      enabled: true,
      results: [
        {
          key: "a",
          status: "unknown",
          unknownReason: "product_not_found",
          categoryId: null,
          blocking: [],
          warnings: [],
          message: null,
        },
      ],
    });
    expect(avaliar).not.toHaveBeenCalled();
  });

  it("E4: avaliação bloqueada → status blocked com a mensagem (sem legacyMissingRequired)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    buscar.mockResolvedValue([{ id: "p1", name: "Sensor", sku: "1" }] as any);
    const issue = {
      attributeId: "PART_NUMBER",
      attributeName: "Número de peça",
      reason: "missing",
      message: M1,
    };
    avaliar.mockResolvedValue({
      status: "blocked",
      blocking: [issue],
      warnings: [],
      message: M1,
      categoryId: "MLB46723",
      legacyMissingRequired: ["PART_NUMBER"],
    } as any);
    const res = await post({
      items: [{ key: "p1", productId: "p1", categoryId: " MLB46723 " }],
    });
    const body = JSON.parse(res.payload);
    expect(body.results[0]).toEqual({
      key: "p1",
      status: "blocked",
      categoryId: "MLB46723",
      blocking: [issue],
      warnings: [],
      message: M1,
    });
    const arg = avaliar.mock.calls[0][0] as any;
    expect(arg.product).toMatchObject({ id: "p1" });
    expect(arg.categoryId).toBe("MLB46723");
    expect(arg.attributeOverrides).toBeNull();
  });

  it("E5: rascunho só com nome → marca/modelo/ano do título aplicados como no POST /products", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    await post({ items: [{ key: "draft", product: { name: "Parachoque Gol 2015" } }] });
    const arg = avaliar.mock.calls[0][0] as any;
    expect(arg.product.year).toBe("2015");
    expect(arg.product.mlCategoryId).toBeUndefined();
    expect(buscar).not.toHaveBeenCalled();
  });

  it("E5b: campo preenchido no rascunho não é sobrescrito pelo título", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    await post({
      items: [
        {
          key: "draft",
          product: { name: "Parachoque Gol 2015", year: "2010", partNumber: "PN" },
          attributeOverrides: { SIDE: { value_id: "1" } },
        },
      ],
    });
    const arg = avaliar.mock.calls[0][0] as any;
    expect(arg.product.year).toBe("2010");
    expect(arg.product.partNumber).toBe("PN");
    expect(arg.attributeOverrides).toEqual({ SIDE: { value_id: "1" } });
  });

  it("E6: exceção num item → unknown/evaluation_failed, e os demais seguem", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    buscar.mockResolvedValue([
      { id: "p1", name: "A", sku: "1" },
      { id: "p2", name: "B", sku: "2" },
    ] as any);
    avaliar.mockImplementation(async (i: any) => {
      if (i.product.id === "p1") throw new Error("catálogo explodiu");
      return ok() as any;
    });
    const res = await post({
      items: [
        { key: "p1", productId: "p1" },
        { key: "p2", productId: "p2" },
      ],
    });
    expect(res.statusCode).toBe(200);
    const [r1, r2] = JSON.parse(res.payload).results;
    expect(r1).toMatchObject({ key: "p1", status: "unknown", unknownReason: "evaluation_failed" });
    expect(r2).toMatchObject({ key: "p2", status: "ok" });
  });

  it("E7: categoryCache compartilhado entre os itens; produtos salvos numa query só", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    buscar.mockResolvedValue([
      { id: "p1", name: "A", sku: "1" },
      { id: "p2", name: "B", sku: "2" },
    ] as any);
    await post({
      items: [
        { key: "p1", productId: "p1", categoryId: "MLB1" },
        { key: "p2", productId: "p2", categoryId: "MLB1" },
        { key: "p1-bis", productId: "p1", categoryId: "MLB1" },
      ],
    });
    expect(buscar).toHaveBeenCalledTimes(1);
    expect(buscar.mock.calls[0][0]).toEqual(["p1", "p2"]);
    const caches = avaliar.mock.calls.map((c: any[]) => c[0].categoryCache);
    expect(caches).toHaveLength(3);
    expect(caches[0]).toBeInstanceOf(Map);
    expect(caches[1]).toBe(caches[0]);
    expect(caches[2]).toBe(caches[0]);
  });

  it("D7: catálogo ligado + rascunho vinculado → bloqueio vira aviso (o create não bloqueia antes do POST)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    process.env.ML_CATALOG_LISTING_ENABLED = "true";
    const issue = { attributeId: "PART_NUMBER", attributeName: "PN", reason: "missing", message: M1 };
    avaliar.mockResolvedValue({
      status: "blocked",
      blocking: [issue],
      warnings: [],
      message: M1,
      categoryId: "MLB46723",
      legacyMissingRequired: [],
    } as any);
    const res = await post({
      items: [{ key: "d", product: { name: "X", mlCatalogProductId: "MLB-CAT" } }],
    });
    expect(JSON.parse(res.payload).results[0]).toMatchObject({
      status: "ok",
      blocking: [],
      warnings: [issue],
      message: null,
    });
  });

  it("falha geral → 500 (o front trata como não validar)", async () => {
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    buscar.mockRejectedValue(new Error("banco fora"));
    const res = await post({ items: [{ key: "a", productId: "p1" }] });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toEqual({ error: "Falha ao validar atributos" });
  });

  it("GET /status devolve a flag lida na hora", async () => {
    const get = () =>
      app.inject({ method: "GET", url: "/marketplace/ml/required-attributes/status" });
    expect(JSON.parse((await get()).payload)).toEqual({ enabled: false });
    process.env.ML_REQUIRED_ATTRS_BLOCK = "1";
    expect(JSON.parse((await get()).payload)).toEqual({ enabled: true });
    expect(avaliar).not.toHaveBeenCalled();
    expect(buscar).not.toHaveBeenCalled();
  });
});
