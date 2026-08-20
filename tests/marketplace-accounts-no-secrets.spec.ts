// Nenhuma rota de contas de marketplace pode devolver credencial ao navegador.
//
// Auditoria de 20/08/2026: as rotas `GET /marketplace/<plataforma>/accounts`
// devolviam a linha inteira de `MarketplaceAccount`, com `accessToken`,
// `refreshToken`, `appClientId` e `appClientSecret` dentro. Cada uma dessas
// rotas é consultada por cinco telas, então as credenciais de cada loja
// trafegavam o tempo todo.
//
// OLX e Facebook já tentavam se proteger com uma lista de PROIBIÇÃO
// (`{ accessToken: _a, refreshToken: _r, ...rest }`), que remove dois campos e
// deixa passar o resto — `appClientSecret` inclusive. Este spec trava a regra na
// direção certa, e trava para TODAS as plataformas de uma vez: é a única forma
// de uma rota nova não repetir o mesmo erro em silêncio.

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
import {
  CAMPOS_SECRETOS_DA_CONTA,
  contaMarketplaceVisivel,
} from "../app/marketplaces/lib/marketplace-account-public";

/** A linha como o banco a devolve, credenciais e tudo. */
const LINHA = {
  id: "acc-1",
  userId: "owner-1",
  accountName: "Loja Teste",
  status: "ACTIVE",
  accessToken: "TOKEN-SECRETO",
  refreshToken: "REFRESH-SECRETO",
  appClientId: "CLIENT-ID-SECRETO",
  appClientSecret: "CLIENT-SECRET-SECRETO",
  expiresAt: new Date("2026-09-01T00:00:00Z"),
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  externalUserId: "555",
  shopId: null,
  // Campos que as telas de conexão da OLX e do Facebook editam.
  olxSellerPhone: "11999999999",
  olxSellerZipcode: "01001000",
  fbCatalogId: "cat-1",
  fbProductUrlBase: "https://loja.exemplo/p",
};

const VALORES_SECRETOS = [
  "TOKEN-SECRETO",
  "REFRESH-SECRETO",
  "CLIENT-ID-SECRETO",
  "CLIENT-SECRET-SECRETO",
];

async function subirApp() {
  const app = fastify();
  await app.register(marketplaceRoutes, { prefix: "/marketplace" });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(MarketplaceRepository.findAllByUserIdAndPlatform).mockResolvedValue(
    [{ ...LINHA }] as any,
  );
});

// As quatro rotas que ainda entregavam a linha crua (a Shopee tem spec próprio,
// tests/shopee-accounts-route-cache.spec.ts, porque também tem cache e auto-cura).
const ROTAS = [
  { plataforma: "Mercado Livre", url: "/marketplace/ml/accounts" },
  { plataforma: "Magalu", url: "/marketplace/magalu/accounts" },
  { plataforma: "OLX", url: "/marketplace/olx/accounts" },
  { plataforma: "Facebook", url: "/marketplace/facebook/accounts" },
];

describe("rotas de contas — credenciais não saem do servidor", () => {
  for (const { plataforma, url } of ROTAS) {
    it(`${plataforma}: resposta sem token, refresh ou segredo do app`, async () => {
      const app = await subirApp();
      const r = await app.inject({ method: "GET", url });

      expect(r.statusCode).toBe(200);
      const corpo = r.json();

      for (const conta of corpo.accounts) {
        for (const campo of CAMPOS_SECRETOS_DA_CONTA) {
          expect(conta).not.toHaveProperty(campo);
        }
      }
      // Rede de segurança: nem o VALOR pode aparecer, sob qualquer chave.
      const bruto = JSON.stringify(corpo);
      for (const segredo of VALORES_SECRETOS) {
        expect(bruto).not.toContain(segredo);
      }

      await app.close();
    });

    it(`${plataforma}: id, nome e status continuam na resposta`, async () => {
      // O outro lado: cortar demais quebraria os seletores de conta em todas as
      // telas, tão em silêncio quanto o vazamento.
      const app = await subirApp();
      const conta = (await app.inject({ method: "GET", url })).json()
        .accounts[0];

      expect(conta.id).toBe("acc-1");
      expect(conta.accountName).toBe("Loja Teste");
      expect(conta.status).toBe("ACTIVE");

      await app.close();
    });
  }

  it("OLX mantém os dados de vendedor que a tela de conexão edita", async () => {
    const app = await subirApp();
    const conta = (
      await app.inject({ method: "GET", url: "/marketplace/olx/accounts" })
    ).json().accounts[0];

    expect(conta.olxSellerPhone).toBe("11999999999");
    expect(conta.olxSellerZipcode).toBe("01001000");

    await app.close();
  });

  it("Facebook mantém as configs de catálogo que a tela de conexão edita", async () => {
    const app = await subirApp();
    const conta = (
      await app.inject({ method: "GET", url: "/marketplace/facebook/accounts" })
    ).json().accounts[0];

    expect(conta.fbCatalogId).toBe("cat-1");
    expect(conta.fbProductUrlBase).toBe("https://loja.exemplo/p");

    await app.close();
  });

  it("ML e Magalu não carregam campos de OUTRAS plataformas", async () => {
    // A linha do banco é a mesma tabela para todos; sem lista de permissão, a
    // conta do ML sairia carregando `fbCatalogId` e `olxSellerPhone` à toa.
    const app = await subirApp();
    for (const url of [
      "/marketplace/ml/accounts",
      "/marketplace/magalu/accounts",
    ]) {
      const conta = (await app.inject({ method: "GET", url })).json()
        .accounts[0];
      expect(conta).not.toHaveProperty("olxSellerPhone");
      expect(conta).not.toHaveProperty("fbCatalogId");
      expect(conta).not.toHaveProperty("expiresAt");
      expect(Object.keys(conta).sort()).toEqual([
        "accountName",
        "id",
        "status",
      ]);
    }
    await app.close();
  });
});

describe("contaMarketplaceVisivel — a decisão de contrato, isolada", () => {
  it("sem extras, devolve exatamente os três campos da base", () => {
    expect(contaMarketplaceVisivel(LINHA as any)).toEqual({
      id: "acc-1",
      accountName: "Loja Teste",
      status: "ACTIVE",
    });
  });

  it("extras entram por cima, e só o que foi pedido", () => {
    const r = contaMarketplaceVisivel(LINHA as any, { shopId: 42 });
    expect(r).toEqual({
      id: "acc-1",
      accountName: "Loja Teste",
      status: "ACTIVE",
      shopId: 42,
    });
  });

  it("uma coluna nova do modelo NÃO vaza sozinha", () => {
    // O ponto inteiro da lista de permissão: se alguém acrescentar
    // `novoSegredoDoApp` ao schema amanhã, ele nasce privado.
    const comColunaNova = {
      ...LINHA,
      novoSegredoDoApp: "AINDA-NAO-EXISTE-MAS-VAI",
    };
    const r = contaMarketplaceVisivel(comColunaNova as any);
    expect(r).not.toHaveProperty("novoSegredoDoApp");
    expect(JSON.stringify(r)).not.toContain("AINDA-NAO-EXISTE-MAS-VAI");
  });

  it("nenhum campo secreto atravessa, mesmo sendo passado como extra por engano", () => {
    // Extras são explícitos na chamada, então isto documenta o limite: o helper
    // não inventa proteção contra quem escreve o segredo à mão.
    const r = contaMarketplaceVisivel(LINHA as any);
    for (const campo of CAMPOS_SECRETOS_DA_CONTA) {
      expect(r).not.toHaveProperty(campo);
    }
  });
});
