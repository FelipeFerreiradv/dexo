import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// BLOCO T-F — quem entra na varredura de espelhamento de status.
//
// A decisão de projeto está numa única linha de
// app/marketplaces/services/listing-status-sweep.service.ts:
//
//   const mirrorPlatforms = ["MERCADO_LIVRE", "SHOPEE"];
//   if (!isFacebookDisabled()) mirrorPlatforms.push("FACEBOOK");
//
// Esse array vira o `where.platform.in` do findMany das contas — ou seja, é
// literalmente o filtro do banco. Por isso todas as asserções aqui olham o
// argumento real passado ao Prisma, e não um efeito indireto: se alguém
// trocar a ordem, remover o guard ou acrescentar "OLX", este spec quebra.
//
// tests/listing-status-sweep.spec.ts cobre paginação/cursor/isolamento de
// falha; este cobre exclusivamente a COMPOSIÇÃO da varredura.
//
// vitest.config.ts liga LISTING_STATUS_SYNC_DISABLED="1" por padrão (runOnce
// retorna antes de tocar o banco), então cada caso religa em "0" e restaura.
// ──────────────────────────────────────────────────────────

import prisma from "@/app/lib/prisma";
import { ListingStatusSweepService } from "@/app/marketplaces/services/listing-status-sweep.service";
import { ListingStatusRefreshService } from "@/app/marketplaces/services/listing-status-refresh.service";

/** Roda `fn` com as variáveis de ambiente dadas, restaurando no finally. */
async function comEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
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

/** Plataformas que o runOnce pediu ao banco nesta rodada. */
// `spy` é tipado como any de propósito: o MockInstance do prisma carrega os
// genéricos do Prisma Client e não casa com o ReturnType<typeof vi.spyOn>
// genérico — só o `where` da primeira chamada interessa aqui.
function plataformasVarridas(spy: any, chamada = 0): string[] {
  const where = spy?.mock?.calls?.[chamada]?.[0]?.where;
  return where?.platform?.in as string[];
}

const contaFacebook = {
  id: "acc-fb",
  platform: "FACEBOOK",
  status: "ACTIVE",
  accessToken: "tok-fb",
  refreshToken: null,
  expiresAt: new Date(Date.now() + 3_600_000),
  shopId: null,
  fbCatalogId: "cat-do-tenant",
};

