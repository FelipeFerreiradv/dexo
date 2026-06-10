/**
 * Consolida ProductListings duplicados deixados pelo audit-listing-ownership.
 *
 * Cenário: para o mesmo `externalListingId` (ex.: MLB...) existem 2+ rows na
 * tabela ProductListing, em contas diferentes do MESMO usuário. Acontece
 * quando uma importação cria o vínculo na conta errada e outro fluxo (sync,
 * publicação) cria o vínculo correto em paralelo. O audit não conseguiu
 * reapontar o errado porque o índice único `(marketplaceAccountId,
 * externalListingId)` já está ocupado pelo correto.
 *
 * O que faz:
 *   - Para cada externalListingId duplicado num user, faz GET /items/{id}
 *     com cada conta do user pra descobrir qual é o seller real.
 *   - Deleta APENAS os ProductListings nas contas que NÃO são donas reais.
 *     O Product local que apontava pra elas fica sem vínculo ML (esperado:
 *     o anúncio não era dele mesmo).
 *
 * O que NÃO faz:
 *   - Nunca deleta Products
 *   - Nunca toca em ML (só GET)
 *   - Não deleta o listing CORRETO
 *
 * Uso:
 *   npx tsx scripts/consolidate-duplicate-listings.ts --user-id <id>           # dry-run
 *   npx tsx scripts/consolidate-duplicate-listings.ts --user-id <id> --apply   # aplica
 */

import { Platform, AccountStatus } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { SystemLogService } from "../app/services/system-log.service";

interface Flags {
  userId?: string;
  apply: boolean;
  delayMs: number;
  concurrency: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { apply: false, delayMs: 0, concurrency: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") flags.apply = true;
    else if (a === "--user-id") flags.userId = argv[++i];
    else if (a === "--delay-ms") flags.delayMs = parseInt(argv[++i], 10);
    else if (a === "--concurrency")
      flags.concurrency = parseInt(argv[++i], 10);
  }
  return flags;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  externalListingId: string;
  kind: "CONSOLIDATED" | "NO_OWNER" | "SINGLE" | "ERR";
  keptListingId?: string;
  deletedListingIds: string[];
  detail?: string;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const mode = flags.apply ? "APPLY" : "DRY-RUN";
  console.log(`\n=== Consolidação de listings duplicados (${mode}) ===`);
  if (flags.userId) console.log(`User filtrado: ${flags.userId}`);
  console.log(`Concurrency: ${flags.concurrency}\n`);

