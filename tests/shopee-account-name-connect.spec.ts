// Conexão de conta Shopee: o callback NÃO fala com a Shopee para batizar a conta.
//
// A conta nasce com o rótulo genérico `Shopee Shop <id>`, e quem o troca pelo
// nome real da loja é a auto-cura dentro de `GET /marketplace/shopee/accounts`.
//
// POR QUE O NOME NÃO É RESOLVIDO AQUI:
//
// Perguntar `get_shop_info` durante o callback punha uma chamada externa de até
// 30 segundos ENTRE queimar o `code` (que é de uso único) e gravar a conta —
// no trecho mais frágil do fluxo inteiro. E sem ganho: o callback redireciona
// para a aba de Integrações, que ao receber `SHOPEE_OAUTH_SUCCESS` chama
// `GET /shopee/accounts`, e é lá que a auto-cura mora. O nome aparece segundos
// depois, na mesma tela que o operador já está olhando.
//
// O ELO FRÁGIL QUE ESTE SPEC PROTEGE:
//
// a auto-cura só age sobre o rótulo que `isGenericShopeeAccountName` reconhece.
// Se este caminho gravar qualquer outro formato — um template literal escrito à
// mão que ganhe um hífen, um espaço a mais —, a conta nasce com um nome que a
// auto-cura considera "personalizado" e NUNCA mais troca. Silenciosamente.
// Por isso o caso decisivo abaixo não compara com uma string: ele pergunta à
// própria função de reconhecimento.

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
import {
  isGenericShopeeAccountName,
  nextShopeeAccountName,
} from "../app/marketplaces/lib/shopee-account-label";

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

function conectar() {
  return MarketplaceUseCase.handleShopeeOAuthCallback({
    code: "c",
    shopId: SHOP_ID,
    userId: "user-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prepararConexaoNova();
});

describe("handleShopeeOAuthCallback — conectar não depende da API da Shopee", () => {
  it("CRÍTICO: nenhuma chamada a get_shop_info durante o callback", async () => {
    // A invariante da mudança. Se alguém reintroduzir a consulta aqui, o
    // callback volta a poder esperar até 30s com o `code` já queimado.
    const espiao = vi.spyOn(ShopeeApiService, "getShopInfo");

    await conectar();

    expect(espiao).not.toHaveBeenCalled();
    expect(MarketplaceRepository.createAccount).toHaveBeenCalledTimes(1);
  });

  it("a Shopee pode estar FORA DO AR — a conta é criada do mesmo jeito", async () => {
    // Controle: mesmo que a API estivesse quebrada, nada muda, porque este
    // caminho não a consulta.
    vi.spyOn(ShopeeApiService, "getShopInfo").mockRejectedValue(
      new Error("IP not in whitelist"),
    );

    await expect(conectar()).resolves.toBeTruthy();
    expect(nomeGravado()).toBe(`Shopee Shop ${SHOP_ID}`);
  });

  it("DECISIVO: o rótulo gravado é o que a auto-cura reconhece como genérico", async () => {
    // Não compara com uma string à mão de propósito: pergunta à própria função
    // que a auto-cura usa. É este acoplamento que mantém o rename funcionando —
    // e é ele que quebraria em silêncio se os formatos divergissem.
    await conectar();

    expect(isGenericShopeeAccountName(nomeGravado())).toBe(true);
  });

  it("DECISIVO: a auto-cura aceitaria trocar este rótulo pelo nome real", async () => {
    // Fecha o ciclo: o rótulo recém-gravado, submetido à regra do rename com um
    // `shop_name` de verdade, produz a troca. Se este caso cair, a conta nasce
    // com um nome que nunca mais muda.
    await conectar();

    expect(
      nextShopeeAccountName(nomeGravado(), "JOTABE AUTOPECAS", SHOP_ID),
    ).toBe("SHOPEE JOTABE AUTOPECAS");
  });

  it("e a auto-cura NÃO troca à toa quando a Shopee não devolve nome", async () => {
    // O outro lado: sem nome, o rótulo calculado é o mesmo que já está lá, e o
    // rename devolve `null` — nada de um UPDATE por ciclo para gravar o que já
    // estava gravado.
    await conectar();

    expect(nextShopeeAccountName(nomeGravado(), undefined, SHOP_ID)).toBeNull();
  });

  it("o resto do payload da conta continua igual (só o rótulo mudou de origem)", async () => {
    await conectar();

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
