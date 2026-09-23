import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { ListingRetryService } from "../app/marketplaces/services/listing-retry.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingUseCase } from "../app/marketplaces/usecases/listing.usercase";

/**
 * Cron de retentativa do ML (PR-2, 22/09/2026):
 *  - `[VERIFICAR]`: confere no ML antes de recriar (anti-duplicata);
 *  - terminal por dado/conta vai para a linha do candidato com o marcador;
 *  - configurações da criação (Premium, frete grátis…) voltam do placeholder;
 *  - multi-conta: a falha de uma conta não toca a outra.
 * Harness de tests/listing-retry-delegates-ml.spec.ts.
 */

vi.mock("../app/marketplaces/repositories/listing.repository", () => ({
  ListingRepository: {
    findPendingRetries: vi.fn(),
    claimRetryCandidate: vi.fn(),
    incrementRetryAttempts: vi.fn(),
    restoreCronClaimStatus: vi.fn(async () => undefined),
    updateListing: vi.fn(),
    findByProductAndAccount: vi.fn(),
    findRetryStateById: vi.fn(),
    findByExternalListingId: vi.fn(),
    findLinkByExternalListingId: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/ml-api.service", () => ({
  MLApiService: {
    getSellerItemIds: vi.fn(),
    createItem: vi.fn(),
    findItemsBySellerSku: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/usecases/listing.usercase", () => ({
  ListingUseCase: {
    createMLListing: vi.fn(),
    createShopeeListing: vi.fn(),
    completeAdoptedMLListing: vi.fn(async () => undefined),
  },
}));

vi.mock("../app/marketplaces/services/ml-oauth.service", () => ({
  MLOAuthService: { refreshAccessTokenForAccount: vi.fn() },
}));

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: { updateTokens: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn(), log: vi.fn() },
}));

const CRIADO = new Date("2026-09-22T19:34:12.000Z");

const conta = (id: string, nome: string) => ({
  id,
  accountName: nome,
  accessToken: `tok-${id}`,
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3600_000),
  platform: "MERCADO_LIVRE",
  userId: "user-1",
  externalUserId: `seller-${id}`,
});

const candidato = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "pl-1",
    externalListingId: "PENDING_1",
    status: "error",
    retryAttempts: 1,
    retryEnabled: true,
    nextRetryAt: new Date(Date.now() - 1000),
    createdAt: CRIADO,
    requestedCategoryId: "MLB192571",
    productId: "prod-1",
    marketplaceAccountId: "acct-1",
    lastError: null,
    product: {
      id: "prod-1",
      sku: "3398",
      name: "Sensor MAF",
      price: new Prisma.Decimal("199.00"),
      stock: 1,
    },
    marketplaceAccount: conta("acct-1", "XAXIMAUTOLATAS"),
    ...overrides,
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (ListingRepository.claimRetryCandidate as any).mockResolvedValue(true);
  (MLApiService.getSellerItemIds as any).mockResolvedValue([]);
  (ListingRepository.findRetryStateById as any).mockResolvedValue({
    id: "pl-1",
    retryEnabled: true,
  });
  (ListingRepository.findByExternalListingId as any).mockResolvedValue(null);
  (ListingRepository.findLinkByExternalListingId as any).mockResolvedValue(null);
});

