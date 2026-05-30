import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { ListingDispatcher } from "@/app/marketplaces/services/listing-dispatcher.service";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { ProductRepositoryPrisma } from "@/app/repositories/product.repository";

describe("ListingDispatcher.dispatch — observabilidade simétrica ML↔Shopee", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: aguarda o microtask queue (todos os `void this.runOne()` enfileirados)
  // drenar antes do test assert. dispatch() é fire-and-forget e retorna sincronamente.
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));

  it("loga [ListingDispatcher] MERCADO_LIVRE listing failed quando createMLListing retorna success:false (antes da fix, esse erro era silencioso)", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: false,
      error: "Conta do Mercado Livre com restrição — verificar Seller Center",
    } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-1",
      requests: [
        {
          platform: "MERCADO_LIVRE",
          accountId: "acc-ml-1",
          categoryId: "MLB123",
        },
      ],
    });

    await flushMicrotasks();
    await flushMicrotasks(); // dois flushes — runOne usa await aninhado

    const mlFailureLog = consoleErrorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("[ListingDispatcher] MERCADO_LIVRE listing failed") &&
        call[0].includes("product=prod-1") &&
        call[0].includes("account=acc-ml-1"),
    );
    expect(mlFailureLog).toBeDefined();
  });

  it("emite event:listing.dispatch.result estruturado para sucesso de ML", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      listingId: "listing-local-1",
      externalListingId: "MLB987654",
    } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-2",
      requests: [
        {
          platform: "MERCADO_LIVRE",
          accountId: "acc-ml-1",
          categoryId: "MLB123",
        },
      ],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    const resultLog = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .find((arg) => {
        if (typeof arg !== "string") return false;
        try {
          const parsed = JSON.parse(arg);
          return (
            parsed.event === "listing.dispatch.result" &&
            parsed.platform === "MERCADO_LIVRE" &&
            parsed.productId === "prod-2" &&
            parsed.success === true &&
            parsed.listingId === "listing-local-1" &&
            parsed.externalListingId === "MLB987654"
          );
        } catch {
          return false;
        }
      });
    expect(resultLog).toBeDefined();
  });

  it("emite event:listing.dispatch.result com success=false e error para falha de ML", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: false,
      error: "Erro X do ML",
      mlError: { code: "item.title.invalid" },
    } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-3",
      requests: [
        {
          platform: "MERCADO_LIVRE",
          accountId: "acc-ml-2",
          categoryId: "MLB123",
        },
      ],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    const resultLog = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .find((arg) => {
        if (typeof arg !== "string") return false;
        try {
          const parsed = JSON.parse(arg);
          return (
            parsed.event === "listing.dispatch.result" &&
            parsed.platform === "MERCADO_LIVRE" &&
            parsed.productId === "prod-3" &&
            parsed.success === false &&
            parsed.error === "Erro X do ML"
          );
        } catch {
          return false;
        }
      });
    expect(resultLog).toBeDefined();
  });

  it("Shopee continua logando falha (regressão check)", async () => {
    vi.spyOn(ListingUseCase, "createShopeeListing").mockResolvedValue({
      success: false,
      error: "Auto-Part Number is mandatory required",
    } as any);

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-4",
      requests: [
        { platform: "SHOPEE", accountId: "acc-shopee-1", categoryId: "102340" },
      ],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    const shopeeFailureLog = consoleErrorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("[ListingDispatcher] Shopee listing failed") &&
        call[0].includes("product=prod-4"),
    );
    expect(shopeeFailureLog).toBeDefined();
  });

  it("exceção em createMLListing é capturada e loga threw:true no event estruturado", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockRejectedValue(
      new Error("connect ETIMEDOUT api.mercadolibre.com"),
    );

    ListingDispatcher.dispatch({
      userId: "user-1",
      productId: "prod-5",
      requests: [
        {
          platform: "MERCADO_LIVRE",
          accountId: "acc-ml-3",
          categoryId: "MLB123",
        },
      ],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // Continua logando o erro humano (legado)
    const errorLog = consoleErrorSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("[ListingDispatcher] MERCADO_LIVRE error"),
    );
    expect(errorLog).toBeDefined();

    // E agora também o estruturado
    const resultLog = consoleLogSpy.mock.calls
      .map((call) => call[0])
      .find((arg) => {
        if (typeof arg !== "string") return false;
        try {
          const parsed = JSON.parse(arg);
          return (
            parsed.event === "listing.dispatch.result" &&
            parsed.platform === "MERCADO_LIVRE" &&
            parsed.productId === "prod-5" &&
            parsed.success === false &&
            parsed.threw === true &&
            typeof parsed.error === "string" &&
            parsed.error.includes("ETIMEDOUT")
          );
        } catch {
          return false;
        }
      });
    expect(resultLog).toBeDefined();
  });
});

