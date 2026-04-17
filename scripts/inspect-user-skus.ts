import prisma from "../app/lib/prisma";

const TARGET_USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";

const CURRENT_REGEX = /^(?:PROD-)?(\d+)$/;
const PROPOSED_REGEX = /^(?:PROD-)?(\d{1,9})$/;

async function main() {
  const products = await prisma.product.findMany({
    where: { userId: TARGET_USER_ID },
    select: { id: true, sku: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Total de produtos do usuário: ${products.length}\n`);

  let matchesCurrent = 0;
  let matchesProposed = 0;
  let maxCurrent = 0;
  let maxCurrentUnsafe: { sku: string; parsed: number } | null = null;
  let maxProposed = 0;
  const suspects: Array<{ sku: string; digits: number }> = [];

  for (const { sku } of products) {
    if (!sku) continue;

    const mCurrent = sku.match(CURRENT_REGEX);
    if (mCurrent) {
      matchesCurrent++;
      const n = parseInt(mCurrent[1], 10);
      if (Number.isFinite(n) && n > maxCurrent) maxCurrent = n;
      if (!Number.isSafeInteger(n)) {
        if (!maxCurrentUnsafe || n > maxCurrentUnsafe.parsed) {
          maxCurrentUnsafe = { sku, parsed: n };
        }
      }
      if (mCurrent[1].length > 9) {
        suspects.push({ sku, digits: mCurrent[1].length });
      }
    }

    const mProposed = sku.match(PROPOSED_REGEX);
    if (mProposed) {
      matchesProposed++;
      const n = parseInt(mProposed[1], 10);
      if (Number.isSafeInteger(n) && n > maxProposed) maxProposed = n;
    }
  }

  console.log("=== Regex atual /^(?:PROD-)?(\\d+)$/ ===");
  console.log(`  SKUs que batem:        ${matchesCurrent}`);
  console.log(`  max (como number):     ${maxCurrent}`);
  console.log(`  max em string:         ${maxCurrent.toString()}`);
  console.log(`  nextSku simulado:      ${(maxCurrent + 1).toString().padStart(3, "0")}`);
  if (maxCurrentUnsafe) {
    console.log(`  !! SKU fora do safe integer: "${maxCurrentUnsafe.sku}" -> ${maxCurrentUnsafe.parsed}`);
  }

  console.log("\n=== Regex proposta /^(?:PROD-)?(\\d{1,9})$/ ===");
  console.log(`  SKUs que batem:        ${matchesProposed}`);
  console.log(`  max (safe):            ${maxProposed}`);
  console.log(`  nextSku simulado:      ${(maxProposed + 1).toString().padStart(3, "0")}`);

  console.log(`\n=== SKUs suspeitos (>9 dígitos, provavelmente códigos de barra) ===`);
  if (suspects.length === 0) {
    console.log("  (nenhum)");
  } else {
    console.log(`  total: ${suspects.length}`);
    for (const s of suspects.slice(0, 10)) {
      console.log(`  - ${s.sku} (${s.digits} dígitos)`);
    }
    if (suspects.length > 10) {
      console.log(`  ... e mais ${suspects.length - 10}`);
    }
  }
}

main()
  .catch((error) => {
    console.error("Falha ao inspecionar SKUs do usuário", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
