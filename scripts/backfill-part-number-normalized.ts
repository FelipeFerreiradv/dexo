import prisma from "../app/lib/prisma";

/**
 * Backfill de `Product.partNumberNormalized` para produtos já existentes.
 *
 * Espelha a lógica do SKU (`normalizeSku` = trim().toLowerCase()) para que o
 * match exato-prioritário por part number encontre também os produtos antigos.
 *
 * Garantias (zero regressão):
 * - Só grava onde `partNumberNormalized` está `null` (nunca sobrescreve valor
 *   já preenchido) e NÃO toca em nenhum outro campo.
 * - Idempotente: re-rodar processa só o que ainda falta.
 * - Um único UPDATE em bulk (rápido mesmo com dezenas de milhares de linhas).
 *   A normalização `lower(trim(...))` é feita no próprio Postgres; part numbers
 *   que ficam vazios após trim são deixados como estão (sem valor útil).
 *
 * Uso:
 *   tsx scripts/backfill-part-number-normalized.ts           # dry-run (só conta)
 *   tsx scripts/backfill-part-number-normalized.ts --apply   # grava de fato
 */

const apply = process.argv.includes("--apply");

// Remove espaços/tabs/quebras das pontas e baixa a caixa — equivalente a
// normalizeSku no lado do banco. `\s` cobre a mesma faixa do .trim() do JS.
const NORM = `lower(regexp_replace("partNumber", '^\\s+|\\s+$', '', 'g'))`;

async function run() {
  const pending = await prisma.product.count({
    where: { partNumber: { not: null }, partNumberNormalized: null },
  });
  console.log(`Produtos com partNumber e sem normalizado: ${pending}`);

  if (!apply) {
    const sample = await prisma.product.findMany({
      where: { partNumber: { not: null }, partNumberNormalized: null },
      take: 10,
      orderBy: { id: "asc" },
      select: { id: true, partNumber: true },
    });
    console.log(
      "\nAmostra (dry-run):",
      sample.map((p) => p.partNumber),
    );
    console.log(`\nRode com --apply para gravar os ${pending}.`);
    return;
  }

  console.log("Aplicando UPDATE em bulk...");
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "Product"
       SET "partNumberNormalized" = ${NORM}
     WHERE "partNumber" IS NOT NULL
       AND "partNumberNormalized" IS NULL
       AND ${NORM} <> ''`,
  );

  const remaining = await prisma.product.count({
    where: { partNumber: { not: null }, partNumberNormalized: null },
  });
  console.log(`\n✅ ${affected} produto(s) normalizado(s).`);
  console.log(
    `Restam ${remaining} com partNumber sem normalizado (partNumber vazio/whitespace — sem valor útil).`,
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
