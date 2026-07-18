import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Prisma mockado: o prefetch enxuto do dispatch (SELECT id,name,price,costPrice)
// usa prisma direto (padrão perf/egress do dispatchBatch). findFirst sem
// implementação ⇒ undefined ⇒ os testes que mockam só o findById caem no
// fallback do applyOverridesAfterCreate (mesmo dado, caminho frio).
vi.mock("../app/lib/prisma", () => ({
  default: {
    product: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import prisma from "../app/lib/prisma";
import { ListingDispatcher } from "../app/marketplaces/services/listing-dispatcher.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";
import { ProductRepositoryPrisma } from "../app/repositories/product.repository";

/**
 * Escalonamento de preço entre contas para Shopee/Magalu (paridade com ML).
 *
 * Cada plataforma tem escada 0-based PRÓPRIA (mapas independentes no
 * crossAccountIncrease); Shopee/Magalu nunca leem o mapa ML e vice-versa.
 * O kill-switch CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED=1 reverte os
 * builders ao comportamento ML-only anterior. Os cenários legados (só ML)
 * continuam cobertos por tests/listing-dispatcher.spec.ts, que NÃO muda.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(prisma.product.findFirst).mockReset();
});

describe("ListingDispatcher.buildCrossAccountOverride — mapas por plataforma", () => {
  const mixed = [
    { platform: "MERCADO_LIVRE" as const, accountId: "a" },
    { platform: "SHOPEE" as const, accountId: "s1" },
    { platform: "MERCADO_LIVRE" as const, accountId: "b" },
    { platform: "SHOPEE" as const, accountId: "s2" },
    { platform: "MAGALU" as const, accountId: "m1" },
    { platform: "MAGALU" as const, accountId: "m2" },
  ];

  it("requests mistos ⇒ 3 mapas independentes, cada um 0-based na sua plataforma", () => {
    expect(ListingDispatcher.buildCrossAccountOverride(mixed, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        indexByAccountId: { a: 0, b: 1 },
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
        magaluIndexByAccountId: { m1: 0, m2: 1 },
      },
    });
  });

  it("2 contas Shopee + 1 ML ⇒ template só com o mapa Shopee (ML sem mapa = idx 0 = preço base)", () => {
    const reqs = [
      { platform: "MERCADO_LIVRE" as const, accountId: "a" },
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "SHOPEE" as const, accountId: "s2" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
      },
    });
  });

  it("1 conta de cada plataforma ⇒ null (nenhuma escada possível)", () => {
    const reqs = [
      { platform: "MERCADO_LIVRE" as const, accountId: "a" },
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "MAGALU" as const, accountId: "m1" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toBeNull();
  });

  it("percent <= 0 ⇒ null mesmo com contas suficientes", () => {
    expect(ListingDispatcher.buildCrossAccountOverride(mixed, 0)).toBeNull();
    expect(ListingDispatcher.buildCrossAccountOverride(mixed, -5)).toBeNull();
  });

  it("conta repetida na mesma plataforma conta uma vez só (dedupe preservado)", () => {
    const reqs = [
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "SHOPEE" as const, accountId: "s1" },
      { platform: "SHOPEE" as const, accountId: "s2" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        shopeeIndexByAccountId: { s1: 0, s2: 1 },
      },
    });
  });

  describe("kill-switch CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED=1", () => {
    it("requests mistos ⇒ resultado byte-idêntico ao legado (só mapa ML)", () => {
      vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
      expect(ListingDispatcher.buildCrossAccountOverride(mixed, 10)).toEqual({
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { a: 0, b: 1 },
        },
      });
    });

    it("2 Shopee + 1 ML ⇒ null (como antes da feature)", () => {
      vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
      const reqs = [
        { platform: "MERCADO_LIVRE" as const, accountId: "a" },
        { platform: "SHOPEE" as const, accountId: "s1" },
        { platform: "SHOPEE" as const, accountId: "s2" },
      ];
      expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toBeNull();
    });
  });
});

describe("ListingDispatcher.runOneWithResult — escalonado Shopee/Magalu (batch)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // Cache pré-fetched (evita DB). price/costPrice como o dispatchBatch monta.
  const cacheFor = (price: number, costPrice = 50) =>
    new Map([
      ["prod-1", { id: "prod-1", name: "Produto X", price, costPrice }],
    ]) as any;

  const shopeeReq = (accountId: string) =>
    ({ platform: "SHOPEE" as const, accountId }) as any;
  const magaluReq = (accountId: string) =>
    ({ platform: "MAGALU" as const, accountId }) as any;
  const mlReq = (accountId: string) =>
    ({ platform: "MERCADO_LIVRE" as const, accountId }) as any;

  const mockCreates = () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      listingId: "L-ml",
    } as any);
    vi.spyOn(ListingUseCase, "createShopeeListing").mockResolvedValue({
      success: true,
      listingId: "L-shopee",
    } as any);
    vi.spyOn(ListingUseCase, "createMagaluListing").mockResolvedValue({
      success: true,
      listingId: "L-magalu",
    } as any);
    return vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);
  };

  const shopeeLadder = {
    crossAccountIncrease: {
      enabled: true,
      percent: 10,
      shopeeIndexByAccountId: { acc0: 0, acc1: 1 },
    },
  } as any;

  it("SHOPEE índice 1 ⇒ priceOverride = base × (1+10%)¹ = 110", async () => {
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      shopeeReq("acc1"),
      shopeeLadder,
      cacheFor(100),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe("L-shopee");
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(110);
  });

  it("SHOPEE índice 0 mantém o preço base ⇒ updateListingFields NÃO é chamado", async () => {
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      shopeeReq("acc0"),
      shopeeLadder,
      cacheFor(100),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("MAGALU índice 1 ⇒ priceOverride = 110 (mapa próprio)", async () => {
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      magaluReq("acc1"),
      {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          magaluIndexByAccountId: { acc0: 0, acc1: 1 },
        },
      } as any,
      cacheFor(100),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe("L-magalu");
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(110);
  });

  it("cascata Shopee compõe com a regra de preço: delta_pct 30 (base→130) × 10%¹ = 143", async () => {
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      shopeeReq("acc1"),
      {
        priceRule: { type: "delta_pct", value: 30 },
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          shopeeIndexByAccountId: { acc1: 1 },
        },
      } as any,
      cacheFor(100),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(143);
  });

  it("ANTI-VAZAMENTO: request ML NÃO lê o mapa Shopee (template só-Shopee ⇒ ML sem update)", async () => {
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      mlReq("acc1"),
      shopeeLadder,
      cacheFor(100),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("ANTI-VAZAMENTO: request MAGALU não lê o mapa ML (jobs antigos ⇒ ML-only)", async () => {
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      magaluReq("acc1"),
      {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { acc1: 1 },
        },
      } as any,
      cacheFor(100),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("kill-switch na LEITURA: template já persistido com mapa Shopee ⇒ sem escalonamento", async () => {
    vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      shopeeReq("acc1"),
      shopeeLadder,
      cacheFor(100),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("kill-switch NÃO afeta o ML (mapa legado continua escalonando)", async () => {
    vi.stubEnv("CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED", "1");
    const updateSpy = mockCreates();
    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      mlReq("acc1"),
      {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { acc0: 0, acc1: 1 },
        },
      } as any,
      cacheFor(100),
    );
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(110);
  });
});

describe("ListingDispatcher.dispatch — escalonado Shopee/Magalu (fluxo single)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };

  it("dispatch SHOPEE/MAGALU com template aplica priceOverride só em idx>0", async () => {
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "prod-1",
      name: "P",
      price: 100,
      costPrice: 50,
    } as any);
    vi.spyOn(ListingUseCase, "createShopeeListing").mockResolvedValue({
      success: true,
      listingId: "L-s",
    } as any);
    vi.spyOn(ListingUseCase, "createMagaluListing").mockResolvedValue({
      success: true,
      listingId: "L-m",
    } as any);
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-1",
      requests: [
        { platform: "SHOPEE", accountId: "s0" },
        { platform: "SHOPEE", accountId: "s1" },
        { platform: "MAGALU", accountId: "m0" },
        { platform: "MAGALU", accountId: "m1" },
      ],
      overrideTemplate: {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          shopeeIndexByAccountId: { s0: 0, s1: 1 },
          magaluIndexByAccountId: { m0: 0, m1: 1 },
        },
      } as any,
    });
    await flush();

    // Só as contas de índice 1 (uma por plataforma) recebem update = 110.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    const targets = updateSpy.mock.calls.map((c) => c[0]).sort();
    expect(targets).toEqual(["L-m", "L-s"]);
    for (const call of updateSpy.mock.calls) {
      expect((call[2] as any).priceOverride).toBe(110);
    }
  });

  it("EGRESS: prefetch do single usa SELECT enxuto escopado por userId — sem row inteira", async () => {
    // Sem spy no findById: o método REAL roda em modo rulesLite contra o
    // prisma mockado — a prova do egress está nos argumentos da query.
    vi.mocked(prisma.product.findFirst).mockResolvedValue({
      id: "prod-1",
      name: "P",
      price: 100,
      costPrice: 50,
    } as never);
    vi.spyOn(ListingUseCase, "createShopeeListing").mockResolvedValue({
      success: true,
      listingId: "L-s",
    } as any);
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-1",
      requests: [
        { platform: "SHOPEE", accountId: "s0" },
        { platform: "SHOPEE", accountId: "s1" },
      ],
      overrideTemplate: {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          shopeeIndexByAccountId: { s0: 0, s1: 1 },
        },
      } as any,
    });
    await flush();

    // Uma única query, com select de 4 colunas (sem include) e escopo de tenant.
    expect(prisma.product.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: "prod-1", userId: "user-1" },
      select: { id: true, name: true, price: true, costPrice: true },
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(110);
  });

  it("REGRESSÃO: dispatch SHOPEE sem template ⇒ sem fetch de produto e sem update", async () => {
    const findSpy = vi
      .spyOn(ProductRepositoryPrisma.prototype, "findById")
      .mockResolvedValue({ id: "prod-1", name: "P", price: 100 } as any);
    vi.spyOn(ListingUseCase, "createShopeeListing").mockResolvedValue({
      success: true,
      listingId: "L-s",
    } as any);
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-1",
      requests: [{ platform: "SHOPEE", accountId: "s0" }],
    });
    await flush();

    expect(findSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
