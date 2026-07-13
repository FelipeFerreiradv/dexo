import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

/**
 * Backfill do campo TEXTO `Product.location` para produtos que JÁ têm o
 * vínculo `locationId` mas o texto vazio (ex.: linkados pelo
 * link-product-locations antes dele preencher os dois). O texto exibido na UI
 * (lista/card/edição) vira o CAMINHO COMPLETO da localização (cadeia de
 * parentId, ex.: "GALPÃO 1 > ANDAR - 2 > VARÃO-1"), igual ao
 * enrichLocationFullPaths do app.
 *
 * Só toca em produtos com `locationId != null` E `location` null/vazio.
 * NUNCA sobrescreve texto existente. Idempotente.
 *
 *   npx tsx scripts/fill-location-text.ts --user-id=<ID> --dry-run
 *   npx tsx scripts/fill-location-text.ts --user-id=<ID> --apply
 */

const OUT_DIR = path.resolve(__dirname, "out");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run") || !apply;
  const userId = argv.find((a) => a.startsWith("--user-id="))?.split("=")[1] ?? "";
  if (!userId) throw new Error("Informe --user-id=<cuid>. Abortando.");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new Error(`Usuário ${userId} não encontrado.`);
  console.log(`[fill-loc-text] user=${user.email} modo=${dryRun ? "DRY-RUN" : "APPLY"}`);

  // Locations do user → caminho completo por id (cadeia de parentId).
  const locs = await prisma.location.findMany({
    where: { userId },
    select: { id: true, code: true, parentId: true },
  });
  const byId = new Map(locs.map((l) => [l.id, l]));
  const pathCache = new Map<string, string>();
  const buildPath = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached !== undefined) return cached;
    const parts: string[] = [];
    let cur: string | null = id;
    let guard = 0;
    while (cur && guard++ < 25) {
      const node = byId.get(cur);
      if (!node) break;
      parts.unshift(node.code);
      cur = node.parentId;
    }
    // code já costuma ser o caminho completo (locations flat); a cadeia cobre árvores.
    const full = parts.join(" > ");
    // Se o code do nó folha já contém o caminho ("A > B > C"), usa só ele.
    const leaf = byId.get(id)?.code ?? "";
    const result = leaf.includes(" > ") ? leaf : full || leaf;
    pathCache.set(id, result);
    return result;
  };

  // Produtos com FK e texto vazio.
  const products = await prisma.product.findMany({
    where: {
      userId,
      locationId: { not: null },
      OR: [{ location: null }, { location: "" }],
    },
    select: { id: true, locationId: true },
  });
  console.log(`[fill-loc-text] locations=${locs.length} | produtos com FK e texto vazio: ${products.length}`);

  // Agrupa por locationId → 1 updateMany por localização.
  const byLoc = new Map<string, string[]>();
  for (const p of products) {
    (byLoc.get(p.locationId!) ?? byLoc.set(p.locationId!, []).get(p.locationId!)!).push(p.id);
  }

  const sum = { candidatos: products.length, atualizados: 0, sem_path: 0, errors: 0 };
  let done = 0;
  for (const [locId, ids] of byLoc) {
    const text = buildPath(locId);
    if (!text) {
      sum.sem_path += ids.length;
      continue;
    }
    if (dryRun) {
      sum.atualizados += ids.length;
    } else {
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        try {
          const r = await prisma.product.updateMany({
            where: { id: { in: slice }, userId, OR: [{ location: null }, { location: "" }] },
            data: { location: text },
          });
          sum.atualizados += r.count;
        } catch {
          sum.errors += slice.length;
        }
      }
    }
    if (++done % 300 === 0) console.log(`[fill-loc-text] ${done}/${byLoc.size} locations | atualizados=${sum.atualizados}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUT_DIR, `fill-location-text-${userId}-${stamp}.json`),
    JSON.stringify({ userId, mode: dryRun ? "dry-run" : "apply", ...sum }, null, 2),
    "utf8",
  );

  console.log("\n===== RESUMO — preencher texto de localização =====");
  console.log(`modo: ${dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  produtos com FK e texto vazio: ${sum.candidatos}`);
  console.log(`  ${dryRun ? "a atualizar" : "ATUALIZADOS"}:                 ${sum.atualizados}`);
  console.log(`  sem path resolvível:           ${sum.sem_path}`);
  console.log(`  erros:                         ${sum.errors}`);
  console.log("===================================================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[fill-loc-text][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
