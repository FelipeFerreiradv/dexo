/**
 * Reabilita os anúncios desligados pela mensagem FALSA de preço.
 *
 * Contexto: o guard de `listing-retry.service.ts` comparava
 * `typeof product.price === "number"` sobre um `Product` cru do Prisma, onde
 * `price` é `Decimal` (typeof "object"). Reprovava SEMPRE, e marcava o anúncio
 * com `[TERMINAL] Produto sem preço (price=0)` + `retryEnabled=false` — mesmo
 * com preço válido. O guard foi corrigido, mas quem já foi desligado não volta
 * sozinho (o where de findPendingRetries exige retryEnabled=true).
 *
 * SEGURANÇA — este script só reabilita candidatos que satisfazem TODAS as
 * condições abaixo. Cada uma existe por um motivo:
 *
 *  - `lastError` começa com a mensagem falsa  → só as vítimas do bug.
 *  - `externalListingId` começa com PENDING_  → NUNCA um anúncio real. Se a
 *    linha aponta um MLB vivo, recriar geraria um anúncio DUPLICADO no ML e
 *    deixaria o antigo órfão (o retry sobrescreve o externalListingId no
 *    sucesso). Esta é a condição mais importante do script.
 *  - `product.price > 0` e `stock > 0`        → o guard corrigido reprovaria
 *    de novo; reabilitar só gastaria chamadas ao ML.
 *
 * O que grava (só nas linhas que passam no filtro):
 *   retryEnabled=true, retryAttempts=0, nextRetryAt=now, lastError=null
 *
 * `retryAttempts=0` é intencional: essas linhas nunca tiveram uma tentativa
 * real (morreram no guard falso), então recebem o ciclo completo de backoff.
 *
 * Uso:
 *   npx tsx scripts/reenable-false-terminal-listings.ts                    # dry-run (default)
 *   npx tsx scripts/reenable-false-terminal-listings.ts --limit 25 --apply # aplica um lote
 *   npx tsx scripts/reenable-false-terminal-listings.ts --user-id <id> --apply
 *   npx tsx scripts/reenable-false-terminal-listings.ts --apply            # todos
 *
 * O cron processa LISTING_RETRY_BATCH (default 25) por passada, a cada 60s,
 * com trava de reentrância — então reabilitar em massa não gera avalanche: a
 * fila drena em ritmo controlado.
 */

import prisma from "../app/lib/prisma";
import { Prisma } from "@prisma/client";

const FALSE_TERMINAL_PREFIX = "[TERMINAL] Produto sem preço";

interface Flags {
  apply: boolean;
  limit?: number;
  userId?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--limit") flags.limit = Number(argv[++i]);
    else if (arg === "--user-id") flags.userId = argv[++i];
  }
  return flags;
}

/** Só vítimas do bug, e só placeholders (nunca um anúncio real no ML). */
const baseWhere = (userId?: string): Prisma.ProductListingWhereInput => ({
  retryEnabled: false,
  lastError: { startsWith: FALSE_TERMINAL_PREFIX },
  externalListingId: { startsWith: "PENDING_" },
  ...(userId ? { product: { userId } } : {}),
});

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log(
    `Reabilitação de falsos-terminais — modo: ${flags.apply ? "APPLY (escreve)" : "DRY-RUN (não escreve)"}`,
  );
  if (flags.userId) console.log(`Filtro: userId = ${flags.userId}`);
  if (flags.limit) console.log(`Lote: ${flags.limit}`);

  // Panorama: quantos são, e quantos o filtro de segurança exclui.
  const total = await prisma.productListing.count({
    where: {
      retryEnabled: false,
      lastError: { startsWith: FALSE_TERMINAL_PREFIX },
      ...(flags.userId ? { product: { userId: flags.userId } } : {}),
    },
  });
  const comIdReal = await prisma.productListing.count({
    where: {
      retryEnabled: false,
      lastError: { startsWith: FALSE_TERMINAL_PREFIX },
      NOT: { externalListingId: { startsWith: "PENDING_" } },
      ...(flags.userId ? { product: { userId: flags.userId } } : {}),
    },
  });

  console.log(`\nFalsos-terminais no total: ${total}`);
  console.log(
    `  EXCLUÍDOS por apontarem anúncio real (risco de duplicata): ${comIdReal}`,
  );

  // Candidatos: aplica o filtro de dados do produto em memória, porque
  // `price > 0` sobre Decimal é mais legível aqui do que no where.
  const rows = await prisma.productListing.findMany({
    where: baseWhere(flags.userId),
    select: {
      id: true,
      externalListingId: true,
      retryAttempts: true,
      product: {
        select: { sku: true, price: true, stock: true, userId: true },
      },
    },
    orderBy: { updatedAt: "asc" },
    ...(flags.limit ? { take: flags.limit } : {}),
  });

  const elegiveis = rows.filter((r) => {
    const price = r.product?.price ? Number(r.product.price) : 0;
    const stock = r.product?.stock ?? 0;
    return price > 0 && stock > 0;
  });
  const semDados = rows.length - elegiveis.length;

  console.log(`  EXCLUÍDOS por preço/estoque realmente inválidos: ${semDados}`);
  console.log(`\n>>> A REABILITAR: ${elegiveis.length}`);

  if (elegiveis.length === 0) {
    console.log("\nNada a fazer.");
    return;
  }

  console.log("\nAmostra (até 10):");
  for (const r of elegiveis.slice(0, 10)) {
    console.log(
      `  ${r.id}  sku=${r.product?.sku}  preço=${Number(r.product?.price)}  ` +
        `estoque=${r.product?.stock}  tentativas_gastas=${r.retryAttempts}`,
    );
  }

  if (!flags.apply) {
    console.log(
      `\nDRY-RUN: nada foi gravado. Para aplicar: --apply (use --limit para um lote menor).`,
    );
    return;
  }

  // Escreve em chunks: updateMany por id, sem transação longa (evita
  // idle_in_transaction e não segura conexão do pooler).
  const ids = elegiveis.map((r) => r.id);
  const CHUNK = 100;
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const res = await prisma.productListing.updateMany({
      where: { id: { in: slice } },
      data: {
        retryEnabled: true,
        retryAttempts: 0,
        nextRetryAt: new Date(),
        lastError: null,
      },
    });
    updated += res.count;
    console.log(`  ...${updated}/${ids.length}`);
  }

  console.log(`\n✓ Reabilitados: ${updated}`);
  console.log(
    `O cron processa ${process.env.LISTING_RETRY_BATCH || 25} por passada (60s), ` +
      `com trava de reentrância. Acompanhe com scripts/audit-listing-price.ts.`,
  );
}

main()
  .catch((err) => {
    console.error("Falha:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
