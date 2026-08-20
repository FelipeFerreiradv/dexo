// Conexão de conta Shopee: o rótulo gravado é o NOME da loja.
//
// Antes, a Shopee era a única plataforma que gravava um identificador onde as
// outras gravam um nome (`Shopee Shop 1547916297`). Como ~20 telas leem
// `MarketplaceAccount.accountName`, o operador via o número em toda a
// aplicação.
//
// O que este spec trava, e que é a parte perigosa da mudança:
//
//   DESCOBRIR O NOME É CORTESIA; CONECTAR É O REQUISITO.
//
// `get_shop_info` pode falhar — token recém-emitido que a Shopee ainda não
// propagou, rede, IP fora da whitelist (a Shopee exige whitelist, e o servidor
// de produção é o único endereço liberado). Se essa falha derrubasse o
// callback, a mudança teria trocado um rótulo feio por uma conexão que não
// completa. Por isso o caso de falha vale mais que o caso feliz.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findAllShopeeByShopId: vi.fn(),
    findAllByExternalUserId: vi.fn(),
    findShopeeByUserAndShopId: vi.fn(),
    createAccount: vi.fn(),
    updateTokens: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: {
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

import { MarketplaceUseCase } from "../app/marketplaces/usecases/marketplace.usercase";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ShopeeOAuthService } from "../app/marketplaces/services/shopee-oauth.service";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";

const SHOP_ID = 1547916297; // uma das contas reais de produção

/** Deixa o callback chegar ao ramo "criar nova conta". */
function prepararConexaoNova() {
  vi.spyOn(ShopeeOAuthService, "exchangeCodeForTokens").mockResolvedValue({
    access_token: "tok",
    refresh_token: "ref",
    expire_in: 3600,
    merchant_id: 555,
  } as any);
  vi.mocked(MarketplaceRepository.findAllShopeeByShopId).mockResolvedValue(
    [] as any,
  );
  vi.mocked(MarketplaceRepository.findAllByExternalUserId).mockResolvedValue(
    [] as any,
  );
  vi.mocked(MarketplaceRepository.findShopeeByUserAndShopId).mockResolvedValue(
    null as any,
  );
  vi.mocked(MarketplaceRepository.createAccount).mockImplementation(
    async (d: any) => ({ id: "acc-novo", ...d }) as any,
  );
}

/** O `accountName` com que a conta foi efetivamente criada. */
function nomeGravado(): string {
  const chamada = vi.mocked(MarketplaceRepository.createAccount).mock.calls[0];
  return (chamada[0] as any).accountName;
}

beforeEach(() => {
  vi.clearAllMocks();
  prepararConexaoNova();
});

describe("handleShopeeOAuthCallback — nome da loja no lugar do Shopee ID", () => {
  it("grava o nome da loja com a marca na frente", async () => {
    vi.spyOn(ShopeeApiService, "getShopInfo").mockResolvedValue({
      shop_name: "JOTABE AUTOPECAS",
    } as any);

    await MarketplaceUseCase.handleShopeeOAuthCallback({
      code: "c",
      shopId: SHOP_ID,
      userId: "user-1",
    });

    expect(nomeGravado()).toBe("SHOPEE JOTABE AUTOPECAS");
    expect(nomeGravado()).not.toContain(String(SHOP_ID));
  });

  it("desembrulha o payload quando a Shopee responde dentro de `response`", async () => {
    vi.spyOn(ShopeeApiService, "getShopInfo").mockResolvedValue({
      response: { shop_name: "Xaxim Pecas" },
    } as any);

    await MarketplaceUseCase.handleShopeeOAuthCallback({
      code: "c",
      shopId: SHOP_ID,
      userId: "user-1",
    });

    expect(nomeGravado()).toBe("SHOPEE Xaxim Pecas");
  });

  it("CRÍTICO: get_shop_info falha ⇒ a conta É criada, com o rótulo histórico", async () => {
    // O caso que importa: perder o nome é recuperável (a listagem de contas
    // cura depois); perder a conta que o usuário acabou de autorizar, não.
    vi.spyOn(ShopeeApiService, "getShopInfo").mockRejectedValue(
      new Error("IP not in whitelist"),
    );

    await expect(
      MarketplaceUseCase.handleShopeeOAuthCallback({
        code: "c",
        shopId: SHOP_ID,
        userId: "user-1",
      }),
    ).resolves.toBeTruthy();

    expect(MarketplaceRepository.createAccount).toHaveBeenCalledTimes(1);
    expect(nomeGravado()).toBe(`Shopee Shop ${SHOP_ID}`);
  });

  it("get_shop_info sem nome ⇒ mesmo fallback, conexão conclui", async () => {
    vi.spyOn(ShopeeApiService, "getShopInfo").mockResolvedValue({} as any);

    await MarketplaceUseCase.handleShopeeOAuthCallback({
      code: "c",
      shopId: SHOP_ID,
      userId: "user-1",
    });

    expect(nomeGravado()).toBe(`Shopee Shop ${SHOP_ID}`);
  });

  it("o resto do payload da conta continua igual (nada além do rótulo mudou)", async () => {
    vi.spyOn(ShopeeApiService, "getShopInfo").mockResolvedValue({
      shop_name: "Loja X",
    } as any);

    await MarketplaceUseCase.handleShopeeOAuthCallback({
      code: "c",
      shopId: SHOP_ID,
      userId: "user-1",
    });

    const payload = vi.mocked(MarketplaceRepository.createAccount).mock
      .calls[0][0] as any;
    expect(payload.userId).toBe("user-1");
    expect(payload.platform).toBe("SHOPEE");
    expect(payload.shopId).toBe(SHOP_ID);
    expect(payload.accessToken).toBe("tok");
    expect(payload.refreshToken).toBe("ref");
    expect(payload.externalUserId).toBe("555");
    // Baseline "só novos" do import de anúncios: não pode ter sumido.
    expect(payload.autoImportListingsSince).toBeInstanceOf(Date);
  });
});
