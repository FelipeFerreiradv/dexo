import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "@prisma/client";

// ===========================================================================
// DOIS BURACOS NO MOTOR DE SINCRONIZAÇÃO, achados ao dar cobertura de OLX e
// Facebook ao Bitz. Nenhum dos dois é do Bitz — mas ele é gatilho novo para os
// dois, porque `alterar_preco` e `ajustar_estoque` entram exatamente por aqui.
//
//  1. `syncProductData` era o ÚLTIMO caminho de saída sem o kill-switch de
//     runtime. `syncProductStock` e `syncAllStock` paravam com
//     OLX/FACEBOOK_INTEGRATION_DISABLED=1; este não. Na prática, "pausar a
//     integração" pausava a baixa por venda e deixava a EDIÇÃO DE PRODUTO
//     continuar publicando na OLX.
//
//  2. O log de falha da sincronização de produto gravava `MercadoLivre` fixo,
//     para qualquer plataforma. Uma falha de OLX ia para a trilha rotulada
//     como Mercado Livre.
//
// O que estes testes olham, e um "o resultado está certo" não olharia: se a
// chamada externa REALMENTE não sai. Por isso a asserção é sobre a leitura do
// listing — que acontece logo depois do guard e antes de qualquer rede.
// ===========================================================================

vi.mock("@/app/lib/prisma", () => ({
  default: {
    product: { findUnique: vi.fn() },
    productListing: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    productCompatibility: { findMany: vi.fn() },
    syncLog: { create: vi.fn() },
    systemLog: { create: vi.fn() },
    stockLog: { create: vi.fn() },
    marketplaceAccount: { findUnique: vi.fn() },
  },
}));

const repoFindById = vi.fn();
const repoUpdate = vi.fn();
vi.mock("@/app/repositories/product.repository", () => ({
  ProductRepositoryPrisma: class {
    findById = (...a: any[]) => repoFindById(...a);
    update = (...a: any[]) => repoUpdate(...a);
  },
}));

const logErrorMock = vi.fn();
vi.mock("@/app/services/system-log.service", () => ({
  SystemLogService: {
    logError: (...a: any[]) => logErrorMock(...a),
    logInfo: vi.fn(),
    log: vi.fn(),
  },
}));

import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";
import { ProductUseCase } from "@/app/usecases/product.usercase";

/** Roda `fn` com as env vars dadas, restaurando no fim (inclusive se falhar). */
async function comEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const anterior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    anterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SKU = "FAROL-77";

function prepara(platform: Platform) {
  vi.mocked(prisma.product.findUnique).mockResolvedValue({
    id: "p1",
    name: "Farol Dianteiro Palio",
    sku: SKU,
    price: 250,
    stock: 3,
  } as any);
  vi.mocked(prisma.marketplaceAccount.findUnique).mockResolvedValue({
    id: "acc-1",
    platform,
    accessToken: "tok",
    accountName: "Conta",
    fbCatalogId: "cat",
  } as any);
  // Se a execução passar do guard, ELA CHEGA AQUI. É o sensor do teste.
  vi.mocked(prisma.productListing.findUnique).mockResolvedValue(null as any);
  vi.mocked(prisma.productCompatibility.findMany).mockResolvedValue([] as any);
}

/** Passou do guard? A leitura de overrides é o primeiro passo depois dele. */
const passouDoGuard = () =>
  vi.mocked(prisma.productListing.findUnique).mock.calls.length > 0;

afterEach(() => vi.clearAllMocks());

describe("⭐ syncProductData respeita o kill-switch de runtime", () => {
  it("OLX desligada: devolve skip explícito e NÃO segue para a chamada externa", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: "1" }, async () => {
      prepara(Platform.OLX);
      const r = await SyncUseCase.syncProductData("p1", SKU, "acc-1");

      expect(r.skipped).toBe(true);
      expect(r.skipReason).toBe("integration_disabled");
      expect(r.platform).toBe(Platform.OLX);
      expect(passouDoGuard()).toBe(false);
    });
  });

  it("Facebook desligado: idem", async () => {
    await comEnv({ FACEBOOK_INTEGRATION_DISABLED: "1" }, async () => {
      prepara(Platform.FACEBOOK);
      const r = await SyncUseCase.syncProductData("p1", SKU, "acc-1");

      expect(r.skipped).toBe(true);
      expect(r.skipReason).toBe("integration_disabled");
      expect(passouDoGuard()).toBe(false);
    });
  });

  // ⭐ Pular NÃO é falhar. Quem chama conta `r.success` para dizer ao lojista se
  // a edição deu certo; uma integração pausada de propósito não é erro dele.
  // É o mesmo contrato de `syncProductStock`.
  it("o skip sai como SUCESSO, não como falha da edição", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: "1" }, async () => {
      prepara(Platform.OLX);
      const r = await SyncUseCase.syncProductData("p1", SKU, "acc-1");
      expect(r.success).toBe(true);
      expect(r.error).toBeUndefined();
    });
  });

  it("com a flag DESLIGADA a OLX segue normalmente — o guard não é bloqueio", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: "0" }, async () => {
      prepara(Platform.OLX);
      await SyncUseCase.syncProductData("p1", SKU, "acc-1");
      expect(passouDoGuard()).toBe(true);
    });
  });

  it("flag ausente também não desliga nada", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: undefined }, async () => {
      prepara(Platform.OLX);
      await SyncUseCase.syncProductData("p1", SKU, "acc-1");
      expect(passouDoGuard()).toBe(true);
    });
  });
});

