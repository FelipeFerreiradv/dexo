/**
 * backfill-shopee-account-names.ts
 *
 * Troca o rótulo genérico `Shopee Shop <id>` pelo NOME da loja.
 *
 * Por que existe: a Shopee era a única plataforma que gravava um IDENTIFICADOR
 * onde as outras gravam um NOME. O Mercado Livre sempre gravou o `nickname`; a
 * Shopee gravava `Shopee Shop 1547916297`. Como ~20 telas leem
 * `MarketplaceAccount.accountName`, o operador com três lojas conectadas tinha
 * de decorar números. Medido em 20/08/2026: 35 de 35 contas em produção usavam
 * o rótulo genérico.
 *
 * A conexão nova já nasce com o nome, e a listagem de contas se auto-cura
 * quando alguém abre a aba de Integrações. Este script existe para não depender
 * disso: tenant que nunca abre a aba nunca seria curado.
 *
 * SEGURANÇA:
 *   1. Dry-run por default; só escreve com --apply.
 *   2. Só toca quem AINDA está com o rótulo genérico — nome escolhido a mão
 *      nunca é sobrescrito.
 *   3. A gravação é compare-and-swap: se alguém renomeou entre a leitura e a
 *      escrita, a linha não é tocada.
 *   4. Conta cujo token morreu (6 das 35 em produção) apenas é PULADA; nada é
 *      apagado e nenhum status muda.
 *   5. Aborta se o banco não for o de São Paulo.
 *
 * ⚠️ A Shopee exige IP na WHITELIST. Rodar da máquina local faz todas as
 * chamadas falharem e o dry-run relatar "0 nomes encontrados" — um falso
 * negativo convincente. RODE PELO SERVIDOR DE PRODUÇÃO.
 *
 * Uso (na VPS):
 *   npx tsx scripts/backfill-shopee-account-names.ts            # dry-run
 *   npx tsx scripts/backfill-shopee-account-names.ts --apply
 */
import "dotenv/config";

import prisma from "../app/lib/prisma";
import { ShopeeApiService } from "../app/marketplaces/services/shopee-api.service";
import { MarketplaceRepository } from "../app/marketplaces/repositories/marketplace.repository";
import {
  isGenericShopeeAccountName,
  nextShopeeAccountName,
} from "../app/marketplaces/lib/shopee-account-label";

function assertBanco(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("sa-east-1")) {
    throw new Error(
      "DATABASE_URL não aponta para São Paulo (sa-east-1). Abortando por segurança.",
    );
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  assertBanco();

  console.log("=".repeat(74));
  console.log(
    `Nome da loja nas contas Shopee — ${apply ? "APPLY" : "DRY-RUN"}`,
  );
  console.log("=".repeat(74));

  const contas = await prisma.marketplaceAccount.findMany({
    where: { platform: "SHOPEE" },
    select: {
      id: true,
      accountName: true,
      shopId: true,
      accessToken: true,
      status: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const genericasAntes = contas.filter((c) =>
    isGenericShopeeAccountName(c.accountName),
  );
  console.log(
    `\n${contas.length} conta(s) Shopee | ${genericasAntes.length} com o rótulo genérico\n`,
  );

  let renomeadas = 0;
  let semNome = 0;
  let puladas = 0;

  for (const c of contas) {
    if (!isGenericShopeeAccountName(c.accountName)) {
      puladas += 1;
      continue;
    }
    if (!c.shopId || !c.accessToken) {
      console.log(`  [pulada]  ${c.accountName} — sem shopId/token`);
      semNome += 1;
      continue;
    }

    let shopName: string | undefined;
    try {
      const info: any = await ShopeeApiService.getShopInfo(
        c.accessToken,
        c.shopId,
      );
      const payload = info?.response ?? info;
      shopName = payload?.shop_name ?? payload?.shopName ?? undefined;
    } catch (err) {
      console.log(
        `  [falhou]  ${c.accountName} (${c.status}) — ${
          err instanceof Error ? err.message : err
        }`,
      );
      semNome += 1;
      continue;
    }

    const rotulo = nextShopeeAccountName(c.accountName, shopName, c.shopId);
    if (!rotulo) {
      // A API respondeu, mas sem nome utilizável: o rótulo calculado é o mesmo
      // genérico. Nada a fazer — e nada a comemorar.
      console.log(`  [sem nome] ${c.accountName} — get_shop_info veio vazio`);
      semNome += 1;
      continue;
    }

    console.log(`  ${c.accountName}  ->  ${rotulo}`);
    if (apply) {
      const mudou = await MarketplaceRepository.renameShopeeAccountIfUnchanged(
        c.id,
        c.accountName,
        rotulo,
      );
      if (mudou > 0) renomeadas += 1;
      else console.log(`     (nao aplicado: alguem renomeou antes)`);
    } else {
      renomeadas += 1;
    }
  }

  // Contagem DEPOIS, relida do banco — não o acumulador acima. Um contador que
  // conta as próprias intenções não prova nada sobre o que ficou gravado.
  const genericasDepois = await prisma.marketplaceAccount.count({
    where: { platform: "SHOPEE", accountName: { startsWith: "Shopee Shop " } },
  });

  console.log("\n" + "-".repeat(74));
  console.log(`ja tinham nome proprio ........ ${puladas}`);
  console.log(
    `${apply ? "renomeadas" : "seriam renomeadas"} ............ ${renomeadas}`,
  );
  console.log(`sem nome (token morto/vazio) .. ${semNome}`);
  console.log(
    `genericas: ${genericasAntes.length} antes  ->  ${genericasDepois} agora`,
  );
  if (!apply) {
    console.log("\nDRY-RUN: nada foi gravado. Rode com --apply para aplicar.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