describe("[VERIFICAR] — confere no ML antes de recriar", () => {
  it("item criado depois do placeholder ⇒ ADOTA (vincula o id), NÃO cria outro", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] O Mercado Livre não respondeu a tempo." }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      {
        id: "MLB7686581550",
        status: "active",
        dateCreated: "2026-09-22T19:34:40.000Z",
        permalink: "https://ml/x",
      },
    ]);

    await ListingRetryService.runOnce();

    expect(MLApiService.findItemsBySellerSku).toHaveBeenCalledWith(
      "tok-acct-1",
      "seller-acct-1",
      "3398",
    );
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-1",
      expect.objectContaining({
        externalListingId: "MLB7686581550",
        status: "active",
        permalink: "https://ml/x",
        lastError: null,
        retryEnabled: false,
      }),
    );
  });

  it("só existe anúncio ANTIGO da peça ⇒ não adota; segue para a criação", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      { id: "MLB_OLD", status: "closed", dateCreated: "2026-07-01T00:00:00.000Z" },
    ]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: true,
      externalListingId: "MLB_NEW",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).toHaveBeenCalledTimes(1);
    expect(ListingRepository.updateListing).not.toHaveBeenCalledWith(
      "pl-1",
      expect.objectContaining({ externalListingId: "MLB_OLD" }),
    );
  });

  it("busca no ML falhou ⇒ NÃO cria às cegas; reagenda mantendo o marcador", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockRejectedValue(
      new Error("ECONNRESET"),
    );

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError.startsWith("[VERIFICAR]")).toBe(true);
    expect(dados.retryEnabled).toBe(true);
  });

  it("item achado já vinculado em OUTRA linha ⇒ encerra o placeholder, sem duplicar vínculo", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      { id: "MLB_X", status: "active", dateCreated: "2026-09-22T19:35:00.000Z" },
    ]);
    (ListingRepository.findLinkByExternalListingId as any).mockResolvedValue({
      id: "outra-linha",
      productId: "prod-1",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    const dados = (ListingRepository.updateListing as any).mock.calls[0][1];
    expect(dados.lastError).toMatch(/^\[TERMINAL\].*MLB_X/);
    expect(dados.retryEnabled).toBe(false);
  });

  it("item com o mesmo SKU mas OUTRO título ⇒ ambíguo: nem adota nem recria", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      {
        id: "MLB_OUTRO",
        status: "active",
        title: "Farol Dianteiro Gol G5",
        dateCreated: "2026-09-22T19:35:00.000Z",
      },
    ]);

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    const dados = (ListingRepository.updateListing as any).mock.calls[0][1];
    expect(dados.lastError).toMatch(/^\[TERMINAL\] Há um anúncio .*MLB_OUTRO/);
    expect(dados.retryEnabled).toBe(false);
    expect(dados).not.toHaveProperty("externalListingId");
  });

  it("título equivalente (o ML anexa atributos ao título do item UP) ⇒ adota", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      {
        id: "MLB_UP",
        status: "active",
        title: "Sensor MAF Dianteiro Original",
        dateCreated: "2026-09-22T19:35:00.000Z",
      },
    ]);

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-1",
      expect.objectContaining({ externalListingId: "MLB_UP" }),
    );
  });

  it("item ENCERRADO criado na janela (linha reaproveitada) ⇒ não adota; cria", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      { id: "MLB_FECHADO", status: "closed", dateCreated: "2026-09-22T19:35:00.000Z" },
    ]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).toHaveBeenCalledTimes(1);
    expect(ListingRepository.updateListing).not.toHaveBeenCalledWith(
      "pl-1",
      expect.objectContaining({ externalListingId: "MLB_FECHADO" }),
    );
  });

  it("campo de SKU do item é OUTRO código ⇒ não é deste produto; cria", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      {
        id: "MLB_Z",
        status: "active",
        sellerCustomField: "9999",
        dateCreated: "2026-09-22T19:35:00.000Z",
      },
    ]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).toHaveBeenCalledTimes(1);
  });

  it("item vinculado a OUTRO produto ⇒ ambíguo, nada é criado nem vinculado", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      { id: "MLB_Y", status: "active", dateCreated: "2026-09-22T19:35:00.000Z" },
    ]);
    (ListingRepository.findLinkByExternalListingId as any).mockResolvedValue({
      id: "linha-de-outro",
      productId: "prod-OUTRO",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    const dados = (ListingRepository.updateListing as any).mock.calls[0][1];
    expect(dados.lastError).toMatch(/vinculado a outro produto/);
  });

  it("busca falhou numa linha SEM marcador ⇒ ganha [VERIFICAR] (a próxima passada confere)", async () => {
    (MLApiService.findItemsBySellerSku as any).mockRejectedValue(new Error("503"));
    const r = await ListingRetryService.reconcileBeforeRecreate(
      candidato({ lastError: "Erro antigo sem marcador" }),
      conta("acct-1", "X"),
    );
    expect(r).toBe("search_failed");
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError).toBe("[VERIFICAR] Erro antigo sem marcador");
  });

  it("pelo BOTÃO (interactive) a busca que falha não grava nada: nem tentativa, nem marcador, nem agenda", async () => {
    (MLApiService.findItemsBySellerSku as any).mockRejectedValue(new Error("503"));
    const r = await ListingRetryService.reconcileBeforeRecreate(
      candidato({ lastError: "[TERMINAL][CORRIGIVEL] GTIN inválido", retryAttempts: 4 }),
      conta("acct-1", "X"),
      { interactive: true },
    );
    expect(r).toBe("search_failed");
    expect(ListingRepository.incrementRetryAttempts).not.toHaveBeenCalled();
    expect(ListingRepository.updateListing).not.toHaveBeenCalled();
  });

  it("falha do capability check NÃO apaga o [VERIFICAR] da linha", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] timeout anterior" }),
    ]);
    (MLApiService.getSellerItemIds as any).mockRejectedValue(new Error("rede caiu"));

    await ListingRetryService.runOnce();

    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError).toBe("[VERIFICAR] rede caiu");
  });

  it("sem marcador ⇒ não consulta o ML (caminho de sempre)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });
    await ListingRetryService.runOnce();
    expect(MLApiService.findItemsBySellerSku).not.toHaveBeenCalled();
    expect(ListingUseCase.createMLListing).toHaveBeenCalledTimes(1);
  });
});

