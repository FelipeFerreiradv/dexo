// GET /marketplace/shopee/accounts — cache do get_shop_info e auto-cura do nome.
//
// Por que este spec existe: esta rota é consumida por CINCO telas (conexão,
// anúncios, sincronização, criação de produto e publicação em massa) e, para
// cada conta ativa do tenant, chamava a API da Shopee. Medido em produção
// (20/08/2026): 393 GETs em 24h × 1,39 conta ativa por tenant ≈ 546 chamadas
// externas por dia — a maior parte para desenhar seletores que só usam `id` e
// `accountName`.
//
// O que se trava aqui:
//   1. a segunda leitura da MESMA conta não bate na Shopee (o cache existe);
//   2. FALHA NÃO É CACHEADA — senão um 403 de IP prenderia a conta a um erro
//      por 10 minutos;
//   3. a auto-cura do nome grava UMA vez e depois vira no-op (idempotente);
//   4. contas de tenants diferentes não se misturam no cache.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";

vi.mock("../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "u1", dataOwnerId: "owner-1" };
  },
}));

vi.mock("../app/marketplaces/repositories/marketplace.repository", () => ({
  MarketplaceRepository: {
    findAllByUserIdAndPlatform: vi.fn(),
    renameShopeeAccountIfUnchanged: vi.fn(),
  },
}));

vi.mock("../app/marketplaces/services/shopee-api.service", () => ({
  ShopeeApiService: { getShopInfo: vi.fn() },
}));

import { marketplaceRoutes } from "../app/routes/marketplace.routes";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";

