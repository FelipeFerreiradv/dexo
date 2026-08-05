import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify from "fastify";
import { productRoutes } from "../app/routes/product.routes";
import { UserRepositoryPrisma } from "../app/repositories/user.repository";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * Apagar a ficha técnica secundária no PUT /products/:id.
 *
 * `sanitizeProductAttributes` devolve `undefined` quando nada útil sobra, e a
 * rota tratava isso como "não mexer" — igual ao caso em que o cliente nem
 * mandou o campo. Resultado: era impossível apagar o último atributo pela UI
 * (ex.: um Código OEM digitado errado): salvava 200, o valor antigo voltava ao
 * reabrir e continuava indo para o Mercado Livre.
 *
 * Regra: campo AUSENTE = não atualiza; campo ENVIADO e vazio = limpa tudo.
 */

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: vi.fn(),
    removeListing: vi.fn(),
    updateListingFields: vi.fn(),
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
    productListing: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      // Usado por clearOverridesForEditedFields — precisa existir de verdade
      // para o teste de regressão abaixo poder observar as chamadas.
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    stockLog: { create: vi.fn() },
    systemLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  },
}));

import prisma from "../app/lib/prisma";

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

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
  dataOwnerId: "user-1",
} as any;

const produtoExistente = {
  id: "prod-1",
  sku: "PROD-OEM",
  name: "Cubo de roda dianteiro Gol",
  price: 100,
  stock: 5,
  userId: "user-1",
  attributes: { OEM: { value_name: "5U0121049" } },
  createdAt: new Date(),
  updatedAt: new Date(),
} as any;

describe("PUT /products/:id — apagar a ficha técnica", () => {
  let app: ReturnType<typeof fastify>;
  let update: any;

  beforeEach(async () => {
    app = fastify();
    await app.register(productRoutes, { prefix: "/products" });

    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(UserRepositoryPrisma.prototype, "findById").mockResolvedValue(
      fakeUser,
    );
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue(
      produtoExistente,
    );
    update = vi
      .spyOn(ProductRepositoryPrisma.prototype, "update")
      .mockImplementation(
        async (_id: any, data: any) => ({ ...produtoExistente, ...data }) as any,
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: "/products/prod-1",
      headers: { email: "test@example.com" },
      payload: payload as any,
    });

  /** `attributes` como o repositório recebeu na última chamada. */
  const attrsGravados = () => update.mock.calls.at(-1)?.[1]?.attributes;

  // Limpar é `null`, não `{}` — ver o comentário na rota. O repositório mapeia
  // null para Prisma.DbNull; `{}` faria o produto contar como "ficha editada".
  it("mapa VAZIO limpa a ficha (era no-op: o OEM errado voltava)", async () => {
    const res = await put({ name: produtoExistente.name, attributes: {} });
    expect(res.statusCode, res.payload).toBe(200);
    expect(attrsGravados()).toBeNull();
  });

  it("mapa só com valor em branco também limpa", async () => {
    const res = await put({
      name: produtoExistente.name,
      attributes: { OEM: { value_name: "   " } },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(attrsGravados()).toBeNull();
  });

  it("campo AUSENTE continua sendo 'não mexer' (undefined)", async () => {
    const res = await put({ name: produtoExistente.name });
    expect(res.statusCode, res.payload).toBe(200);
    expect(attrsGravados()).toBeUndefined();
  });

  it("valor válido continua sendo persistido", async () => {
    const res = await put({
      name: produtoExistente.name,
      attributes: { OEM: { value_name: "5U0121049" } },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(attrsGravados()).toEqual({ OEM: { value_name: "5U0121049" } });
  });

  // GUARDA DE REGRESSAO. `clearOverridesForEditedFields` invalida o override do
  // anuncio quando a ficha do produto MUDA, comparando por JSON. Produto sem
  // ficha tem a coluna NULL; se a rota gravasse `{}` ao limpar, "{}" != "null"
  // contaria como edicao e um updateMany zeraria o `attributesOverride` de
  // TODOS os anuncios — inclusive a ficha por anuncio da Revisao individual —
  // sem ninguem ter encostado na ficha tecnica.
  describe("nao invalida a ficha por anuncio sem edicao real", () => {
    const updateMany = () =>
      (prisma as any).productListing.updateMany as ReturnType<typeof vi.fn>;

    const limpouOverrideDeAtributos = () =>
      updateMany().mock.calls.some(
        (c: any[]) => c[0]?.data && "attributesOverride" in c[0].data,
      );

    it("produto SEM ficha + form mandando mapa vazio: nao toca nos anuncios", async () => {
      vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
        ...produtoExistente,
        attributes: undefined,
      } as any);

      const res = await put({ name: produtoExistente.name, attributes: {} });
      expect(res.statusCode, res.payload).toBe(200);
      expect(limpouOverrideDeAtributos()).toBe(false);
    });

    it("campo ausente tambem nao toca nos anuncios", async () => {
      const res = await put({ name: produtoExistente.name });
      expect(res.statusCode, res.payload).toBe(200);
      expect(limpouOverrideDeAtributos()).toBe(false);
    });

    it("edicao REAL da ficha continua invalidando o override (comportamento preservado)", async () => {
      const res = await put({
        name: produtoExistente.name,
        attributes: { OEM: { value_name: "OUTRO-CODIGO" } },
      });
      expect(res.statusCode, res.payload).toBe(200);
      expect(limpouOverrideDeAtributos()).toBe(true);
    });
  });

  it("entrada inválida ao lado de uma válida: só a válida sobrevive", async () => {
    const res = await put({
      name: produtoExistente.name,
      attributes: {
        OEM: { value_name: "5U0121049" },
        POSITION: { value_name: "" },
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(attrsGravados()).toEqual({ OEM: { value_name: "5U0121049" } });
  });
});