describe("marcadores devolvidos pelo createMLListing", () => {
  it("[TERMINAL][CORRIGIVEL] ⇒ grava no candidato com o marcador e desliga o retry", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      error: 'O campo "Número de registro/certificação INMETRO" …',
      errorKind: "VALIDATION",
      lastErrorMarker: "[TERMINAL][CORRIGIVEL]",
    });

    await ListingRetryService.runOnce();

    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError).toMatch(/^\[TERMINAL\]\[CORRIGIVEL\] O campo/);
    expect(dados.retryEnabled).toBe(false);
    expect(dados.nextRetryAt).toBeNull();
  });

  it("[VERIFICAR] ⇒ backoff normal, marcador preservado para a próxima passada", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      error: "O Mercado Livre não respondeu a tempo.",
      errorKind: "UNKNOWN",
      lastErrorMarker: "[VERIFICAR]",
    });

    await ListingRetryService.runOnce();

    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError.startsWith("[VERIFICAR] ")).toBe(true);
    expect(dados.retryEnabled).toBe(true);
  });
});

describe("configurações da criação voltam do placeholder", () => {
  it("Premium + frete grátis guardados na linha vão para o createMLListing (sem a condição)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({
        listingType: "gold_premium",
        freeShipping: true,
        shippingMode: "not_specified",
        localPickup: true,
        itemCondition: "new",
      }),
    ]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });

    await ListingRetryService.runOnce();

    const args = (ListingUseCase.createMLListing as any).mock.calls[0];
    expect(args.slice(0, 4)).toEqual(["user-1", "prod-1", "MLB192571", "acct-1"]);
    expect(args[4]).toEqual({
      listingType: "gold_premium",
      freeShipping: true,
      shippingMode: "not_specified",
      localPickup: true,
    });
    expect(args[4]).not.toHaveProperty("itemCondition");
  });
});

describe("multi-conta", () => {
  it("conta A publica, conta B falha: cada linha fica com o próprio estado", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ id: "pl-A", marketplaceAccountId: "acct-A", marketplaceAccount: conta("acct-A", "A") }),
      candidato({ id: "pl-B", marketplaceAccountId: "acct-B", marketplaceAccount: conta("acct-B", "B") }),
    ]);
    (ListingRepository.findRetryStateById as any).mockImplementation(async (id: string) => ({
      id,
      retryEnabled: true,
    }));
    (ListingUseCase.createMLListing as any).mockImplementation(
      async (_u: string, _p: string, _c: string, accountId: string) =>
        accountId === "acct-A"
          ? { success: true, externalListingId: "MLB_A" }
          : {
              success: false,
              error: "O Mercado Livre ficou indisponível.",
              errorKind: "TRANSIENT",
              lastErrorMarker: "[VERIFICAR]",
            },
    );

    await ListingRetryService.runOnce();

    const escritas = (ListingRepository.incrementRetryAttempts as any).mock.calls;
    expect(escritas.map((c: any[]) => c[0])).toEqual(["pl-B"]);
    expect(escritas[0][1].retryEnabled).toBe(true);
  });
});

