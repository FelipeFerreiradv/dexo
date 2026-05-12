import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

vi.mock("../app/lib/prisma", () => {
  const prisma = {
    location: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
  };
  return { default: prisma };
});

vi.mock("@/app/lib/prisma", () => {
  const prisma = {
    location: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
  };
  return { default: prisma };
});

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    const userId = email === "owner@test.com" ? "user-owner" : "user-other";
    request.user = { id: userId, dataOwnerId: userId };
  },
}));

import prisma from "../app/lib/prisma";
import { scanRoutes } from "../app/routes/scan.routes";

const OWNER = "owner@test.com";
const CUID_LOC = "cln1a2b3c4d5e6f7g8h9i0j1k";
const CUID_PROD = "clz9y8x7w6v5u4t3s2r1q0p1o";

function buildApp() {
  const app = fastify();
  app.register(scanRoutes, { prefix: "/scan" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /scan/resolve", () => {
  it("resolve location a partir de URL absoluta", async () => {
    (prisma as any).location.findFirst.mockResolvedValue({
      id: CUID_LOC,
      code: "CAIXA01",
      description: "Caixa principal",
      maxCapacity: 10,
      _count: { products: 3 },
    });

    const app = buildApp();
    const payload = encodeURIComponent(
      `https://app.dexo.com/scan/location/${CUID_LOC}`,
    );
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${payload}`,
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("location");
    expect(body.location).toMatchObject({
      id: CUID_LOC,
      code: "CAIXA01",
      maxCapacity: 10,
      productsCount: 3,
      isFull: false,
    });
    expect(typeof body.scannedAt).toBe("number");
  });

  it("resolve product a partir de URL relativa", async () => {
    (prisma as any).product.findFirst.mockResolvedValue({
      id: CUID_PROD,
      sku: "SKU-A",
      name: "Peça A",
      imageUrl: "https://img/x.jpg",
      locationId: "loc-1",
      productLocation: { code: "PRAT01" },
    });

    const app = buildApp();
    const payload = encodeURIComponent(`/produtos/${CUID_PROD}`);
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${payload}`,
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("product");
    expect(body.product).toMatchObject({
      id: CUID_PROD,
      sku: "SKU-A",
      name: "Peça A",
      currentLocationId: "loc-1",
      currentLocationCode: "PRAT01",
    });
  });

  it("retorna kind unknown (200) para payload lixo", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${encodeURIComponent("not a qr")}`,
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "unknown" });
  });

  it("retorna 404 quando location não pertence ao tenant", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const payload = encodeURIComponent(`/scan/location/${CUID_LOC}`);
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${payload}`,
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().kind).toBe("location");
  });

  it("retorna 404 quando product não pertence ao tenant", async () => {
    (prisma as any).product.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const payload = encodeURIComponent(`/produtos/${CUID_PROD}`);
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${payload}`,
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().kind).toBe("product");
  });

  it("CUID puro: tenta location primeiro, depois product", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);
    (prisma as any).product.findFirst.mockResolvedValue({
      id: CUID_PROD,
      sku: "SKU-A",
      name: "Peça A",
      imageUrl: null,
      locationId: null,
      productLocation: null,
    });

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${CUID_PROD}`,
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("product");
    expect((prisma as any).location.findFirst).toHaveBeenCalledTimes(1);
    expect((prisma as any).product.findFirst).toHaveBeenCalledTimes(1);
  });

  it("CUID puro: 404 quando nem location nem product existem", async () => {
    (prisma as any).location.findFirst.mockResolvedValue(null);
    (prisma as any).product.findFirst.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${CUID_PROD}`,
      headers: { email: OWNER },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().kind).toBe("unknown");
  });

  it("401 sem header email", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/scan/resolve?payload=${encodeURIComponent("x")}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
