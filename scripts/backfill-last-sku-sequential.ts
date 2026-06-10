import prisma from "../app/lib/prisma";
import { computeMaxNumericSku } from "../app/repositories/product.repository";

// Override explícito para usuários cuja sequência humana NÃO bate com o
// max(numérico ≤ 6 dígitos) por causa de importação de códigos externos.
// Reunir aqui em vez de heurística porque o caso é raro e específico.
const OVERRIDES: Record<string, { value: number; reason: string }> = {
  "cmn5yc4rn0000vsasmwv9m8nc": {
    value: 32762,
    reason: "Leonardo (JOTABÊ): importação de março/abril 2026 inclui códigos 80xxx, 90xxx, 100xxx que inflam o cálculo automático",
  },
};

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, lastSkuSequential: true },
  });
  console.log(`Total users: ${users.length}\n`);

  let touched = 0;
  for (const u of users) {
    const override = OVERRIDES[u.id];
    let value: number;
    let source: string;

    if (override) {
      value = override.value;
      source = `OVERRIDE (${override.reason})`;
    } else {
      const skus = await prisma.product.findMany({
        where: { userId: u.id },
        select: { sku: true },
      });
      if (skus.length === 0) {
        console.log(`[SKIP]      ${u.email}  (sem produtos)`);
        continue;
      }
      value = computeMaxNumericSku(skus.map((p) => p.sku));
      source = `CALC (max numérico ≤6dig de ${skus.length} produtos)`;
    }

    if (value <= 0) {
      console.log(`[SKIP-ZERO] ${u.email}  (max=0, nenhum SKU sequencial encontrado)`);
      continue;
    }

    if (u.lastSkuSequential === value) {
      console.log(`[NOOP]      ${u.email}  já em ${value}`);
      continue;
    }

    await prisma.user.update({
      where: { id: u.id },
      data: { lastSkuSequential: value },
    });
    console.log(`[SET]       ${u.email}  ${u.lastSkuSequential ?? "null"} → ${value}  ${source}`);
    touched++;
  }

  console.log(`\nDone. ${touched} user(s) atualizados.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