describe("varredura de status — composição das plataformas (Facebook entra, OLX não)", () => {
  beforeEach(() => {
    (ListingStatusSweepService as any).cursors = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Facebook ENTRA na varredura quando FACEBOOK_INTEGRATION_DISABLED != 1", async () => {
    await comEnv(
      {
        LISTING_STATUS_SYNC_DISABLED: "0",
        FACEBOOK_INTEGRATION_DISABLED: undefined,
      },
      async () => {
        const findAccounts = vi
          .spyOn(prisma.marketplaceAccount, "findMany")
          .mockResolvedValue([] as any);

        await ListingStatusSweepService.runOnce();

        // Sem a flag ligada o Facebook TEM que ser varrido: é a única fonte de
        // espelhamento de status da Meta (não há webhook de item no catálogo).
        expect(plataformasVarridas(findAccounts)).toContain("FACEBOOK");
        // E o filtro tem que ser exatamente as três — nada de varrer o banco
        // inteiro por descuido (ex.: alguém removendo o `platform: { in: ... }`).
        expect(plataformasVarridas(findAccounts).sort()).toEqual([
          "FACEBOOK",
          "MERCADO_LIVRE",
          "SHOPEE",
        ]);
        // Só contas ACTIVE: conta em ERROR não deve gerar chamada externa.
        expect(
          (findAccounts.mock.calls[0][0] as any).where.status,
        ).toBe("ACTIVE");
      },
    );
  });

  it("FACEBOOK_INTEGRATION_DISABLED=1 tira o Facebook e NÃO toca em ML/Shopee", async () => {
    await comEnv(
      {
        LISTING_STATUS_SYNC_DISABLED: "0",
        FACEBOOK_INTEGRATION_DISABLED: "1",
      },
      async () => {
        const findAccounts = vi
          .spyOn(prisma.marketplaceAccount, "findMany")
          .mockResolvedValue([] as any);

        await ListingStatusSweepService.runOnce();

        expect(plataformasVarridas(findAccounts)).not.toContain("FACEBOOK");
        // O ponto do caso: o kill-switch é CIRÚRGICO. Se o guard fosse escrito
        // ao contrário (montar o array só quando habilitado, p.ex.), o ML e a
        // Shopee sairiam junto e o espelhamento de produção morreria em
        // silêncio — exatamente o tipo de dano colateral que não pode passar.
        expect(plataformasVarridas(findAccounts)).toEqual([
          "MERCADO_LIVRE",
          "SHOPEE",
        ]);
      },
    );
  });

  it("a flag é lida A CADA rodada: ligar/desligar muda a varredura sem restart", async () => {
    const findAccounts = vi
      .spyOn(prisma.marketplaceAccount, "findMany")
      .mockResolvedValue([] as any);

    await comEnv(
      { LISTING_STATUS_SYNC_DISABLED: "0", FACEBOOK_INTEGRATION_DISABLED: "1" },
      async () => {
        await ListingStatusSweepService.runOnce();
      },
    );
    await comEnv(
      {
        LISTING_STATUS_SYNC_DISABLED: "0",
        FACEBOOK_INTEGRATION_DISABLED: undefined,
      },
      async () => {
        await ListingStatusSweepService.runOnce();
      },
    );

    // Se mirrorPlatforms virasse constante de módulo (avaliada no import), as
    // duas rodadas seriam idênticas e o operador precisaria de deploy para
    // desligar a Meta. O contrato é pm2 restart-free.
    expect(plataformasVarridas(findAccounts, 0)).not.toContain("FACEBOOK");
    expect(plataformasVarridas(findAccounts, 1)).toContain("FACEBOOK");
  });

  it("OLX NUNCA entra na varredura — nem com a integração OLX totalmente ligada", async () => {
    await comEnv(
      {
        LISTING_STATUS_SYNC_DISABLED: "0",
        OLX_INTEGRATION_DISABLED: undefined,
        FACEBOOK_INTEGRATION_DISABLED: undefined,
      },
      async () => {
        const findAccounts = vi
          .spyOn(prisma.marketplaceAccount, "findMany")
          .mockResolvedValue([] as any);

        await ListingStatusSweepService.runOnce();

        // TRAVA DE DECISÃO DE PROJETO, não pedido de implementação: nesta fase
        // a OLX não tem leitura de status do anúncio publicado (o autoupload
        // só empurra). Varrer conta OLX seria egress puro sem nenhum status
        // para espelhar — e o refresh service devolveria `return` no else.
        // Se um dia a leitura existir, este caso é o lugar de mudar de ideia
        // deliberadamente; enquanto não existir, ele impede a inclusão
        // acidental junto com o Facebook (as duas plataformas subiram juntas).
        expect(plataformasVarridas(findAccounts)).not.toContain("OLX");
      },
    );
  });

  it("a conta Facebook chega ao refresh com o fbCatalogId da própria conta", async () => {
    await comEnv(
      {
        LISTING_STATUS_SYNC_DISABLED: "0",
        FACEBOOK_INTEGRATION_DISABLED: undefined,
      },
      async () => {
        const findAccounts = vi
          .spyOn(prisma.marketplaceAccount, "findMany")
          .mockResolvedValue([contaFacebook] as any);
        vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
          { id: "l-fb", status: "active", externalListingId: "SKU-1" },
        ] as any);
        const refresh = vi
          .spyOn(ListingStatusRefreshService, "refreshRowsBestEffort")
          .mockResolvedValue(new Map());

        await ListingStatusSweepService.runOnce();

        // fbCatalogId precisa estar no SELECT: sem ele o refresh cai no
        // FACEBOOK_CONSTANTS.CATALOG_ID do .env e o sweep leria o catálogo de
        // OUTRO tenant — vazamento entre contas, não só status errado.
        expect(
          (findAccounts.mock.calls[0][0] as any).select.fbCatalogId,
        ).toBe(true);
        const rows = refresh.mock.calls[0][0];
        expect(rows[0].marketplaceAccount).toMatchObject({
          platform: "FACEBOOK",
          fbCatalogId: "cat-do-tenant",
        });
      },
    );
  });
});
