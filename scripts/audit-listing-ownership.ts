/**
 * Auditoria preventiva de ownership de ProductListings do Mercado Livre.
 *
 * Importações em massa (ex.: JOTABÊ 18/05/2026) podem ter vinculado anúncios
 * à conta ML errada do mesmo usuário. Este script detecta esses vínculos
 * incorretos e reaponta o `marketplaceAccountId` para a conta certa, ANTES
 * que o erro apareça em fluxos como exclusão de produto.
 *
 * O que faz: somente LÊ via GET /items no ML e ATUALIZA o FK
 * `ProductListing.marketplaceAccountId` quando confirma o seller real em
 * outra conta do mesmo user.
 *
 * O que NÃO faz: nunca deleta produtos, nunca deleta listings, nunca chama
 * close/paused/update no ML, nunca toca em estoque/preço/status.
 *
 * Uso:
 *   npx tsx scripts/audit-listing-ownership.ts                          # dry-run, todos os users
 *   npx tsx scripts/audit-listing-ownership.ts --user-id <id>           # filtra um user
 *   npx tsx scripts/audit-listing-ownership.ts --user-id <id> --apply   # aplica reparos
 *   npx tsx scripts/audit-listing-ownership.ts --limit 100              # debug, processa só 100
 *
 * O script é idempotente: rodar de novo após --apply só revisita os mesmos
 * listings (agora corretos) e não muda nada.
 */

import { Platform, AccountStatus } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { ListingRepository } from "../app/marketplaces/repositories/listing.repository";
import { SystemLogService } from "../app/services/system-log.service";
import { findCorrectMLAccount } from "../app/marketplaces/services/listing-ownership-repair.service";

interface Flags {
  userId?: string;
  accountId?: string;
  statusPrefix?: string;
  apply: boolean;
  limit?: number;
  skip: number;
  delayMs: number;
  concurrency: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { apply: false, delayMs: 100, skip: 0, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") flags.apply = true;
    else if (a === "--user-id") flags.userId = argv[++i];
    else if (a === "--account-id") flags.accountId = argv[++i];
    else if (a === "--status-prefix") flags.statusPrefix = argv[++i];
    else if (a === "--limit") flags.limit = parseInt(argv[++i], 10);
    else if (a === "--skip") flags.skip = parseInt(argv[++i], 10);
    else if (a === "--delay-ms") flags.delayMs = parseInt(argv[++i], 10);
    else if (a === "--concurrency") flags.concurrency = parseInt(argv[++i], 10);
  }
  return flags;
}

interface Outcome {
  kind:
    | "OK"
    | "REPAIR"
    | "ORPHAN"
    | "GONE"
    | "ERR"
    | "MISMATCH_SAME_ACCOUNT"
    | "DUPLICATE_TARGET";
  listingId: string;
  externalListingId: string;
  currentAccountName: string;
  detail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const mode = flags.apply ? "APPLY" : "DRY-RUN";
  console.log(`\n=== Auditoria de ownership ML (${mode}) ===`);
  if (flags.userId) console.log(`User filtrado: ${flags.userId}`);
  if (flags.limit) console.log(`Limit: ${flags.limit}`);
  console.log();

  // Pega só listings vinculados a contas ML ATIVAS com accessToken (sem
  // token a primeira chamada já falharia de qualquer jeito).
  const listings = await prisma.productListing.findMany({
    where: {
      ...(flags.accountId ? { marketplaceAccountId: flags.accountId } : {}),
      ...(flags.statusPrefix
        ? { status: { startsWith: flags.statusPrefix } }
        : {}),
      marketplaceAccount: {
        platform: Platform.MERCADO_LIVRE,
        status: AccountStatus.ACTIVE,
        ...(flags.userId ? { userId: flags.userId } : {}),
      },
      // Exclui PENDING_* (anúncios ainda não publicados no ML — nada pra checar)
      NOT: { externalListingId: { startsWith: "PENDING_" } },
    },
    include: {
      marketplaceAccount: {
        select: {
          id: true,
          accountName: true,
          externalUserId: true,
          accessToken: true,
          userId: true,
        },
      },
    },
    // orderBy fixo para que skip/take sejam estáveis entre chunks
    orderBy: { id: "asc" },
    skip: flags.skip > 0 ? flags.skip : undefined,
    take: flags.limit,
  });

