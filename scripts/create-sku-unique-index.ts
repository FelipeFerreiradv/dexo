import "dotenv/config";
import prisma from "../app/lib/prisma";

/**
 * Cria o índice único PARCIAL de identidade do produto:
 *   Product_userId_skuNormalized_key ON ("userId","skuNormalized")
 *   WHERE "skuNormalized" IS NOT NULL AND "skuNormalized" <> ''
 *
 * Existe porque a unique do schema é sobre o SKU CRU — "mk2-204" e "Mk2-204"
 * conviviam como dois produtos sem violar constraint nenhuma. Ver
 * docs/dedupe-sku-sql.md para o contexto completo.
 *
 * Por que um script e não `psql`: o servidor de produção não tem o cliente
 * postgres instalado, e o Prisma já tem a conexão. `CONCURRENTLY` NÃO pode
 * rodar dentro de transação — por isso usamos `$executeRawUnsafe` direto
 * (statement solto), nunca `$transaction`.
 *
 * PRÉ-REQUISITO: rodar antes `dedupe-products-by-normalized-sku.ts --apply`.
 * Com duplicata pré-existente o índice falha (e é isso que queremos: falhar
 * em vez de mascarar).
 *
 *   npx tsx scripts/create-sku-unique-index.ts            # verifica e cria
 *   npx tsx scripts/create-sku-unique-index.ts --check    # só diagnostica
 */

const INDEX = "Product_userId_skuNormalized_key";

async function duplicatasRestantes(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT 1 FROM "Product"
       WHERE "skuNormalized" IS NOT NULL AND "skuNormalized" <> ''
       GROUP BY "userId","skuNormalized" HAVING COUNT(*) > 1
     ) d`,
  );
  return rows[0]?.n ?? 0;
}

/** Índice inválido = tentativa anterior de CONCURRENTLY que falhou no meio. */
async function estado(): Promise<"ausente" | "valido" | "invalido"> {
  const rows = await prisma.$queryRawUnsafe<Array<{ valido: boolean }>>(
    `SELECT i.indisvalid AS valido
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1`,
    INDEX,
  );
  if (rows.length === 0) return "ausente";
  return rows[0].valido ? "valido" : "invalido";
}

async function main(): Promise<void> {
  const apenasCheck = process.argv.slice(2).includes("--check");

  const atual = await estado();
  console.log(`Índice ${INDEX}: ${atual}`);

  if (atual === "valido") {
    console.log("Nada a fazer — já está criado e válido.");
    return;
  }

  if (atual === "invalido") {
    console.log(
      `\nO índice existe mas está INVÁLIDO (um CONCURRENTLY anterior falhou).\n` +
        `Ele não protege nada nesse estado. Remova e rode este script de novo:\n` +
        `  DROP INDEX CONCURRENTLY "${INDEX}";`,
    );
    return;
  }

  const dups = await duplicatasRestantes();
  console.log(`Grupos duplicados por (userId, skuNormalized): ${dups}`);
  if (dups > 0) {
    console.log(
      `\nABORTADO: existem ${dups} grupo(s) duplicado(s) — o índice falharia.\n` +
        `Rode antes:  npx tsx scripts/dedupe-products-by-normalized-sku.ts --apply`,
    );
    process.exitCode = 1;
    return;
  }

  if (apenasCheck) {
    console.log("\n--check: pronto para criar (nada foi executado).");
    return;
  }

  console.log("\nCriando o índice (CONCURRENTLY, sem travar escrita)...");
  // Sem $transaction de propósito: CONCURRENTLY é proibido dentro de uma.
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}"
       ON "Product"("userId","skuNormalized")
       WHERE "skuNormalized" IS NOT NULL AND "skuNormalized" <> ''`,
  );

  const depois = await estado();
  console.log(`Resultado: índice ${depois}`);
  if (depois !== "valido") {
    console.log(
      `\nATENÇÃO: o índice não ficou válido. Remova-o antes de tentar de novo:\n` +
        `  DROP INDEX CONCURRENTLY "${INDEX}";`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "OK — o banco passa a garantir um produto por (dono, SKU normalizado).",
    );
  }
}

main()
  .catch((e) => {
    console.error("ERRO:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