describe("rodada 2 da revisão (23/09): estados que ficavam errados", () => {
  it("capability check falha na ÚLTIMA tentativa ⇒ retry desligado SEM horário (não vira 'Publicando agora')", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ retryAttempts: 4 }),
    ]);
    (MLApiService.getSellerItemIds as any).mockRejectedValue(new Error("rede caiu"));
    await ListingRetryService.runOnce();
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.retryEnabled).toBe(false);
    expect(dados.nextRetryAt).toBeNull();
  });

  it("capability check falha antes do teto ⇒ reagenda como sempre", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ retryAttempts: 1 }),
    ]);
    (MLApiService.getSellerItemIds as any).mockRejectedValue(new Error("rede caiu"));
    await ListingRetryService.runOnce();
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.retryEnabled).toBe(true);
    expect(dados.nextRetryAt).toBeInstanceOf(Date);
  });

  it("candidato com id REAL e o bloqueio gravado noutro placeholder ⇒ só sai da fila, SEM o marcador", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ externalListingId: "MLB_ENCERRADO", lastError: "Erro anterior" }),
    ]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      listingId: "pl-novo-placeholder",
      error: "O campo GTIN …",
      errorKind: "VALIDATION",
      lastErrorMarker: "[TERMINAL][CORRIGIVEL]",
    });
    await ListingRetryService.runOnce();
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados).toEqual({ retryEnabled: false, nextRetryAt: null });
  });

  it("candidato PENDING_ com o bloqueio ⇒ continua recebendo o marcador (re-arme e botão o enxergam)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      listingId: "outra-linha",
      error: "O campo GTIN …",
      errorKind: "VALIDATION",
      lastErrorMarker: "[TERMINAL][CORRIGIVEL]",
    });
    await ListingRetryService.runOnce();
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError).toMatch(/^\[TERMINAL\]\[CORRIGIVEL\]/);
  });
});

describe("rodada 3 da revisão (23/09): a reserva do cron", () => {
  const LEASE = new Date("2026-09-23T12:10:00.000Z");

  it("o cron passa a PRÓPRIA reserva ao createMLListing (só ele reaproveita a linha com retry ligado)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(LEASE);
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });
    await ListingRetryService.runOnce();
    const args = (ListingUseCase.createMLListing as any).mock.calls[0];
    expect(args[8]).toEqual({ reservation: { listingId: "pl-1", at: LEASE } });
  });

  it("'em andamento' (outra publicação do par) ⇒ volta à fila SEM gastar tentativa e SEM trocar o erro", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "Erro anterior da linha" }),
    ]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(LEASE);
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      skipped: true,
      code: "PUBLICATION_IN_PROGRESS",
      error: "Esta publicação já está em andamento.",
    });
    await ListingRetryService.runOnce();
    const [id, dados, opts] = (ListingRepository.incrementRetryAttempts as any).mock.calls[0];
    expect(id).toBe("pl-1");
    expect(Object.keys(dados)).toEqual(["nextRetryAt"]);
    expect(dados.nextRetryAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ increment: false });
  });
});

describe("rodada 4 da revisão (23/09): o claim do cron no ML marca 'pending' e devolve no fim", () => {
  it("candidato do ML ⇒ claim com markPublishing e status devolvido no fim, mesmo quando a criação sai sem gravar", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(
      new Date("2026-09-23T12:10:00.000Z"),
    );
    (ListingUseCase.createMLListing as any).mockResolvedValue({
      success: false,
      skipped: true,
      code: "PUBLICATION_IN_PROGRESS",
      error: "em andamento",
    });
    await ListingRetryService.runOnce();
    expect((ListingRepository.claimRetryCandidate as any).mock.calls[0][2]).toEqual({
      markPublishing: true,
    });
    expect(ListingRepository.restoreCronClaimStatus).toHaveBeenCalledWith("pl-1", "error");
  });

  it("claim perdido ⇒ nada a devolver", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([candidato()]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(null);
    await ListingRetryService.runOnce();
    expect(ListingRepository.restoreCronClaimStatus).not.toHaveBeenCalled();
  });
});

