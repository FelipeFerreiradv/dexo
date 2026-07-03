import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import { chunk } from "../app/lib/chunk";

/**
 * Backfill de `Product.partNumberNormalized` para produtos já existentes.
 *
 * Espelha exatamente a lógica do SKU (`normalizeSku` = trim().toLowerCase()),
 * para que o match exato-prioritário por part number encontre também os
 * produtos antigos (cadastrados antes da coluna existir).
 *
 * Garantias (zero regressão):
 * - Só grava `partNumberNormalized` onde está `null` (nunca sobrescreve valor
 *   já preenchido) e NÃO toca em nenhum outro campo (`sku`/`skuNormalized`/
 *   `partNumber` ficam intactos).
 * - Idempotente: re-rodar só processa o que ainda falta.
 * - Paginado por cursor (id asc), em lote, para tabelas grandes.
 *
 * Uso:
 *   tsx scripts/backfill-part-number-normalized.ts           # dry-run (só conta)
 *   tsx scripts/backfill-part-number-normalized.ts --apply   # grava de fato
 */

const PAGE_SIZE = 500;
const TX_CHUNK = 100;

async function backfill(apply: boolean) {
  const pending = await prisma.product.count({
    where: { partNumber: { not: null }, partNumberNormalized: null },
  });

  if (!apply) {
    const sample = await prisma.product.findMany({
      where: { partNumber: { not: null }, partNumberNormalized: null },
      take: 10,
      orderBy: { id: "asc" },
      select: { id: true, partNumber: true },
    });
    return {
      mode: "dry-run" as const,
      pending,
      sample: sample.map((p) => ({
        id: p.id,
        partNumber: p.partNumber,
        willSet: normalizeSku(p.partNumber),
      })),
      updated: 0,
    };
  }

  // Percorre todos os produtos com partNumber (id asc, cursor) e grava o
  // normalizado apenas quando ainda está nulo. Usar o id como cursor garante
  // progresso para frente mesmo que algum partNumber normalize para null.
  let updated = 0;
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.product.findMany({
      where: { partNumber: { not: null } },
      take: PAGE_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, partNumber: true, partNumberNormalized: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    const updates = batch
      .filter((p) => p.partNumberNormalized === null)
      .map((p) =>
        prisma.product.update({
          where: { id: p.id },
          data: { partNumberNormalized: normalizeSku(p.partNumber) },
        }),
      );

    for (const group of chunk(updates, TX_CHUNK)) {
      await prisma.$transaction(group);
      updated += group.length;
    }
  }

  return { mode: "apply" as const, pending, updated };
}

const apply = process.argv.includes("--apply");

backfill(apply)
  .then((res) => {
    console.log("Backfill partNumberNormalized concluído", res);
    if (res.mode === "dry-run") {
      console.log(
        `\n${res.pending} produto(s) pendente(s). Rode com --apply para gravar.`,
      );
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