  console.log(`Total de listings a verificar: ${listings.length}`);
  console.log(`Concurrency: ${flags.concurrency}\n`);

  const outcomes: Outcome[] = [];
  let processed = 0;

  // Processa um único listing — toda a lógica que estava no loop original
  // foi movida pra cá para suportar execução paralela controlada.
  const processOne = async (l: typeof listings[number]) => {
    const acc = l.marketplaceAccount;
    if (!acc?.accessToken || !acc.userId) return;

    try {
      const item: any = await MLApiService.getItemDetails(
        acc.accessToken,
        l.externalListingId,
      );
      const itemSeller = String(item.seller_id ?? "");
      const accSeller = String(acc.externalUserId ?? "");

      if (itemSeller === accSeller) {
        // Vínculo correto, nada a fazer.
        outcomes.push({
          kind: "OK",
          listingId: l.id,
          externalListingId: l.externalListingId,
          currentAccountName: acc.accountName,
        });
      } else {
        // Conta atual conseguiu LER o item mas não é o dono — situação
        // estranha (ML normalmente nega leitura de quem não é o dono).
        // Pode acontecer em itens públicos. Tentar reparar mesmo assim.
        const repair = await findCorrectMLAccount({
          userId: acc.userId,
          currentAccountId: acc.id,
          externalListingId: l.externalListingId,
        });
        if (repair.repaired && repair.newAccountId) {
          let appliedOk = true;
          let duplicateDetail: string | undefined;
          if (flags.apply) {
            try {
              await ListingRepository.reassignAccount(l.id, repair.newAccountId);
              void SystemLogService.logListingOwnershipRepaired(
                acc.userId,
                l.id,
                {
                  externalListingId: l.externalListingId,
                  oldAccountId: acc.id,
                  newAccountId: repair.newAccountId,
                  itemStatus: repair.itemStatus,
                },
              );
            } catch (e: any) {
              if (e?.code === "P2002") {
                appliedOk = false;
                duplicateDetail = `já existe outro ProductListing local com este externalId em ${repair.newAccountId}`;
              } else {
                throw e;
              }
            }
          }
          if (appliedOk) {
            outcomes.push({
              kind: "REPAIR",
              listingId: l.id,
              externalListingId: l.externalListingId,
              currentAccountName: acc.accountName,
              detail: `→ seller real=${itemSeller}, nova conta=${repair.newAccountId}`,
            });
          } else {
            outcomes.push({
              kind: "DUPLICATE_TARGET",
              listingId: l.id,
              externalListingId: l.externalListingId,
              currentAccountName: acc.accountName,
              detail: duplicateDetail,
            });
          }
        } else {
          outcomes.push({
            kind: "MISMATCH_SAME_ACCOUNT",
            listingId: l.id,
            externalListingId: l.externalListingId,
            currentAccountName: acc.accountName,
            detail: `lê mas seller_id=${itemSeller} ≠ conta (${accSeller}); reparo: ${repair.reason}`,
          });
        }
      }
    } catch (err: any) {
      const status = err?.status;
      if (status === 404) {
        outcomes.push({
          kind: "GONE",
          listingId: l.id,
          externalListingId: l.externalListingId,
          currentAccountName: acc.accountName,
          detail: "item não existe mais no ML",
        });
      } else
      if (status === 403) {
        // O caso principal que queremos reparar.
        const repair = await findCorrectMLAccount({
          userId: acc.userId,
          currentAccountId: acc.id,
          externalListingId: l.externalListingId,
        });
        if (repair.repaired && repair.newAccountId) {
          let appliedOk = true;
          let duplicateDetail: string | undefined;
          if (flags.apply) {
            try {
              await ListingRepository.reassignAccount(l.id, repair.newAccountId);
              void SystemLogService.logListingOwnershipRepaired(
                acc.userId,
                l.id,
                {
                  externalListingId: l.externalListingId,
                  oldAccountId: acc.id,
                  newAccountId: repair.newAccountId,
                  itemStatus: repair.itemStatus,
                },
              );
            } catch (e: any) {
              if (e?.code === "P2002") {
                appliedOk = false;
                duplicateDetail = `já existe outro ProductListing local com este externalId em ${repair.newAccountId}`;
              } else {
                throw e;
              }
            }
          }
          if (appliedOk) {
            outcomes.push({
              kind: "REPAIR",
              listingId: l.id,
              externalListingId: l.externalListingId,
              currentAccountName: acc.accountName,
              detail: `→ nova conta=${repair.newAccountId} (item.status=${repair.itemStatus})`,
            });
          } else {
            outcomes.push({
              kind: "DUPLICATE_TARGET",
              listingId: l.id,
              externalListingId: l.externalListingId,
              currentAccountName: acc.accountName,
              detail: duplicateDetail,
            });
          }
        } else {
          outcomes.push({
            kind: "ORPHAN",
            listingId: l.id,
            externalListingId: l.externalListingId,
            currentAccountName: acc.accountName,
            detail: repair.reason,
          });
        }
      } else {
        outcomes.push({
          kind: "ERR",
          listingId: l.id,
          externalListingId: l.externalListingId,
          currentAccountName: acc.accountName,
          detail: `status=${status} msg=${(err?.message ?? "").slice(0, 160)}`,
        });
      }
    }

    if (flags.delayMs > 0) await sleep(flags.delayMs);

    processed++;
    if (processed % 250 === 0) {
      console.log(`  [progresso] ${processed}/${listings.length}`);
    }
  };