describe("rodada 5 da revisão (23/09): a marca 'pending' só em placeholder", () => {
  it("candidato com id REAL (linha viva ou encerrada na fila) ⇒ claim SEM a marca (as guardas de anúncio vivo continuam vendo a linha)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ externalListingId: "MLB123", status: "active" }),
    ]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(
      new Date("2026-09-23T12:10:00.000Z"),
    );
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });
    await ListingRetryService.runOnce();
    expect((ListingRepository.claimRetryCandidate as any).mock.calls[0][2]).toEqual({});
    expect(ListingRepository.restoreCronClaimStatus).not.toHaveBeenCalled();
  });

  it("devolve o status ORIGINAL da linha (não um 'error' fixo)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ status: "error" }),
    ]);
    (ListingRepository.claimRetryCandidate as any).mockResolvedValue(
      new Date("2026-09-23T12:10:00.000Z"),
    );
    (ListingUseCase.createMLListing as any).mockResolvedValue({ success: true });
    await ListingRetryService.runOnce();
    expect(ListingRepository.restoreCronClaimStatus).toHaveBeenCalledWith("pl-1", "error");
  });
});

describe("anúncio ADOTADO é completado (compatibilidade + estoque)", () => {
  const ITEM = {
    id: "MLB7686581550",
    status: "active",
    dateCreated: "2026-09-22T19:34:40.000Z",
    permalink: "https://ml/x",
  };

  it("cron adota ⇒ completa o anúncio (e espera, o lease cobre)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] O Mercado Livre não respondeu a tempo." }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);
    await ListingRetryService.runOnce();
    expect(ListingUseCase.completeAdoptedMLListing).toHaveBeenCalledWith({
      accessToken: "tok-acct-1",
      itemId: "MLB7686581550",
      listingId: "pl-1",
      productId: "prod-1",
    });
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("botão (interactive) adota ⇒ completa em segundo plano; a resposta não espera", async () => {
    let soltar: () => void = () => {};
    (ListingUseCase.completeAdoptedMLListing as any).mockImplementation(
      () => new Promise<void>((r) => (soltar = r)),
    );
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);
    const r = await ListingRetryService.reconcileBeforeRecreate(
      candidato(),
      conta("acct-1", "X"),
      { interactive: true },
    );
    // A resposta saiu com a complementação ainda presa (não esperou por ela).
    expect(r).toBe("adopted");
    await vi.waitFor(() =>
      expect(ListingUseCase.completeAdoptedMLListing).toHaveBeenCalled(),
    );
    soltar();
  });

  it("falha ao completar não desfaz a adoção", async () => {
    (ListingUseCase.completeAdoptedMLListing as any).mockRejectedValue(new Error("x"));
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);
    const r = await ListingRetryService.reconcileBeforeRecreate(candidato(), conta("acct-1", "X"));
    expect(r).toBe("adopted");
  });

  it("não encontrado / ambíguo ⇒ nada a completar", async () => {
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([]);
    await ListingRetryService.reconcileBeforeRecreate(candidato(), conta("acct-1", "X"));
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([
      { ...ITEM, title: "Outra peça totalmente diferente" },
    ]);
    await ListingRetryService.reconcileBeforeRecreate(candidato(), conta("acct-1", "X"));
    expect(ListingUseCase.completeAdoptedMLListing).not.toHaveBeenCalled();
  });
});

