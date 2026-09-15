import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

// ──────────────────────────────────────────────────────────
// GET /locations/:id/products — a rota que alimenta a gaveta "Produtos em X".
//
// Ela SEMPRE aceitou `page`/`limit`; o que não existia era um consumidor que
// mandasse `page` (a tela pedia 50 e nunca a página seguinte, escondendo 11.518
// peças só no cliente MK2). Estes testes travam o contrato agora que a tela
// pagina de verdade, e travam a checagem de existência da localização — que
// deixou de usar o `findById` pesado do repositório (parent + todas as filhas +
// COUNT de produtos de cada uma) e passou a ser um `findFirst` enxuto.
// ──────────────────────────────────────────────────────────

const findFirstMock = vi.hoisted(() => vi.fn());
const getProductsMock = vi.hoisted(() => vi.fn());

vi.mock("../app/lib/prisma", () => {
  const prisma: any = {
    location: { findFirst: findFirstMock },
    product: { updateMany: vi.fn(), groupBy: vi.fn() },
    $transaction: vi.fn(async (cb: any) => cb(prisma)),
  };
  return { default: prisma };
});
vi.mock("@/app/lib/prisma", () => {
  const prisma: any = {
    location: { findFirst: findFirstMock },
    product: { updateMany: vi.fn(), groupBy: vi.fn() },
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

const findByIdMock = vi.hoisted(() => vi.fn());
vi.mock("../app/repositories/location.repository", () => ({
  LocationRepositoryPrisma: class {
    findById = findByIdMock;
    getProductsByLocationId = getProductsMock;
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
  findFirstMock.mockResolvedValue({ id: "loc-1" });
  getProductsMock.mockResolvedValue({ products: [], total: 168 });
});

describe("GET /locations/:id/products — paginação", () => {
  it("repassa page e limit para o repositório", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations/loc-1/products?page=3&limit=50",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(200);
    expect(getProductsMock).toHaveBeenCalledWith(
      "loc-1",
      "user-owner",
      expect.objectContaining({ page: 3, limit: 50 }),
    );
  });

  it("mantém page 1 e limit 50 como padrão quando não são enviados", async () => {
    // Controle negativo: a primeira requisição da tela tem de continuar
    // byte-idêntica à de produção.
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/locations/loc-1/products",
      headers: { email: OWNER },
    });

    expect(getProductsMock).toHaveBeenCalledWith(
      "loc-1",
      "user-owner",
      expect.objectContaining({ page: 1, limit: 50 }),
    );
  });

  it("devolve o total verdadeiro e o número de páginas", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations/loc-1/products?page=1&limit=50",
      headers: { email: OWNER },
    });

    const body = res.json();
    expect(body.pagination.total).toBe(168);
    expect(body.pagination.totalPages).toBe(4);
  });

  it("repassa a busca quando enviada", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/locations/loc-1/products?search=35010",
      headers: { email: OWNER },
    });

    expect(getProductsMock).toHaveBeenCalledWith(
      "loc-1",
      "user-owner",
      expect.objectContaining({ search: "35010" }),
    );
  });
});

describe("GET /locations/:id/products — checagem de existência", () => {
  it("404 quando a localização não é do tenant", async () => {
    findFirstMock.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations/loc-de-outro/products",
      headers: { email: OWNER },
    });

    expect(res.statusCode).toBe(404);
    expect(getProductsMock).not.toHaveBeenCalled();
  });

  it("escopa a checagem por id E userId", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/locations/loc-1/products",
      headers: { email: OWNER },
    });

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loc-1", userId: "user-owner" },
      }),
    );
  });

  it("não usa o findById pesado do repositório para só checar existência", async () => {
    // `findById` traz parent + TODAS as filhas + COUNT de produtos de cada uma.
    // Com a paginação, esse custo passaria a acontecer a cada "Carregar mais".
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/locations/loc-1/products?page=2",
      headers: { email: OWNER },
    });

    expect(findByIdMock).not.toHaveBeenCalled();
    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });

  it("401 sem o header de e-mail", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/locations/loc-1/products",
    });
    expect(res.statusCode).toBe(401);
  });
});