describe("ListingDispatcher.runOneWithResult — aumento escalonado entre contas ML", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Cache pré-fetched (evita DB). price/costPrice como o dispatchBatch monta.
  const cacheFor = (price: number, costPrice = 50) =>
    new Map([
      ["prod-1", { id: "prod-1", name: "Produto X", price, costPrice }],
    ]) as any;

  const mlReq = (accountId: string) =>
    ({ platform: "MERCADO_LIVRE" as const, accountId }) as any;

  const mockCreateOk = () =>
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      listingId: "L1",
      externalListingId: "MLB1",
    } as any);

  it("REGRESSÃO: sem overrideTemplate ⇒ updateListingFields NÃO é chamado", async () => {
    mockCreateOk();
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    const res = await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      mlReq("acc1"),
      null,
      cacheFor(100),
    );

    expect(res.success).toBe(true);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("REGRESSÃO: regra delta_pct sem cascata ⇒ priceOverride = preço da regra (130)", async () => {
    mockCreateOk();
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      mlReq("acc1"),
      { priceRule: { type: "delta_pct", value: 30 } } as any,
      cacheFor(100),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(130);
  });

  it("cascata ON: índice 1 recebe priceOverride = base × (1+10%)¹ = 110", async () => {
    mockCreateOk();
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

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

  it("cascata ON: 1ª conta (índice 0) mantém o preço base ⇒ updateListingFields NÃO é chamado", async () => {
    mockCreateOk();
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      mlReq("acc0"),
      {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { acc0: 0, acc1: 1 },
        },
      } as any,
      cacheFor(100),
    );

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("cascata compõe com a regra de preço: delta_pct 30 (base→130) × 10%¹ = 143", async () => {
    mockCreateOk();
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      mlReq("acc1"),
      {
        priceRule: { type: "delta_pct", value: 30 },
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { acc1: 1 },
        },
      } as any,
      cacheFor(100),
    );

    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(143);
  });

  it("Shopee nunca escalona (guard de plataforma) ⇒ updateListingFields NÃO é chamado", async () => {
    vi.spyOn(ListingUseCase, "createShopeeListing").mockResolvedValue({
      success: true,
      listingId: "L-shopee",
    } as any);
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    await ListingDispatcher.runOneWithResult(
      "user-1",
      "prod-1",
      { platform: "SHOPEE" as const, accountId: "acc1" } as any,
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
});

describe("ListingDispatcher.dispatch — aumento escalonado no fluxo single (Opção A)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };

  it("buildCrossAccountOverride: indexByAccountId pela ordem das contas ML; <2 ou %<=0 ⇒ null", () => {
    const reqs = [
      { platform: "MERCADO_LIVRE" as const, accountId: "a" },
      { platform: "SHOPEE" as const, accountId: "s" },
      { platform: "MERCADO_LIVRE" as const, accountId: "b" },
    ];
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 10)).toEqual({
      crossAccountIncrease: {
        enabled: true,
        percent: 10,
        indexByAccountId: { a: 0, b: 1 },
      },
    });
    expect(ListingDispatcher.buildCrossAccountOverride(reqs, 0)).toBeNull();
    expect(
      ListingDispatcher.buildCrossAccountOverride(
        [{ platform: "MERCADO_LIVRE" as const, accountId: "a" }],
        10,
      ),
    ).toBeNull();
  });

  it("dispatch com overrideTemplate aplica priceOverride só em idx>0 ML (110 na 2ª conta)", async () => {
    vi.spyOn(ProductRepositoryPrisma.prototype, "findById").mockResolvedValue({
      id: "prod-1",
      name: "P",
      price: 100,
      costPrice: 50,
    } as any);
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      listingId: "L",
      externalListingId: "MLB",
    } as any);
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);

    ListingDispatcher.dispatch({
      userId: "u",
      productId: "prod-1",
      requests: [
        { platform: "MERCADO_LIVRE", accountId: "a" },
        { platform: "MERCADO_LIVRE", accountId: "b" },
      ],
      overrideTemplate: {
        crossAccountIncrease: {
          enabled: true,
          percent: 10,
          indexByAccountId: { a: 0, b: 1 },
        },
      },
    });
    await flush();

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect((updateSpy.mock.calls[0][2] as any).priceOverride).toBe(110);
  });

  it("REGRESSÃO: sem overrideTemplate não busca produto nem chama updateListingFields", async () => {
    vi.spyOn(ListingUseCase, "createMLListing").mockResolvedValue({
      success: true,
      listingId: "L",
    } as any);
    const updateSpy = vi
      .spyOn(ListingUseCase, "updateListingFields")
      .mockResolvedValue({ success: true } as any);
    const findSpy = vi.spyOn(ProductRepositoryPrisma.prototype, "findById");

    ListingDispatcher.dispatch({
      userId: "u",
      productId: "prod-1",
      requests: [{ platform: "MERCADO_LIVRE", accountId: "a" }],
    });
    await flush();

    expect(updateSpy).not.toHaveBeenCalled();
    expect(findSpy).not.toHaveBeenCalled();
  });
});
