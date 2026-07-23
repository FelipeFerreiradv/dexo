import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";

/**
 * "Criado por" real: POST /products grava o AUTOR (request.user.id — o
 * colaborador que agiu) em `createdByUserId`, SEM mexer no escopo de tenant —
 * `userId` continua sendo o dataOwnerId (admin). Colaborador tem
 * parentUserId → attachAuth deriva dataOwnerId = parentUserId ≠ id.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: async () => ({ success: true, listingId: "l-1" }),
    removeListing: vi.fn(),
    updateListingFields: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/category-resolution.service", () => ({
  CategoryResolutionService: {
    resolveMLCategory: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
      source: "explicit",
    }),
    ensureLeafLocalOnly: vi.fn().mockResolvedValue({
      externalId: "MLB-MOCK",
      fullPath: "Mock > Category",
    }),
  },
}));

vi.mock("../app/lib/prisma", () => ({
  default: {
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    productListing: { findMany: vi.fn(), deleteMany: vi.fn() },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
    logProductCreate: vi.fn(),
    logProductDelete: vi.fn(),
    logProductUpdate: vi.fn(),
    logListingDeleteFailed: vi.fn(),
  },
}));

// E-mails EXCLUSIVOS deste spec: o auth.middleware tem cache de usuário em
// nível de módulo (60s) chaveado por e-mail — e-mail repetido entre cenários
// devolveria o usuário do teste anterior.
const collaborator = {
  id: "collab-1",
  email: "collab.created-by@example.com",
  name: "Colaborador Autor",
  parentUserId: "owner-1", // → attachAuth deriva dataOwnerId = "owner-1"
} as any;

const admin = {
  id: "owner-1",
  email: "admin.created-by@example.com",
  name: "Admin Dono",
  parentUserId: null, // → dataOwnerId = o próprio id
} as any;

const payload = {
  sku: "PROD-AUTHOR",
  name: "Farol Dianteiro Gol",
  price: 100.0,
  stock: 5,
  imageUrl: "http://localhost:3333/uploads/test.jpg",
};

describe("POST /products — autoria (createdByUserId) vs dono (userId)", () => {
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    vi.spyOn(ProductRepositoryPrisma.prototype, "existsBySku").mockResolvedValue(
      false,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "create").mockImplementation(
      async (data: any) =>
        ({
          id: "prod-1",
          sku: data.sku,
          name: data.name,
          price: data.price ?? 0,
          stock: data.stock ?? 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as any,
    );
    vi.spyOn(ListingDispatcher, "dispatch").mockReturnValue({
      queued: [],
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const postAs = (user: any) => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      user,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      user,
    );
    return app.inject({
      method: "POST",
      url: "/products",
      headers: { email: user.email },
      payload,
    });
  };

  it("colaborador: grava userId = dataOwnerId (tenant) E createdByUserId = ator", async () => {
    const res = await postAs(collaborator);

    expect(res.statusCode, res.payload).toBe(201);
    expect(ProductRepositoryPrisma.prototype.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1", // escopo por tenant PRESERVADO
        createdByUserId: "collab-1", // autor real
      }),
    );
  });

  it("admin: autor = o próprio dono (createdByUserId = userId)", async () => {
    const res = await postAs(admin);

    expect(res.statusCode, res.payload).toBe(201);
    expect(ProductRepositoryPrisma.prototype.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        createdByUserId: "owner-1",
      }),
    );
  });
});
