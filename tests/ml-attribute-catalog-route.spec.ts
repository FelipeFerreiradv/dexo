import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";

// Stub do prisma client (importado por dependências transitivas).
vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../app/lib/prisma", () => ({ default: {} }));

// Auth middleware permissivo (não testamos auth aqui).
vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));

import { MLAttributeCatalogService } from "../app/marketplaces/services/ml-attribute-catalog.service";

import { marketplaceRoutes } from "../app/routes/marketplace.routes";

describe("GET /marketplace/ml/categories/:categoryId/attributes", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("devolve {attributes:[...]} chamando MLAttributeCatalogService.getAll", async () => {
    const fixture = [
      {
        id: "OCM",
        name: "OCM",
        valueType: "string",
        required: true,
        variationRequired: false,
      },
    ];
    const spy = vi
      .spyOn(MLAttributeCatalogService, "getAll")
      .mockResolvedValue(fixture as any);

    const res = await app.inject({
      method: "GET",
      url: "/marketplace/ml/categories/MLB193419/attributes",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ attributes: fixture });
    expect(spy).toHaveBeenCalledWith("MLB193419");
  });

  it("devolve 400 quando categoryId é vazio", async () => {
    // Espaço puro não passa do trim
    const res = await app.inject({
      method: "GET",
      url: "/marketplace/ml/categories/%20/attributes",
    });
    expect(res.statusCode).toBe(400);
  });

  it("é fail-open: erros do service viram 200 com lista vazia", async () => {
    vi.spyOn(MLAttributeCatalogService, "getAll").mockRejectedValue(
      new Error("ml down"),
    );

    const res = await app.inject({
      method: "GET",
      url: "/marketplace/ml/categories/MLB12345/attributes",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ attributes: [] });
  });
});
