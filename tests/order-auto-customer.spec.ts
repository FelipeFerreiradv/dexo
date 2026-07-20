import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Stub do StockSyncRetryService — deductStockForOrder dispara um setImmediate
// pós-commit que chama runOnce(), que em prod consulta prisma.stockSyncJob.
// Estes testes usam vi.spyOn(prisma, ...) (não vi.mock global do prisma), então
// sem este stub a chamada vazaria para o prisma real e travaria o vitest com
// handles abertos. Tests-only — não altera comportamento de produção.
vi.mock("@/app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));

import { OrderCustomerService } from "@/app/marketplaces/services/order-customer.service";
import { OrderUseCase } from "@/app/marketplaces/usecases/order.usercase";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { CustomerRepository } from "@/app/repositories/customer.repository";
import { orderRepository } from "@/app/repositories/order.repository";
import { MLApiService } from "@/app/marketplaces/services/ml-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { MagaluApiService } from "@/app/marketplaces/services/magalu-api.service";
import { SystemLogService } from "@/app/services/system-log.service";
import prisma from "@/app/lib/prisma";

// Token longe de expirar → o service nunca tenta refresh nestes testes.
const futureDate = () => new Date(Date.now() + 60 * 60 * 1000);

const mlAccount = () =>
  ({
    id: "acc-ml",
    userId: "owner-1",
    platform: "MERCADO_LIVRE",
    shopId: null,
    accessToken: "tok-ml",
    refreshToken: "ref-ml",
    expiresAt: futureDate(),
  }) as any;

const shopeeAccount = () =>
  ({
    id: "acc-shp",
    userId: "owner-1",
    platform: "SHOPEE",
    shopId: 123,
    accessToken: "tok-shp",
    refreshToken: "ref-shp",
    expiresAt: futureDate(),
  }) as any;

const magaluAccount = () =>
  ({
    id: "acc-mgl",
    userId: "owner-1",
    platform: "MAGALU",
    shopId: null,
    externalUserId: "seller-mgl",
    accessToken: "tok-mgl",
    refreshToken: "ref-mgl",
    expiresAt: futureDate(),
  }) as any;

const mlBilling = (identification: { type: string; number: string } | null) => ({
  buyer: {
    billing_info: {
      name: "João",
      last_name: "Silva",
      identification,
      address: {
        zip_code: "89000-000",
        street_name: "Rua das Peças",
        street_number: "10",
        neighborhood: "Centro",
        city_name: "Itajaí",
        state: { code: "BR-SC", name: "Santa Catarina" },
        country_id: "BR",
      },
    },
  },
});

/** Spies comuns: repo de Customer vazio (nenhum cliente existente) + link + log. */
function spyEmptyCrm() {
  const findByCpf = vi
    .spyOn(CustomerRepository.prototype, "findByCpf")
    .mockResolvedValue(null);
  const findByCnpj = vi
    .spyOn(CustomerRepository.prototype, "findByCnpj")
    .mockResolvedValue(null);
  const findByEmail = vi
    .spyOn(CustomerRepository.prototype, "findByEmail")
    .mockResolvedValue(null);
  const findByName = vi
    .spyOn(CustomerRepository.prototype, "findByName")
    .mockResolvedValue(null);
  const create = vi
    .spyOn(CustomerRepository.prototype, "create")
    .mockImplementation(async (data: any) => ({ id: "cust-new", ...data }));
  const setCustomer = vi
    .spyOn(orderRepository, "setCustomer")
    .mockResolvedValue(undefined);
  const logInfo = vi
    .spyOn(SystemLogService, "logInfo")
    .mockResolvedValue(undefined as any);
  return { findByCpf, findByCnpj, findByEmail, findByName, create, setCustomer, logInfo };
}

describe("OrderCustomerService.ensureCustomerForOrder", () => {
  beforeEach(() => {
    // A suíte roda com o kill-switch ligado por default (vitest.config.ts);
    // este spec testa a feature, então reabilita por caso.
    delete process.env.ORDER_AUTO_CUSTOMER_DISABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ORDER_AUTO_CUSTOMER_DISABLED = "1";
  });

  it("kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 → no-op total (zero queries/API)", async () => {
    process.env.ORDER_AUTO_CUSTOMER_DISABLED = "1";
    const findById = vi.spyOn(MarketplaceRepository, "findByIdLite");
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-1",
      externalOrderId: "ML-1",
      fallbackName: "João Silva",
    });

    expect(outcome).toEqual({ action: "disabled" });
    expect(findById).not.toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.setCustomer).not.toHaveBeenCalled();
  });

  it("ML: billing_info com CPF → cria PF com doc saneado, origem em notes e vincula o pedido", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(
      mlBilling({ type: "CPF", number: "123.456.789-01" }) as any,
    );
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-1",
      externalOrderId: "ML-1",
      fallbackName: "nick do poll",
    });

    expect(outcome).toMatchObject({ action: "created", customerId: "cust-new" });
    expect(spies.findByCpf).toHaveBeenCalledWith("12345678901", "owner-1");
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        personType: "PF",
        name: "João Silva",
        cpf: "12345678901",
        cnpj: null,
        city: "Itajaí",
        state: "SC", // "BR-SC" normalizado pelo mapeador da NF-e
        notes: expect.stringContaining("Mercado Livre · pedido #ML-1"),
      }),
    );
    expect(spies.setCustomer).toHaveBeenCalledWith("order-1", "cust-new");
  });

  it("ML: billing_info indisponível → cria cliente mínimo com o nome do poll", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(null);
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-2",
      externalOrderId: "ML-2",
      fallbackName: "Maria Souza",
    });

    expect(outcome).toMatchObject({ action: "created", customerId: "cust-new" });
    expect(spies.findByName).toHaveBeenCalledWith("Maria Souza", "owner-1");
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        name: "Maria Souza",
        notes: expect.stringContaining("Mercado Livre · pedido #ML-2"),
      }),
    );
  });

  it("comprador recorrente por CPF → vincula o existente sem criar", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(
      mlBilling({ type: "CPF", number: "12345678901" }) as any,
    );
    const spies = spyEmptyCrm();
    spies.findByCpf.mockResolvedValue({ id: "cust-1" } as any);

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-3",
      externalOrderId: "ML-3",
    });

    expect(outcome).toEqual({
      action: "linked_existing",
      customerId: "cust-1",
      matchedBy: "cpf",
    });
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.setCustomer).toHaveBeenCalledWith("order-3", "cust-1");
  });

  it("Magalu: CNPJ 14 dígitos → cria PJ com razão social", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(magaluAccount());
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      customer: {
        name: "Auto Peças LTDA",
        customer_type: "cnpj",
        document_number: "12.345.678/0001-90",
        email: "compras@autopecas.com",
        phones: [{ area_code: "47", number: "999990000" }],
      },
      deliveries: [],
    } as any);
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MAGALU",
      marketplaceAccountId: "acc-mgl",
      orderId: "order-4",
      externalOrderId: "MGL-4",
    });

    expect(outcome).toMatchObject({ action: "created" });
    expect(spies.findByCnpj).toHaveBeenCalledWith("12345678000190", "owner-1");
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        personType: "PJ",
        cnpj: "12345678000190",
        cpf: null,
        razaoSocial: "Auto Peças LTDA",
        name: "Auto Peças LTDA",
        notes: expect.stringContaining("Magalu · pedido #MGL-4"),
      }),
    );
  });

  it("documento inválido (nem 11 nem 14 dígitos) é descartado — cria sem doc, nunca lança 'CPF inválido'", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(
      mlBilling({ type: "DNI", number: "12345" }) as any,
    );
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-5",
      externalOrderId: "ML-5",
    });

    expect(outcome).toMatchObject({ action: "created" });
    // Doc inválido nunca vira identidade: dedupe caiu para o nome.
    expect(spies.findByCpf).not.toHaveBeenCalled();
    expect(spies.findByName).toHaveBeenCalledWith("João Silva", "owner-1");
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ cpf: null, cnpj: null }),
    );
  });

  it("doc rotulado 'cnpj' pela API mas com 11 dígitos → comprimento decide: dedupe e create como CPF/PF (nunca 'CNPJ inválido')", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(magaluAccount());
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      customer: {
        name: "José Truncado",
        customer_type: "cnpj", // rótulo errado da API (dado real de marketplace)
        document_number: "123.456.789-01", // 11 dígitos
      },
      deliveries: [],
    } as any);
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MAGALU",
      marketplaceAccountId: "acc-mgl",
      orderId: "order-13",
      externalOrderId: "MGL-13",
    });

    expect(outcome).toMatchObject({ action: "created" });
    expect(spies.findByCpf).toHaveBeenCalledWith("12345678901", "owner-1");
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        personType: "PF",
        cpf: "12345678901",
        cnpj: null,
        razaoSocial: null,
      }),
    );
  });

  it("comprador estrangeiro (country ≠ BR): doc de 11 dígitos (CUIT) NUNCA vira CPF — cria mínimo por nome", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    const billing = mlBilling({ type: "CUIT", number: "20123456789" }) as any;
    billing.buyer.billing_info.address.country_id = "AR";
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(billing);
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-14",
      externalOrderId: "ML-14",
    });

    expect(outcome).toMatchObject({ action: "created" });
    expect(spies.findByCpf).not.toHaveBeenCalled();
    expect(spies.findByName).toHaveBeenCalledWith("João Silva", "owner-1");
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ cpf: null, cnpj: null, personType: "PF" }),
    );
    // Endereço estrangeiro não é mapeado para o shape BR do CRM.
    expect(spies.create.mock.calls[0][0]).not.toMatchObject({ state: "SC" });
  });

  it("conta sem accessToken → NÃO tenta enriquecer (zero chamada de API/refresh) e cria pelo fallback", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue({
      ...mlAccount(),
      accessToken: null,
    });
    const billingSpy = vi.spyOn(MLApiService, "getOrderBillingInfo");
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-15",
      externalOrderId: "ML-15",
      fallbackName: "Rita Campos",
    });

    expect(billingSpy).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ action: "created" });
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Rita Campos" }),
    );
  });

  it("Magalu: comprador recorrente sem doc casa por e-mail → vincula sem criar", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(magaluAccount());
    vi.spyOn(MagaluApiService, "getOrder").mockResolvedValue({
      customer: { name: "Carlos Pereira", email: "carlos@exemplo.com" },
      deliveries: [],
    } as any);
    const spies = spyEmptyCrm();
    spies.findByEmail.mockResolvedValue({ id: "cust-9" } as any);

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MAGALU",
      marketplaceAccountId: "acc-mgl",
      orderId: "order-6",
      externalOrderId: "MGL-6",
    });

    expect(outcome).toEqual({
      action: "linked_existing",
      customerId: "cust-9",
      matchedBy: "email",
    });
    expect(spies.findByEmail).toHaveBeenCalledWith("carlos@exemplo.com", "owner-1");
    expect(spies.findByName).not.toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
  });

  it("Shopee: fiscal info traz o nome real (precede o buyer_username mascarado) e casa por nome", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(shopeeAccount());
    const fiscalSpy = vi
      .spyOn(ShopeeApiService, "getOrderFiscalInfo")
      .mockResolvedValue({
        recipient_address: {
          name: "Ana Lima",
          phone: "47999990000",
          zipcode: "89000-000",
          full_address: "Rua das Flores, 20",
          district: "Centro",
          city: "Itajaí",
          state: "SC",
        },
      } as any);
    const spies = spyEmptyCrm();
    spies.findByName.mockResolvedValue({ id: "cust-ana" } as any);

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "SHOPEE",
      marketplaceAccountId: "acc-shp",
      orderId: "order-7",
      externalOrderId: "SHP-7",
      fallbackName: "a***a",
    });

    expect(fiscalSpy).toHaveBeenCalledWith("tok-shp", 123, "SHP-7");
    expect(outcome).toEqual({
      action: "linked_existing",
      customerId: "cust-ana",
      matchedBy: "name",
    });
    expect(spies.findByName).toHaveBeenCalledWith("Ana Lima", "owner-1");
    expect(spies.create).not.toHaveBeenCalled();
  });

  it("Shopee: só buyer_username mascarado (sem doc/e-mail) → skipped_masked_name, nada criado", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(shopeeAccount());
    vi.spyOn(ShopeeApiService, "getOrderFiscalInfo").mockResolvedValue(null as any);
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "SHOPEE",
      marketplaceAccountId: "acc-shp",
      orderId: "order-8",
      externalOrderId: "SHP-8",
      fallbackName: "j***o",
    });

    expect(outcome).toEqual({ action: "skipped_masked_name" });
    expect(spies.findByName).not.toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.setCustomer).not.toHaveBeenCalled();
  });

  it("sem identidade nenhuma (nome < 2 chars, sem doc/e-mail) → skipped_no_identity", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(null);
    const spies = spyEmptyCrm();

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-9",
      externalOrderId: "ML-9",
      fallbackName: "X",
    });

    expect(outcome).toEqual({ action: "skipped_no_identity" });
    expect(spies.create).not.toHaveBeenCalled();
  });

  it("corrida: create bate em duplicata (P2002/'Já existe') → re-busca por doc e vincula", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(
      mlBilling({ type: "CPF", number: "12345678901" }) as any,
    );
    const spies = spyEmptyCrm();
    // 1ª busca (dedupe) e 2ª (ensureCpfUnique do usecase) → null;
    // 3ª (re-busca pós-corrida) → cliente criado pelo processo concorrente.
    spies.findByCpf
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "cust-raced" } as any);
    spies.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-10",
      externalOrderId: "ML-10",
    });

    expect(outcome).toEqual({
      action: "linked_existing",
      customerId: "cust-raced",
      matchedBy: "cpf",
    });
    expect(spies.setCustomer).toHaveBeenCalledWith("order-10", "cust-raced");
  });

  it("falha total (findById lança) → { action: 'failed' } sem rejeitar a promise", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockRejectedValue(
      new Error("db down"),
    );
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      OrderCustomerService.ensureCustomerForOrder({
        platform: "SHOPEE",
        marketplaceAccountId: "acc-shp",
        orderId: "order-11",
        externalOrderId: "SHP-11",
        fallbackName: "Ana Lima",
      }),
    ).resolves.toEqual({ action: "failed" });
    expect(consoleErr).toHaveBeenCalled();
  });

  it("falha só no vínculo (setCustomer lança) → cliente criado permanece, nada propaga", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdLite").mockResolvedValue(mlAccount());
    vi.spyOn(MLApiService, "getOrderBillingInfo").mockResolvedValue(null);
    const spies = spyEmptyCrm();
    spies.setCustomer.mockRejectedValue(new Error("update falhou"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await OrderCustomerService.ensureCustomerForOrder({
      platform: "MERCADO_LIVRE",
      marketplaceAccountId: "acc-ml",
      orderId: "order-12",
      externalOrderId: "ML-12",
      fallbackName: "Pedro Alves",
    });

    expect(outcome).toMatchObject({ action: "created", customerId: "cust-new" });
    expect(consoleErr).toHaveBeenCalled();
  });
});

