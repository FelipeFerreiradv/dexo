/** READ-ONLY: estado atual dos 50 produtos do lote faseado (pós-execução). */
import "dotenv/config";
import fs from "fs";
import path from "path";
import prisma from "@/app/lib/prisma";

async function main() {
  const dir = path.resolve(__dirname, "out");
  const file = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("legacy-cleanup-progress-"))
    .sort()
    .pop();
  if (!file) throw new Error("nenhum progress jsonl");
  const ids = fs
    .readFileSync(path.join(dir, file), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).productId as string);
  console.log(`Lote: ${file}  (${ids.length} produtos)`);

  const stillExist = await prisma.product.count({ where: { id: { in: ids } } });
  console.log(`Produtos ainda existentes no banco: ${stillExist}/${ids.length}`);

  const listings = await prisma.productListing.findMany({
    where: { productId: { in: ids } },
    select: { status: true, marketplaceAccount: { select: { platform: true } } },
  });
  const byPlatStatus = new Map<string, number>();
  for (const l of listings) {
    const k = `${l.marketplaceAccount?.platform ?? "?"} / ${l.status}`;
    byPlatStatus.set(k, (byPlatStatus.get(k) ?? 0) + 1);
  }
  console.log("Anúncios locais (platform / status):");
  console.table(Object.fromEntries([...byPlatStatus.entries()].sort()));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