describe("⭐ zero regressão: o guard não alcança os três canais maduros", () => {
  // `isPlatformDisabled` devolve `false` incondicionalmente para tudo que não é
  // OLX nem FACEBOOK. Estes três casos provam que ligar as duas chaves ao mesmo
  // tempo não muda NADA para quem já estava em produção.
  it.each([Platform.MERCADO_LIVRE, Platform.SHOPEE, Platform.MAGALU])(
    "%s sincroniza mesmo com as duas chaves ligadas",
    async (platform) => {
      await comEnv(
        {
          OLX_INTEGRATION_DISABLED: "1",
          FACEBOOK_INTEGRATION_DISABLED: "1",
        },
        async () => {
          prepara(platform);
          const r = await SyncUseCase.syncProductData("p1", SKU, "acc-1");
          expect(r.skipped).toBeFalsy();
          expect(passouDoGuard()).toBe(true);
        },
      );
    },
  );

  it("a chave da OLX não desliga o Facebook, nem o contrário", async () => {
    await comEnv({ OLX_INTEGRATION_DISABLED: "1" }, async () => {
      prepara(Platform.FACEBOOK);
      await SyncUseCase.syncProductData("p1", SKU, "acc-1");
      expect(passouDoGuard()).toBe(true);
    });

    vi.clearAllMocks();

    await comEnv({ FACEBOOK_INTEGRATION_DISABLED: "1" }, async () => {
      prepara(Platform.OLX);
      await SyncUseCase.syncProductData("p1", SKU, "acc-1");
      expect(passouDoGuard()).toBe(true);
    });
  });
});

describe("⭐ o log de falha de sync não acusa o canal errado", () => {
  /**
   * Leva `ProductUseCase.update` até o `catch` da sincronização: a leitura dos
   * anúncios do produto falha, `syncProductListings` relança, e é ali que o log
   * é escrito. Fora do `catch` este caminho não existe.
   */
  async function atualizaComSyncQuebrado() {
    const produto = { id: "p1", name: "Farol", sku: SKU, price: 250, stock: 3 };
    repoFindById.mockResolvedValue(produto);
    repoUpdate.mockResolvedValue({ ...produto, price: 300 });
    vi.mocked(prisma.productListing.updateMany).mockResolvedValue({
      count: 0,
    } as any);
    vi.mocked(prisma.productListing.findMany).mockRejectedValue(
      new Error("banco fora do ar"),
    );

    await new ProductUseCase().update("p1", { price: 300 } as any, "u1");
    return logErrorMock.mock.calls[0];
  }

  it("não escreve MercadoLivre para uma falha que pode ser de qualquer canal", async () => {
    const [, mensagem, opcoes] = await atualizaComSyncQuebrado();
    expect(mensagem).not.toMatch(/MercadoLivre|Mercado Livre/);
    expect(JSON.stringify(opcoes.details)).not.toMatch(/MercadoLivre/);
  });

  it("e diz de QUE PRODUTO é a falha, que é o que faltava para investigar", async () => {
    const [acao, mensagem, opcoes] = await atualizaComSyncQuebrado();
    expect(acao).toBe("SYNC_STOCK");
    expect(mensagem).toContain("p1");
    expect(opcoes.resourceId).toBe("p1");
    expect(opcoes.details.productId).toBe("p1");
    expect(opcoes.details.syncType).toBe("PRODUCT_UPDATE_SYNC");
    expect(String(opcoes.details.error)).toContain("banco fora do ar");
  });

  // O relatório de produtividade da equipe agrega `details->>'marketplace'`,
  // mas só de CREATE_PRODUCT/CREATE_LISTING com level INFO
  // (team-productivity.query.ts:23-38). Esta linha é SYNC_STOCK e ERROR — tirar
  // o campo dela não muda uma contagem sequer. Este teste tranca a premissa.
  it("a linha continua fora do recorte que o relatório de produtividade lê", async () => {
    const [acao] = await atualizaComSyncQuebrado();
    expect(["CREATE_PRODUCT", "CREATE_LISTING"]).not.toContain(acao);
  });
});