  // Processa em batches paralelos. Concorrência baixa (1-10) evita rate
  // limit do ML; wall-clock cai linearmente com concurrency.
  for (let i = 0; i < listings.length; i += flags.concurrency) {
    const batch = listings.slice(i, i + flags.concurrency);
    await Promise.all(batch.map((l) => processOne(l)));
  }

  // Relatório
  console.log("\n=== Resultado ===");
  const totals: Record<Outcome["kind"], number> = {
    OK: 0,
    REPAIR: 0,
    ORPHAN: 0,
    GONE: 0,
    ERR: 0,
    MISMATCH_SAME_ACCOUNT: 0,
    DUPLICATE_TARGET: 0,
  };
  for (const o of outcomes) totals[o.kind]++;

  console.log(`  OK (vínculo já correto):           ${totals.OK}`);
  console.log(
    `  REPARADO ${flags.apply ? "(aplicado)" : "(dry-run, NÃO aplicado)"}: ${totals.REPAIR}`,
  );
  console.log(`  DUPLICATA (alvo já tem listing):   ${totals.DUPLICATE_TARGET}`);
  console.log(`  ÓRFÃO (nenhuma outra conta sabe):  ${totals.ORPHAN}`);
  console.log(`  ITEM SUMIU (404 no ML):            ${totals.GONE}`);
  console.log(`  MISMATCH leitura-única:            ${totals.MISMATCH_SAME_ACCOUNT}`);
  console.log(`  ERRO INESPERADO:                   ${totals.ERR}`);
  console.log(`  Total processado:                  ${outcomes.length}`);

  // Detalhamento das ações relevantes (top 20 de cada)
  const sections: Outcome["kind"][] = [
    "REPAIR",
    "DUPLICATE_TARGET",
    "ORPHAN",
    "GONE",
    "ERR",
    "MISMATCH_SAME_ACCOUNT",
  ];
  for (const kind of sections) {
    const items = outcomes.filter((o) => o.kind === kind);
    if (items.length === 0) continue;
    console.log(`\n--- ${kind} (${items.length}) ---`);
    for (const o of items.slice(0, 20)) {
      console.log(`  ${o.externalListingId.padEnd(15)} acc=${o.currentAccountName.padEnd(20)} ${o.detail ?? ""}`);
    }
    if (items.length > 20) console.log(`  ... e mais ${items.length - 20}`);
  }

  if (!flags.apply && totals.REPAIR > 0) {
    console.log(
      `\nPara aplicar os ${totals.REPAIR} reparos, rode novamente com --apply.`,
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
    // process.exit explícito: o pool axios do MLApiService às vezes mantém
    // o event loop vivo mesmo depois do main retornar, segurando o node por
    // muito tempo. Forçamos a saída.
    process.exit(process.exitCode ?? 0);
  });
