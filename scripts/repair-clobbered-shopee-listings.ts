/**
 * repair-clobbered-shopee-listings.ts
 *
 * Repara linhas de ProductListing SHOPEE cujo status foi SOBRESCRITO por um
 * job redundante: o job 1 criou o anúncio com sucesso (externalListingId real
 * gravado), o job 2 — disparado pelo modal de confirmação reaberto — falhou na
 * Shopee com "This product duplicates another in your shop" e o upsert do
 * fracasso marcou a linha SAUDÁVEL como status=error. O anúncio está NO AR na
 * Shopee; a linha local é que mente.
 *
 * Assinatura estreita (não toca em nada além disso):
 *   - status = "error"
 *   - lastError contendo "duplicates another in your shop"
 *   - externalListingId REAL (numérico — não PENDING_)
 * Reparo: status="active", lastError=null (o sync de estoque volta a enxergar).
 *
 * Uso:
 *   npx tsx scripts/repair-clobbered-shopee-listings.ts                      # dry-run
 *   npx tsx scripts/repair-clobbered-shopee-listings.ts --user-id=<id>      # filtra tenant
 *   npx tsx scripts/repair-clobbered-shopee-listings.ts --apply             # aplica
 */

import "dotenv/config";
import prisma from "../app/lib/prisma";
import { Platform } from "@prisma/client";

interface Args {
  apply: boolean;
  userId: string | null;
  since: Date | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, userId: null, since: null };
  for (const a of argv) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--user-id=")) args.userId = a.slice(10) || null;
    else if (a.startsWith("--since=")) {
      const d = new Date(a.slice(8));
      if (!Number.isNaN(d.getTime())) args.since = d;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const victims = await prisma.productListing.findMany({
    where: {
      status: "error",
      lastError: { contains: "duplicates another in your shop" },
      ...(args.since ? { updatedAt: { gte: args.since } } : {}),
      marketplaceAccount: {
        platform: Platform.SHOPEE,
        ...(args.userId ? { userId: args.userId } : {}),
      },
    },
    select: {
      id: true,
      productId: true,
      externalListingId: true,
      lastError: true,
      updatedAt: true,
      marketplaceAccount: {
        select: { accountName: true, userId: true },
      },
      product: { select: { sku: true, name: true } },
    },
  });

  // Só linhas com id REAL da Shopee (numérico) — placeholder nunca esteve no ar.
  const repairable = victims.filter((v) =>
    /^\d+$/.test(v.externalListingId ?? ""),
  );

  console.log(
    `[repair] candidatos: ${victims.length}; com externalListingId real: ${repairable.length}`,
  );
  for (const v of repairable) {
    console.log(
      `  - ${v.id} sku=${v.product?.sku} ext=${v.externalListingId} conta=${v.marketplaceAccount?.accountName} user=${v.marketplaceAccount?.userId} updatedAt=${v.updatedAt.toISOString()}`,
    );
  }

  if (!args.apply) {
    console.log("[repair] dry-run — use --apply para reparar");
    return;
  }

  for (const v of repairable) {
    await prisma.productListing.update({
      where: { id: v.id },
      data: { status: "active", lastError: null },
    });
    console.log(`[repair] reparado: ${v.id} → active`);
  }
  console.log(`[repair] concluído: ${repairable.length} linha(s)`);
}

main()
  .catch((err) => {
    console.error("[repair] erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