describe("revisão de fechamento (23/09): conferência antes da guarda de estoque; vínculo do mesmo produto", () => {
  const ITEM = {
    id: "MLB_X",
    status: "active",
    dateCreated: "2026-09-22T19:35:00.000Z",
    permalink: "https://ml/x",
  };
  const semEstoque = (lastError: string | null) =>
    candidato({ lastError, product: { ...candidato().product, stock: 0 } });
  const gravouSemEstoque = () =>
    (ListingRepository.incrementRetryAttempts as any).mock.calls.some(
      (c: any[]) => /^\[TERMINAL\] Produto sem estoque/.test(String(c[1]?.lastError)),
    );

  it("[VERIFICAR] com estoque 0 (a peça vendeu depois do POST perdido) ⇒ confere ANTES: adota e completa; nada de terminal 'sem estoque'", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      semEstoque("[VERIFICAR] O Mercado Livre não respondeu a tempo."),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);

    await ListingRetryService.runOnce();

    expect(MLApiService.findItemsBySellerSku).toHaveBeenCalled();
    expect(ListingRepository.updateListing).toHaveBeenCalledWith(
      "pl-1",
      expect.objectContaining({ externalListingId: "MLB_X" }),
    );
    // o job de estoque da adoção é quem zera/pausa o item no ML
    expect(ListingUseCase.completeAdoptedMLListing).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "MLB_X", listingId: "pl-1", productId: "prod-1" }),
    );
    expect(gravouSemEstoque()).toBe(false);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("[VERIFICAR] com estoque 0 e nada no ML ⇒ aí sim a guarda marca terminal 'sem estoque'", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      semEstoque("[VERIFICAR] x"),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([]);

    await ListingRetryService.runOnce();

    expect(MLApiService.findItemsBySellerSku).toHaveBeenCalled();
    expect(gravouSemEstoque()).toBe(true);
    expect(ListingUseCase.createMLListing).not.toHaveBeenCalled();
  });

  it("[VERIFICAR] com estoque 0 e a busca falhou ⇒ reagenda COM o marcador (não vira terminal às cegas)", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      semEstoque("[VERIFICAR] x"),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockRejectedValue(new Error("ECONNRESET"));

    await ListingRetryService.runOnce();

    expect(gravouSemEstoque()).toBe(false);
    const dados = (ListingRepository.incrementRetryAttempts as any).mock.calls[0][1];
    expect(dados.lastError.startsWith("[VERIFICAR]")).toBe(true);
  });

  it("sem [VERIFICAR] e estoque 0 ⇒ guarda como antes, sem consultar o ML", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      semEstoque("Instabilidade no Mercado Livre (503)."),
    ]);

    await ListingRetryService.runOnce();

    expect(MLApiService.findItemsBySellerSku).not.toHaveBeenCalled();
    expect(gravouSemEstoque()).toBe(true);
  });

  it("item já vinculado em OUTRA linha do MESMO produto (webhook/autodetect chegou antes) ⇒ completa ESSA linha", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);
    (ListingRepository.findLinkByExternalListingId as any).mockResolvedValue({
      id: "pl-auto",
      productId: "prod-1",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.completeAdoptedMLListing).toHaveBeenCalledWith({
      accessToken: "tok-acct-1",
      itemId: "MLB_X",
      listingId: "pl-auto",
      productId: "prod-1",
    });
    // o pendente é encerrado apontando para o vínculo, como antes
    const dados = (ListingRepository.updateListing as any).mock.calls[0];
    expect(dados[0]).toBe("pl-1");
    expect(dados[1].lastError).toMatch(/^\[TERMINAL\].*MLB_X/);
  });

  it("pelo BOTÃO sobre pendente SEM [VERIFICAR] (anúncio publicado por fora, vinculado pelo autodetect) ⇒ encerra o pendente, mas não mexe no anúncio", async () => {
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);
    (ListingRepository.findLinkByExternalListingId as any).mockResolvedValue({
      id: "pl-por-fora",
      productId: "prod-1",
    });
    const semMarcador = () => candidato({ lastError: "[TERMINAL][CORRIGIVEL] Falta o lado" });
    // Caminho aguardado (determinístico)...
    expect(
      await ListingRetryService.reconcileBeforeRecreate(semMarcador(), conta("acct-1", "X")),
    ).toBe("adopted");
    // ...e o do botão, que completa em segundo plano: esvazia a fila antes de
    // afirmar que NÃO completou (sem isso a asserção passava cedo demais).
    expect(
      await ListingRetryService.reconcileBeforeRecreate(semMarcador(), conta("acct-1", "X"), {
        interactive: true,
      }),
    ).toBe("adopted");
    await new Promise((r) => setTimeout(r, 50));
    expect(ListingUseCase.completeAdoptedMLListing).not.toHaveBeenCalled();
    const dados = (ListingRepository.updateListing as any).mock.calls[0];
    expect(dados[0]).toBe("pl-1");
    expect(dados[1].lastError).toMatch(/^\[TERMINAL\]/);
  });

  it("item vinculado a OUTRO produto ⇒ não completa nada", async () => {
    (ListingRepository.findPendingRetries as any).mockResolvedValue([
      candidato({ lastError: "[VERIFICAR] x" }),
    ]);
    (MLApiService.findItemsBySellerSku as any).mockResolvedValue([ITEM]);
    (ListingRepository.findLinkByExternalListingId as any).mockResolvedValue({
      id: "pl-outro",
      productId: "prod-OUTRO",
    });

    await ListingRetryService.runOnce();

    expect(ListingUseCase.completeAdoptedMLListing).not.toHaveBeenCalled();
  });
});
