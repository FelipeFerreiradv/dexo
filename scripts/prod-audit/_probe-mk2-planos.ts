import "../lib/load-env";
/**
 * Sonda descartavel: planos REAIS das consultas que o diff da gaveta toca.
 * Read-only — so SELECT/EXPLAIN de SELECT. Nunca EXPLAIN de UPDATE.
 */
import { prisma, section, sub, withPrisma } from "./shared";

const OWNER = "cmrpbpswr0e6i18ncc97fv4ec";

async function plano(rotulo: string, sql: string, params: unknown[]) {
  const linhas = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + sql,
    ...params,
  );
  console.log("\n--- " + rotulo + " ---");
  for (const l of linhas) console.log("   " + Object.values(l)[0]);
}

async function main() {
  const caixas = await prisma.location.findMany({
    where: {
      userId: OWNER,
      code: { in: ["P1-ACABAMENTODIVERSOS", "1P2CX102", "1P1 CX102"] },
    },
    select: { id: true, code: true },
  });
  section("CAIXAS DE TESTE");
  for (const c of caixas) sub(c.code, c.id);

  const grande = caixas.find((c) => c.code === "P1-ACABAMENTODIVERSOS")!;
  const media = caixas.find((c) => c.code === "1P2CX102")!;

  const SEL =
    'SELECT id, sku, name, "imageUrl", stock, price, location FROM "Product" ' +
    'WHERE "locationId" = $1 AND "userId" = $2 ';

  section("GAVETA — PAGINA 1 (o que a tela SEMPRE fez)");
  await plano(
    "ANTES: ORDER BY name ASC",
    SEL + "ORDER BY name ASC OFFSET 0 LIMIT 50",
    [media.id, OWNER],
  );
  await plano(
    "DEPOIS: ORDER BY name ASC, id ASC (desempate)",
    SEL + "ORDER BY name ASC, id ASC OFFSET 0 LIMIT 50",
    [media.id, OWNER],
  );

  section("GAVETA — PAGINA PROFUNDA na caixa de 4.067 (OFFSET 4000)");
  await plano(
    "DEPOIS: OFFSET 4000 LIMIT 50",
    SEL + "ORDER BY name ASC, id ASC OFFSET 4000 LIMIT 50",
    [grande.id, OWNER],
  );

  section("SNAPSHOT DE ORIGEM (groupBy novo, antes do updateMany)");
  const amostra = await prisma.product.findMany({
    where: { userId: OWNER, locationId: media.id },
    select: { id: true },
    take: 50,
  });
  const ids = amostra.map((a) => a.id);
  await plano(
    "groupBy locationId,location WHERE id = ANY($1) — 50 ids",
    'SELECT "locationId", location, count(*) FROM "Product" ' +
      'WHERE id = ANY($1::text[]) AND "userId" = $2 GROUP BY 1,2',
    [ids, OWNER],
  );

  section("INDICES EXISTENTES EM Product");
  const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Product' ORDER BY indexname`,
  );
  for (const i of idx) console.log("   " + i.indexname + " :: " + i.indexdef);
}

if (require.main === module) {
  withPrisma(main)
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(2); });
}