  // 1) Encontra externalListingIds que aparecem em MAIS DE UMA conta ML
  // ativa do mesmo user.
  const rows = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: {
        platform: Platform.MERCADO_LIVRE,
        status: AccountStatus.ACTIVE,
        ...(flags.userId ? { userId: flags.userId } : {}),
      },
      NOT: { externalListingId: { startsWith: "PENDING_" } },
    },
    select: {
      id: true,
      externalListingId: true,
      marketplaceAccountId: true,
      marketplaceAccount: {
        select: {
          accountName: true,
          externalUserId: true,
          accessToken: true,
          userId: true,
        },
      },
    },
  });

  // Agrupa por (userId, externalListingId)
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const userId = r.marketplaceAccount?.userId;
    if (!userId) continue;
    const key = `${userId}::${r.externalListingId}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  // Filtra só os realmente duplicados (2+) em CONTAS DIFERENTES
  const duplicates = Array.from(groups.entries()).filter(([, items]) => {
    if (items.length < 2) return false;
    const distinctAccounts = new Set(items.map((i) => i.marketplaceAccountId));
    return distinctAccounts.size >= 2;
  });

  console.log(`Total de externalListingIds duplicados: ${duplicates.length}\n`);

  const outcomes: Outcome[] = [];
  let processed = 0;

  const processOne = async ([key, items]: (typeof duplicates)[number]) => {
    const externalListingId = items[0].externalListingId;
    const accounts = items.map((i) => ({
      listingId: i.id,
      accountId: i.marketplaceAccountId,
      accountName: i.marketplaceAccount?.accountName ?? "",
      externalUserId: i.marketplaceAccount?.externalUserId ?? "",
      accessToken: i.marketplaceAccount?.accessToken ?? "",
    }));

    // Tenta descobrir qual conta é o dono REAL via GET /items.
    let ownerExternalUserId: string | null = null;
    for (const acc of accounts) {
      if (!acc.accessToken) continue;
      try {
        const item: any = await MLApiService.getItemDetails(
          acc.accessToken,
          externalListingId,
        );
        ownerExternalUserId = String(item.seller_id ?? "");
        break; // qualquer conta que conseguir ler já me dá o seller_id
      } catch {
        // tenta próxima
      }
    }

    if (!ownerExternalUserId) {
      outcomes.push({
        externalListingId,
        kind: "NO_OWNER",
        deletedListingIds: [],
        detail: "nenhuma conta conseguiu ler o item no ML para confirmar dono",
      });
    } else {
      const correct = accounts.find(
        (a) => String(a.externalUserId) === ownerExternalUserId,
      );
      if (!correct) {
        outcomes.push({
          externalListingId,
          kind: "NO_OWNER",
          deletedListingIds: [],
          detail: `seller real=${ownerExternalUserId} mas nenhuma conta duplicada bate (caso raro)`,
        });
      } else {
        const wrong = accounts.filter((a) => a.listingId !== correct.listingId);
        if (flags.apply) {
          for (const w of wrong) {
            try {
              await prisma.productListing.delete({
                where: { id: w.listingId },
              });
              const userId = items[0].marketplaceAccount?.userId;
              if (userId) {
                void SystemLogService.logInfo(
                  "LISTING_DUPLICATE_REMOVED",
                  `Removido ProductListing duplicado ${externalListingId} (conta errada ${w.accountName})`,
                  {
                    userId,
                    resource: "ProductListing",
                    resourceId: w.listingId,
                    details: {
                      externalListingId,
                      keptListingId: correct.listingId,
                      keptAccount: correct.accountName,
                      removedAccount: w.accountName,
                    },
                  },
                );
              }
            } catch (e: any) {
              outcomes.push({
                externalListingId,
                kind: "ERR",
                deletedListingIds: [],
                detail: `delete falhou em ${w.listingId}: ${e?.message ?? e}`,
              });
              return;
            }
          }
        }
        outcomes.push({
          externalListingId,
          kind: "CONSOLIDATED",
          keptListingId: correct.listingId,
          deletedListingIds: wrong.map((w) => w.listingId),
          detail: `mantida=${correct.accountName} ; removidas=${wrong.map((w) => w.accountName).join(",")}`,
        });
      }
    }

    if (flags.delayMs > 0) await sleep(flags.delayMs);
    processed++;
    if (processed % 50 === 0) {
      console.log(`  [progresso] ${processed}/${duplicates.length}`);
    }
  };

  for (let i = 0; i < duplicates.length; i += flags.concurrency) {
    const batch = duplicates.slice(i, i + flags.concurrency);
    await Promise.all(batch.map((d) => processOne(d)));
  }

  // Relatório
  console.log("\n=== Resultado ===");
  const totals = { CONSOLIDATED: 0, NO_OWNER: 0, SINGLE: 0, ERR: 0 };
  for (const o of outcomes) totals[o.kind]++;
  console.log(
    `  CONSOLIDADO ${flags.apply ? "(aplicado)" : "(dry-run)"}: ${totals.CONSOLIDATED}`,
  );
  console.log(`  SEM DONO IDENTIFICADO:               ${totals.NO_OWNER}`);
  console.log(`  ERRO INESPERADO:                     ${totals.ERR}`);
  console.log(`  Total processado:                    ${outcomes.length}`);

  const deletedTotal = outcomes.reduce(
    (sum, o) => sum + o.deletedListingIds.length,
    0,
  );
  console.log(`  Listings ${flags.apply ? "deletados" : "que seriam deletados"}: ${deletedTotal}`);

  // Detalhamento
  for (const kind of ["NO_OWNER", "ERR"] as const) {
    const items = outcomes.filter((o) => o.kind === kind);
    if (items.length === 0) continue;
    console.log(`\n--- ${kind} (${items.length}) ---`);
    for (const o of items.slice(0, 20)) {
      console.log(`  ${o.externalListingId}  ${o.detail ?? ""}`);
    }
    if (items.length > 20) console.log(`  ... e mais ${items.length - 20}`);
  }

  if (!flags.apply && totals.CONSOLIDATED > 0) {
    console.log(
      `\nPara aplicar a consolidação (${deletedTotal} listings deletados), rode novamente com --apply.`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