// Espelha a LINHA do banco, credenciais inclusive: e o que o `findMany` sem
// `select` devolve hoje, e e o que a resposta NAO pode carregar adiante.
const CONTA = {
  id: "acc-1",
  userId: "owner-1",
  platform: "SHOPEE",
  accountName: "Shopee Shop 1547916297",
  shopId: 1547916297,
  status: "ACTIVE",
  externalUserId: "555",
  accessToken: "TOKEN-SECRETO-DA-LOJA",
  refreshToken: "REFRESH-SECRETO-DA-LOJA",
  appClientId: "client-id-do-app",
  appClientSecret: "SEGREDO-DO-APP-OAUTH",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

/** Todo campo que jamais pode sair desta rota. */
const SEGREDOS = [
  "accessToken",
  "refreshToken",
  "appClientSecret",
  "appClientId",
] as const;

function conferirQueNaoVazou(corpo: any) {
  const bruto = JSON.stringify(corpo);
  for (const conta of corpo.accounts) {
    for (const campo of SEGREDOS) {
      expect(conta).not.toHaveProperty(campo);
    }
  }
  // Rede de seguranca: nem o VALOR pode aparecer, ainda que sob outra chave.
  expect(bruto).not.toContain("TOKEN-SECRETO-DA-LOJA");
  expect(bruto).not.toContain("REFRESH-SECRETO-DA-LOJA");
  expect(bruto).not.toContain("SEGREDO-DO-APP-OAUTH");
}

async function subirApp() {
  const app = fastify();
  await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  await app.ready();
  return app;
}

function get(app: any) {
  return app.inject({ method: "GET", url: "/marketplace/shopee/accounts" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(MarketplaceRepository.findAllByUserIdAndPlatform).mockResolvedValue(
    [{ ...CONTA }] as any,
  );
  vi.mocked(
    MarketplaceRepository.renameShopeeAccountIfUnchanged,
  ).mockResolvedValue(1 as any);
  vi.mocked(ShopeeApiService.getShopInfo).mockResolvedValue({
    shop_name: "JOTABE AUTOPECAS",
    region: "BR",
    merchant_name: "jotabe",
  } as any);
});

describe("GET /shopee/accounts — egress", () => {
  it("duas leituras da mesma conta ⇒ UMA chamada à Shopee", async () => {
    const app = await subirApp();

    const r1 = await get(app);
    const r2 = await get(app);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // O ganho medido: a 2ª tela a abrir não paga chamada externa.
    expect(ShopeeApiService.getShopInfo).toHaveBeenCalledTimes(1);

    // E as duas respostas continuam completas — o cache não pode empobrecer
    // o corpo, senão a aba de Integrações perderia @merchant e região.
    for (const r of [r1, r2]) {
      const conta = r.json().accounts[0];
      expect(conta.shopName).toBe("JOTABE AUTOPECAS");
      expect(conta.region).toBe("BR");
      expect(conta.merchantName).toBe("jotabe");
    }

    await app.close();
  });

  it("FALHA não é cacheada — a requisição seguinte tenta de novo", async () => {
    // Sem isto, um 403 de IP fora da whitelist prenderia a conta a um erro
    // por 10 minutos inteiros.
    vi.mocked(ShopeeApiService.getShopInfo)
      .mockRejectedValueOnce(new Error("Shopee API 403: IP undeclared"))
      .mockResolvedValueOnce({ shop_name: "JOTABE AUTOPECAS" } as any);

    const app = await subirApp();

    const r1 = await get(app);
    expect(r1.statusCode).toBe(200); // a listagem não cai por causa disso
    expect(r1.json().accounts[0].shopName).toBeUndefined();

    const r2 = await get(app);
    expect(ShopeeApiService.getShopInfo).toHaveBeenCalledTimes(2);
    expect(r2.json().accounts[0].shopName).toBe("JOTABE AUTOPECAS");

    await app.close();
  });

  it("auto-cura grava UMA vez; a segunda leitura não escreve de novo", async () => {
    const app = await subirApp();

    await get(app);
    expect(
      MarketplaceRepository.renameShopeeAccountIfUnchanged,
    ).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(MarketplaceRepository.renameShopeeAccountIfUnchanged).mock
        .calls[0],
    ).toEqual(["acc-1", "Shopee Shop 1547916297", "SHOPEE JOTABE AUTOPECAS"]);

    // O banco agora devolve a conta já curada: nada mais a escrever.
    vi.mocked(
      MarketplaceRepository.findAllByUserIdAndPlatform,
    ).mockResolvedValue([
      { ...CONTA, accountName: "SHOPEE JOTABE AUTOPECAS" },
    ] as any);

    await get(app);
    expect(
      MarketplaceRepository.renameShopeeAccountIfUnchanged,
    ).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("nome já personalizado NUNCA é sobrescrito", async () => {
    vi.mocked(
      MarketplaceRepository.findAllByUserIdAndPlatform,
    ).mockResolvedValue([{ ...CONTA, accountName: "Loja do Ze" }] as any);

    const app = await subirApp();
    const r = await get(app);

    expect(
      MarketplaceRepository.renameShopeeAccountIfUnchanged,
    ).not.toHaveBeenCalled();
    expect(r.json().accounts[0].accountName).toBe("Loja do Ze");

    await app.close();
  });

  it("contas diferentes não compartilham entrada de cache", async () => {
    vi.mocked(
      MarketplaceRepository.findAllByUserIdAndPlatform,
    ).mockResolvedValue([
      { ...CONTA },
      { ...CONTA, id: "acc-2", shopId: 690138776 },
    ] as any);

    const app = await subirApp();
    await get(app);

    // Duas contas ⇒ duas chamadas; a chave é por conta, não global.
    expect(ShopeeApiService.getShopInfo).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("conta sem shopId/token não gera chamada externa nenhuma", async () => {
    vi.mocked(
      MarketplaceRepository.findAllByUserIdAndPlatform,
    ).mockResolvedValue([{ ...CONTA, shopId: null, accessToken: null }] as any);

    const app = await subirApp();
    const r = await get(app);

    expect(ShopeeApiService.getShopInfo).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(200);

    await app.close();
  });
});

// ── SEGURANÇA / EGRESS ───────────────────────────────────────────────────────
// A rota devolvia `{ ...acc }`: a linha inteira de MarketplaceAccount, com
// `accessToken`, `refreshToken` e `appClientSecret` dentro. Cinco telas
// consultam esta rota, então as credenciais da loja iam para o navegador em toda
// abertura — e nenhum dos cinco consumidores usa esses campos.
//
// Há TRÊS caminhos de saída, e o vazamento estava nos três. Um teste que
// cobrisse só o caminho feliz deixaria dois abertos.
describe("GET /shopee/accounts — credenciais não saem do servidor", () => {
  it("caminho normal: resposta sem token, refresh ou segredo do app", async () => {
    const app = await subirApp();
    const r = await get(app);

    expect(r.statusCode).toBe(200);
    conferirQueNaoVazou(r.json());

    await app.close();
  });

  it("caminho de FALHA do get_shop_info: idem", async () => {
    vi.mocked(ShopeeApiService.getShopInfo).mockRejectedValue(
      new Error("403 IP undeclared"),
    );

    const app = await subirApp();
    const r = await get(app);

    expect(r.statusCode).toBe(200);
    conferirQueNaoVazou(r.json());

    await app.close();
  });

  it("caminho da conta SEM token: idem", async () => {
    vi.mocked(
      MarketplaceRepository.findAllByUserIdAndPlatform,
    ).mockResolvedValue([{ ...CONTA, shopId: null, accessToken: null }] as any);

    const app = await subirApp();
    const r = await get(app);

    expect(r.statusCode).toBe(200);
    conferirQueNaoVazou(r.json());

    await app.close();
  });

  it("CONTRATO PRESERVADO: os campos que as cinco telas desenham continuam lá", async () => {
    // O outro lado da moeda. Cortar demais quebraria a aba de Integrações
    // (que mostra @merchant e região) tão silenciosamente quanto o vazamento.
    const app = await subirApp();
    const conta = (await get(app)).json().accounts[0];

    expect(conta.id).toBe("acc-1");
    expect(conta.accountName).toBe("SHOPEE JOTABE AUTOPECAS");
    expect(conta.status).toBe("ACTIVE");
    expect(conta.shopId).toBe(1547916297);
    expect(conta.externalUserId).toBe("555");
    expect(conta.shopName).toBe("JOTABE AUTOPECAS");
    expect(conta.region).toBe("BR");
    expect(conta.merchantName).toBe("jotabe");

    await app.close();
  });

  it("conta sem token ainda APARECE na lista (só sem os campos da Shopee)", async () => {
    vi.mocked(
      MarketplaceRepository.findAllByUserIdAndPlatform,
    ).mockResolvedValue([{ ...CONTA, shopId: null, accessToken: null }] as any);

    const app = await subirApp();
    const contas = (await get(app)).json().accounts;

    expect(contas).toHaveLength(1);
    expect(contas[0].id).toBe("acc-1");
    expect(contas[0].accountName).toBe("Shopee Shop 1547916297");

    await app.close();
  });
});
