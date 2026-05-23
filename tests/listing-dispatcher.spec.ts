import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { ListingDispatcher } from "@/app/marketplaces/services/listing-dispatcher.service";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";

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
        { platform: "MERCADO_LIVRE", accountId: "acc-ml-1", categoryId: "MLB123" },
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
        { platform: "MERCADO_LIVRE", accountId: "acc-ml-1", categoryId: "MLB123" },
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
        { platform: "MERCADO_LIVRE", accountId: "acc-ml-2", categoryId: "MLB123" },
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
        { platform: "MERCADO_LIVRE", accountId: "acc-ml-3", categoryId: "MLB123" },
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
