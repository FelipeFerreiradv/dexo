import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// Alteração C — "Vincular a outra localização" individual. A UI
// reusa o endpoint já existente POST /locations/move-products com
// 1 productId. Aqui garantimos que esse caminho move atomicamente.
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => {
  const prisma = {
    product: { updateMany: vi.fn() },
    location: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  const prisma = {
    product: { updateMany: vi.fn() },
    location: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any, reply: any) => {
    const email = request.headers["email"];
    if (!email) return reply.status(401).send({ message: "Email is required" });
    request.user = { id: "user-owner", dataOwnerId: "user-owner" };
  },
}));

// moveProducts/buildFullPath usam o LocationRepositoryPrisma.
const moveProductsMock = vi.fn();
vi.mock("../app/repositories/location.repository", () => ({
  LocationRepositoryPrisma: class {
    async findById(id: string) {
      if (id === "loc-dest") {
        return {
          id: "loc-dest",
          userId: "user-owner",
          code: "PRAT-B",
          description: undefined,
          maxCapacity: 0, // sem limite
          parentId: undefined,
          createdAt: new Date(),
          updatedAt: new Date(),
          productsCount: 0,
        };
      }
      return null; // para a recursão de buildFullPath
    }
    moveProducts = moveProductsMock;
  },
}));

import { locationRoutes } from "../app/routes/location.routes";

const OWNER = "owner@test.com";

function buildApp() {
  const app = fastify();
  app.register(locationRoutes, { prefix: "/locations" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /locations/move-products — produto individual", () => {
  it("move 1 produto para outra localização (200)", async () => {
    moveProductsMock.mockResolvedValue(1);

    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: "loc-dest" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.message).toContain("PRAT-B");
    // Move atômico: um único updateMany via repositório, com o id único.
    expect(moveProductsMock).toHaveBeenCalledWith(
      ["p1"],
      "loc-dest",
      "user-owner",
      "PRAT-B",
    );
  });

  it("400 quando productIds vazio (guarda do endpoint)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: [], targetLocationId: "loc-dest" },
    });
    expect(res.statusCode).toBe(400);
    expect(moveProductsMock).not.toHaveBeenCalled();
  });

  it("404 quando localização destino não existe", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/locations/move-products",
      headers: { email: OWNER, "content-type": "application/json" },
      payload: { productIds: ["p1"], targetLocationId: "loc-inexistente" },
    });
    expect(res.statusCode).toBe(404);
    expect(moveProductsMock).not.toHaveBeenCalled();
  });
});