describe("hooks de import — best-effort e escopo (pedido novo apenas)", () => {
  beforeEach(() => {
    delete process.env.ORDER_AUTO_CUSTOMER_DISABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ORDER_AUTO_CUSTOMER_DISABLED = "1";
  });

  function spyShopeeImportBase() {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(
      shopeeAccount(),
    );
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
  }

  it("Shopee: ensureCustomerForOrder rejeitando NÃO afeta o import (imported=1, errors=0, sem result duplicado)", async () => {
    spyShopeeImportBase();
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([
      {
        order_sn: "SHP-NEW-1",
        order_status: "READY_TO_SHIP",
        total_amount: 100,
        buyer_username: "cliente",
        item_list: [{ item_id: 999, model_quantity_purchased: 1 }],
      },
    ] as any);
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [{ productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null }],
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-shp-1",
      items: [],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);
    const ensureSpy = vi
      .spyOn(OrderCustomerService, "ensureCustomerForOrder")
      .mockRejectedValue(new Error("boom"));

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-shp",
      3,
      true,
    );

    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith({
      platform: "SHOPEE",
      marketplaceAccountId: "acc-shp",
      orderId: "order-shp-1",
      externalOrderId: "SHP-NEW-1",
      fallbackName: "cliente",
    });
    expect(result).toMatchObject({ imported: 1, errors: 0, alreadyExists: 0 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      externalOrderId: "SHP-NEW-1",
      status: "imported",
    });
  });

  it("Shopee: pedido já existente (already_exists) NÃO chama o auto-cadastro", async () => {
    spyShopeeImportBase();
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([
      { externalOrderId: "SHP-OLD-1" },
    ] as any);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([
      {
        order_sn: "SHP-OLD-1",
        order_status: "READY_TO_SHIP",
        total_amount: 100,
        buyer_username: "cliente",
        item_list: [{ item_id: 999, model_quantity_purchased: 1 }],
      },
    ] as any);
    const ensureSpy = vi.spyOn(OrderCustomerService, "ensureCustomerForOrder");

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-shp",
      1,
      true,
    );

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(result.alreadyExists).toBe(1);
  });

  it("ML: pedido novo dispara o auto-cadastro com o orderId local; rejeição não aborta o batch", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue({
      ...mlAccount(),
      externalUserId: "seller-1",
    });
    vi.spyOn(OrderUseCase as any, "getRecentMLOrdersWithRefresh").mockResolvedValue([
      {
        id: 555,
        status: "paid",
        total_amount: 100,
        order_items: [],
        buyer: { nickname: "nick-ml" },
      },
    ]);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(OrderUseCase as any, "processOrder").mockResolvedValue({
      success: true,
      orderId: "order-ml-555",
      externalOrderId: "555",
      status: "imported",
      message: "ok",
      stockDeducted: true,
      itemsLinked: 1,
      itemsTotal: 1,
    });
    // Rejeição proposital: prova que o try/catch do call-site ML segura o
    // throw (sem ele, o batch inteiro abortaria — o loop ML não tem try/catch
    // por pedido).
    const ensureSpy = vi
      .spyOn(OrderCustomerService, "ensureCustomerForOrder")
      .mockRejectedValue(new Error("boom"));

    const result = await OrderUseCase.importRecentOrdersForAccount(
      "acc-ml",
      7,
      true,
    );

    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "MERCADO_LIVRE",
        marketplaceAccountId: "acc-ml",
        orderId: "order-ml-555",
        externalOrderId: "555",
        fallbackName: "nick-ml",
      }),
    );
    expect(result).toMatchObject({ imported: 1, errors: 0 });
  });

  it("Magalu: pedido novo importado dispara o auto-cadastro; rejeição não afeta o import", async () => {
    vi.spyOn(MarketplaceRepository, "findById").mockResolvedValue(magaluAccount());
    vi.spyOn(OrderUseCase as any, "getRecentMagaluOrdersWithRefresh").mockResolvedValue([
      {
        id: "MGL-1",
        // "approved" mapeia para PAID — o gate do import só aceita
        // PAID/SHIPPED/DELIVERED (status desconhecido vira PENDING e é pulado).
        status: "approved",
        total: 100,
        customer_name: "Cliente Magalu",
        items: [{ sku: "SKU-1", quantity: 1 }],
      },
    ]);
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.syncLog, "create").mockResolvedValue({} as any);
    vi.spyOn(OrderUseCase as any, "mapMagaluOrderItems").mockResolvedValue({
      items: [{ productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null }],
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-mgl-1",
      items: [],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);
    const ensureSpy = vi
      .spyOn(OrderCustomerService, "ensureCustomerForOrder")
      .mockRejectedValue(new Error("boom"));

    const result = await OrderUseCase.importRecentMagaluOrdersForAccount(
      "acc-mgl",
      7,
      true,
    );

    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "MAGALU",
        marketplaceAccountId: "acc-mgl",
        orderId: "order-mgl-1",
        externalOrderId: "MGL-1",
        fallbackName: "Cliente Magalu",
      }),
    );
    expect(result).toMatchObject({ imported: 1, errors: 0 });
    expect(result.results).toHaveLength(1);
  });

  it("kill-switch ligado → hook não chama o service com side effects (retorna disabled antes de qualquer query)", async () => {
    process.env.ORDER_AUTO_CUSTOMER_DISABLED = "1";
    spyShopeeImportBase();
    vi.spyOn(prisma.order, "findMany").mockResolvedValue([]);
    vi.spyOn(ShopeeApiService, "getRecentOrders").mockResolvedValue([
      {
        order_sn: "SHP-KS-1",
        order_status: "READY_TO_SHIP",
        total_amount: 100,
        buyer_username: "cliente",
        item_list: [{ item_id: 999, model_quantity_purchased: 1 }],
      },
    ] as any);
    vi.spyOn(OrderUseCase as any, "mapShopeeOrderItems").mockResolvedValue({
      items: [{ productId: "prod-1", quantity: 1, unitPrice: 100, listingId: null }],
      linkedCount: 1,
    });
    vi.spyOn(orderRepository, "create").mockResolvedValue({
      id: "order-ks-1",
      items: [],
    } as any);
    vi.spyOn(OrderUseCase as any, "deductStockForOrder").mockResolvedValue([]);
    // Repo de Customer NUNCA deve ser tocado com o kill-switch ligado.
    const findByName = vi.spyOn(CustomerRepository.prototype, "findByName");
    const createCustomer = vi.spyOn(CustomerRepository.prototype, "create");
    const setCustomer = vi.spyOn(orderRepository, "setCustomer");

    const result = await OrderUseCase.importRecentShopeeOrdersForAccount(
      "acc-shp",
      3,
      true,
    );

    expect(result).toMatchObject({ imported: 1, errors: 0 });
    expect(findByName).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
    expect(setCustomer).not.toHaveBeenCalled();
  });
});
