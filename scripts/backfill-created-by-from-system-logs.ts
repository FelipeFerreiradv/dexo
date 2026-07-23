import prisma from "../app/lib/prisma";

/**
 * Backfill de `createdByUserId` (autor real do cadastro) em Product e
 * ProductListing a partir do SystemLog — os logs CREATE_PRODUCT/CREATE_LISTING
 * já gravam `userId` = ator (request.user.id, o colaborador que agiu) e
 * `resourceId` = id do registro criado.
 *
 * Garantias (zero regressão):
 * - Só grava onde `createdByUserId` está NULL (nunca sobrescreve autoria já
 *   registrada pelo caminho novo) e NÃO toca em nenhum outro campo.
 * - Idempotente: re-rodar processa só o que ainda falta.
 * - Usa o PRIMEIRO log por recurso (DISTINCT ON ... ORDER BY createdAt ASC) —
 *   autoria = quem criou, não quem mexeu depois.
 * - JOIN em "User": ignora logs de ator já excluído (não grava id órfão).
 * - Checagem de tenant: o registro precisa pertencer ao dataOwner do ator
 *   (COALESCE(parentUserId, id)) — descarta lixo cross-tenant de logs antigos.
 * - Registros sem log (imports em massa, autodetect, scripts, logs podados)
 *   permanecem NULL → UI segue exibindo "—".
 *
 * Uso:
 *   tsx scripts/backfill-created-by-from-system-logs.ts           # dry-run (só conta)
 *   tsx scripts/backfill-created-by-from-system-logs.ts --apply   # grava de fato
 */

const apply = process.argv.includes("--apply");

// CTEs compartilhadas entre count (dry-run) e UPDATE (apply) — mesma seleção,
// zero divergência entre o que é contado e o que é gravado.
const PRODUCT_CAND = `
  WITH first_log AS (
    SELECT DISTINCT ON ("resourceId") "resourceId", "userId"
      FROM "SystemLog"
     WHERE action = 'CREATE_PRODUCT'
       AND "resourceId" IS NOT NULL
       AND "userId" IS NOT NULL
     ORDER BY "resourceId", "createdAt" ASC
  ),
  cand AS (
    SELECT p.id AS target_id, s."userId" AS actor_id
      FROM first_log s
      JOIN "User" u ON u.id = s."userId"
      JOIN "Product" p ON p.id = s."resourceId"
     WHERE p."createdByUserId" IS NULL
       AND p."userId" = COALESCE(u."parentUserId", u.id)
  )`;

const LISTING_CAND = `
  WITH first_log AS (
    SELECT DISTINCT ON ("resourceId") "resourceId", "userId"
      FROM "SystemLog"
     WHERE action = 'CREATE_LISTING'
       AND "resourceId" IS NOT NULL
       AND "userId" IS NOT NULL
     ORDER BY "resourceId", "createdAt" ASC
  ),
  cand AS (
    SELECT l.id AS target_id, s."userId" AS actor_id
      FROM first_log s
      JOIN "User" u ON u.id = s."userId"
      JOIN "ProductListing" l ON l.id = s."resourceId"
      JOIN "Product" p ON p.id = l."productId"
     WHERE l."createdByUserId" IS NULL
       AND p."userId" = COALESCE(u."parentUserId", u.id)
  )`;

interface Cand {
  target_id: string;
  actor_id: string;
}

async function processEntity(
  label: string,
  table: '"Product"' | '"ProductListing"',
  cte: string,
) {
  const [{ n }] = await prisma.$queryRawUnsafe<[{ n: number }]>(
    `${cte} SELECT count(*)::int AS n FROM cand`,
  );
  console.log(`${label}: ${n} registro(s) com autor recuperável no SystemLog`);

  if (!apply) {
    const sample = await prisma.$queryRawUnsafe<Cand[]>(
      `${cte} SELECT target_id, actor_id FROM cand ORDER BY target_id LIMIT 10`,
    );
    if (sample.length > 0) {
      console.log("  Amostra (dry-run):");
      for (const row of sample) {
        console.log(`    ${row.target_id} → autor ${row.actor_id}`);
      }
    }
    return;
  }

  const affected = await prisma.$executeRawUnsafe(
    `${cte}
     UPDATE ${table} t
        SET "createdByUserId" = c.actor_id
       FROM cand c
      WHERE t.id = c.target_id`,
  );
  console.log(`  ✅ ${affected} registro(s) atualizados em ${table}.`);
}

async function run() {
  await processEntity("Produtos (CREATE_PRODUCT)", '"Product"', PRODUCT_CAND);
  await processEntity(
    "Anúncios (CREATE_LISTING)",
    '"ProductListing"',
    LISTING_CAND,
  );

  if (!apply) {
    console.log("\nRode com --apply para gravar.");
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
