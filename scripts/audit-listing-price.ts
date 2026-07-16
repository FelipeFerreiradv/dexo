/**
 * Auditoria read-only do estado de preço/retry dos anúncios.
 *
 * Motivação: o guard de `listing-retry.service.ts` compara
 * `typeof product.price === "number"` sobre um `Product` cru do Prisma, onde
 * `price` é `Decimal` (typeof === "object"). O guard reprova SEMPRE, e todo
 * candidato de retry do ML foi marcado com
 * `[TERMINAL] Produto sem preço (price=0)` + `retryEnabled=false` — uma
 * mensagem falsa que ainda sobrescreve o `lastError` real (ex.: family_name).
 *
 * Este script mede o tamanho do problema ANTES de qualquer correção:
 *   1. Falsos-terminais: quantos anúncios foram desligados pela mensagem falsa.
 *   2. Fila viva: quantos candidatos o guard corrigido passará a processar de
 *      verdade (dimensiona o risco do deploy).
 *   3. `priceOverride = 0`: se existe override zerado persistido (que vira
 *      `price: 0` no payload do ML).
 *
 * O que faz: somente SELECT (via $queryRaw agregado + amostras pequenas).
 * O que NÃO faz: nunca escreve no banco, nunca chama a API do ML.
 *
 * Uso:
 *   npx tsx scripts/audit-listing-price.ts
 *   npx tsx scripts/audit-listing-price.ts --user-id <dataOwnerId>
 */

import prisma from "../app/lib/prisma";

interface Flags {
  userId?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--user-id") flags.userId = argv[++i];
  }
  return flags;
}

const FALSE_TERMINAL_PREFIX = "[TERMINAL] Produto sem preço";

type TenantCount = { userId: string; email: string | null; total: number };

async function countFalseTerminals(userId?: string): Promise<TenantCount[]> {
  return prisma.$queryRaw<TenantCount[]>`
    SELECT p."userId", u."email", COUNT(*)::int AS total
    FROM "ProductListing" pl
    JOIN "Product" p ON p.id = pl."productId"
    LEFT JOIN "User" u ON u.id = p."userId"
    WHERE pl."retryEnabled" = false
      AND pl."lastError" LIKE ${FALSE_TERMINAL_PREFIX + "%"}
      AND (${userId ?? null}::text IS NULL OR p."userId" = ${userId ?? null})
    GROUP BY p."userId", u."email"
    ORDER BY total DESC
  `;
}

/** Fila que o guard corrigido passará a processar de fato. */
async function countLiveQueue(userId?: string): Promise<TenantCount[]> {
  return prisma.$queryRaw<TenantCount[]>`
    SELECT p."userId", u."email", COUNT(*)::int AS total
    FROM "ProductListing" pl
    JOIN "Product" p ON p.id = pl."productId"
    LEFT JOIN "User" u ON u.id = p."userId"
    WHERE pl."retryEnabled" = true
      AND (pl."nextRetryAt" <= NOW() OR pl."nextRetryAt" IS NULL)
      AND (${userId ?? null}::text IS NULL OR p."userId" = ${userId ?? null})
    GROUP BY p."userId", u."email"
    ORDER BY total DESC
  `;
}

async function countZeroPriceOverrides(userId?: string): Promise<TenantCount[]> {
  return prisma.$queryRaw<TenantCount[]>`
    SELECT p."userId", u."email", COUNT(*)::int AS total
    FROM "ProductListing" pl
    JOIN "Product" p ON p.id = pl."productId"
    LEFT JOIN "User" u ON u.id = p."userId"
    WHERE pl."priceOverride" = 0
      AND (${userId ?? null}::text IS NULL OR p."userId" = ${userId ?? null})
    GROUP BY p."userId", u."email"
    ORDER BY total DESC
  `;
}

/**
 * Amostra de falsos-terminais: mostra o preço REAL do produto. Se price > 0,
 * a mensagem "[TERMINAL] Produto sem preço (price=0)" era comprovadamente falsa.
 */
async function sampleFalseTerminals(userId?: string) {
  return prisma.productListing.findMany({
    where: {
      retryEnabled: false,
      lastError: { startsWith: FALSE_TERMINAL_PREFIX },
      ...(userId ? { product: { userId } } : {}),
    },
    select: {
      id: true,
      externalListingId: true,
      status: true,
      retryAttempts: true,
      updatedAt: true,
      product: { select: { sku: true, price: true, stock: true, partNumber: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });
}

const sum = (rows: TenantCount[]) => rows.reduce((acc, r) => acc + r.total, 0);

function printTenants(title: string, rows: TenantCount[]) {
  console.log(`\n=== ${title} — total: ${sum(rows)} ===`);
  if (rows.length === 0) {
    console.log("  (nenhum)");
    return;
  }
  for (const r of rows) {
    console.log(`  ${r.total.toString().padStart(6)}  ${r.email ?? "(sem email)"}  [${r.userId}]`);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  console.log("Auditoria read-only de preço/retry de anúncios (nenhuma escrita)");
  if (flags.userId) console.log(`Filtro: userId = ${flags.userId}`);

  const [falseTerminals, liveQueue, zeroOverrides, sample] = await Promise.all([
    countFalseTerminals(flags.userId),
    countLiveQueue(flags.userId),
    countZeroPriceOverrides(flags.userId),
    sampleFalseTerminals(flags.userId),
  ]);

  printTenants(
    "1. Falsos-terminais (desligados pela mensagem falsa de preço)",
    falseTerminals,
  );
  printTenants(
    "2. Fila viva (o guard corrigido vai processar de verdade)",
    liveQueue,
  );
  printTenants("3. priceOverride = 0 persistido", zeroOverrides);

  console.log("\n=== Amostra de falsos-terminais (preço real do produto) ===");
  if (sample.length === 0) {
    console.log("  (nenhum)");
  }
  for (const l of sample) {
    const price = l.product?.price ? Number(l.product.price) : null;
    const veredito =
      price !== null && price > 0
        ? `FALSO POSITIVO (preço real = ${price})`
        : `preço realmente <= 0 (${price})`;
    console.log(
      `  ${l.id}  sku=${l.product?.sku ?? "?"}  stock=${l.product?.stock}  ` +
        `pn=${l.product?.partNumber ?? "(vazio)"}  tentativas=${l.retryAttempts}  → ${veredito}`,
    );
  }

  console.log("\n--- Leitura dos números ---");
  console.log(
    `Fila viva = ${sum(liveQueue)} candidatos. Cada um faz ~13-23 chamadas ao ML ` +
      `numa passada (dimensiona o risco do deploy do guard corrigido).`,
  );
  console.log(
    `Falsos-terminais = ${sum(falseTerminals)} anúncios parados. NÃO voltam sozinhos ` +
      `(retryEnabled=false fica fora do where). Re-habilitar é decisão separada.`,
  );
  console.log(
    `priceOverride=0 = ${sum(zeroOverrides)}. Se 0, a normalização é blindagem (no-op em produção).`,
  );
}

main()
  .catch((err) => {
    console.error("Falha na auditoria:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
