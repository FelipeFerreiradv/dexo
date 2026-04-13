/**
 * Atualiza heightCm/widthCm/lengthCm/weightKg dos Products locais
 * que estão linkados a um ProductListing ML ativo, usando o mapa de defaults.
 *
 * Lê: scripts/out/ml-dims-audit.json
 * Saída:
 *   - scripts/out/local-dim-update-plan.csv (sempre)
 *   - scripts/out/local-dim-update-result.csv (apenas com APPLY=1)
 *
 * Modos:
 *   npx tsx scripts/_update_local_product_dims.ts          -> DRY-RUN
 *   APPLY=1 npx tsx scripts/_update_local_product_dims.ts  -> grava
 *
 * Política:
 *  - SÓ atualiza Product cujo heightCm/widthCm/lengthCm/weightKg estejam TODOS NULL.
 *    Isso protege produtos que o usuário já mediu manualmente.
 *  - Se houver vários ProductListing apontando para o mesmo Product, usamos o
 *    primeiro item ML cujo title resolva ao tier mais "robusto" (maior weightKg) — abordagem
 *    conservadora: prefere o tier maior se houver divergência.
 *  - Atualizações em lotes; cada produto numa única update.
 */
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { resolveDim } from "./_ml_dim_defaults";

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const APPLY = process.env.APPLY === "1";

interface AuditRow {
  itemId: string;
  account: string;
  title: string;
  category: string;
}

async function main() {
  const auditPath = path.join("scripts", "out", "ml-dims-audit.json");
  const rows: AuditRow[] = JSON.parse(fs.readFileSync(auditPath, "utf-8"));
  console.log(`[local-dims] modo=${APPLY ? "APPLY" : "DRY-RUN"} · ${rows.length} linhas auditadas`);

  // Buscar todos os ProductListing ML do usuário com Product
  const listings = await prisma.productListing.findMany({
    where: {
      marketplaceAccount: { userId: USER_ID, platform: "MERCADO_LIVRE" },
    },
    select: {
      externalListingId: true,
      product: {
        select: { id: true, sku: true, heightCm: true, widthCm: true, lengthCm: true, weightKg: true },
      },
    },
  });
  console.log(`[local-dims] ProductListings ML carregados: ${listings.length}`);

  const productByExternal = new Map<string, (typeof listings)[number]["product"]>();
  for (const l of listings) productByExternal.set(l.externalListingId, l.product);

  // Para cada Product, escolher o "tier mais pesado" entre seus listings (proteção contra divergência)
  type Choice = { productId: string; height: number; width: number; length: number; weightKg: number; source: string; itemRef: string };
  const choiceByProduct = new Map<string, Choice>();
  let noListingMatch = 0;

  for (const r of rows) {
    const prod = productByExternal.get(r.itemId);
    if (!prod) {
      noListingMatch++;
      continue;
    }
    const dim = resolveDim(r.category, r.title);
    const cur = choiceByProduct.get(prod.id);
    if (!cur || dim.weightKg > cur.weightKg) {
      choiceByProduct.set(prod.id, {
        productId: prod.id,
        height: dim.heightCm,
        width: dim.widthCm,
        length: dim.lengthCm,
        weightKg: dim.weightKg,
        source: dim.source,
        itemRef: r.itemId,
      });
    }
  }
  console.log(`[local-dims] Products distintos a considerar: ${choiceByProduct.size}`);
  console.log(`[local-dims] Linhas sem ProductListing local (órfãos): ${noListingMatch}`);

  // Filtrar: só atualizar quem tem TODAS as dims null (não sobrescrever medidas manuais)
  const toUpdate: Choice[] = [];
  let alreadyHasSomeDim = 0;
  for (const choice of choiceByProduct.values()) {
    const prodLite = listings.find((l) => l.product.id === choice.productId)?.product;
    if (!prodLite) continue;
    const hasAny =
      prodLite.heightCm != null ||
      prodLite.widthCm != null ||
      prodLite.lengthCm != null ||
      prodLite.weightKg != null;
    if (hasAny) {
      alreadyHasSomeDim++;
      continue;
    }
    toUpdate.push(choice);
  }
  console.log(`[local-dims] Products com pelo menos uma dim já preenchida (NÃO mexer): ${alreadyHasSomeDim}`);
  console.log(`[local-dims] Products a atualizar: ${toUpdate.length}`);

  // Distribuição por tier
  const byTier: Record<string, number> = {};
  for (const c of toUpdate) {
    const tier = c.source.split(":").pop() || "unknown";
    byTier[tier] = (byTier[tier] || 0) + 1;
  }
  console.log("[local-dims] Distribuição por tier:", byTier);

  // CSV plano
  fs.mkdirSync(path.join("scripts", "out"), { recursive: true });
  const planPath = path.join("scripts", "out", "local-dim-update-plan.csv");
  const headers = ["productId", "h", "w", "l", "weightKg", "source", "itemRef"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const c of toUpdate) {
    lines.push([c.productId, c.height, c.width, c.length, c.weightKg, c.source, c.itemRef].map(esc).join(","));
  }
  fs.writeFileSync(planPath, lines.join("\n"));
  console.log(`Plano salvo em ${planPath}`);

  if (!APPLY) {
    console.log("\nDRY-RUN: nada gravado. Rode com APPLY=1 para aplicar.");
    process.exit(0);
  }

  // ===== APPLY =====
  console.log("\n=== APPLY ===");
  let ok = 0, fail = 0;
  const result: Array<Choice & { error?: string }> = [];
  const BATCH = 100;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const slice = toUpdate.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (c) => {
        try {
          await prisma.product.update({
            where: { id: c.productId },
            data: {
              heightCm: c.height,
              widthCm: c.width,
              lengthCm: c.length,
              weightKg: new Prisma.Decimal(c.weightKg),
            },
          });
          ok++;
          result.push(c);
        } catch (e: any) {
          fail++;
          result.push({ ...c, error: e?.message || String(e) });
          console.error(`[local-dims] FALHA productId=${c.productId}: ${e?.message}`);
        }
      }),
    );
    if ((i + BATCH) % 1000 === 0) console.log(`[local-dims] progresso: ${i + BATCH}/${toUpdate.length}`);
  }
  const resultPath = path.join("scripts", "out", "local-dim-update-result.csv");
  const resLines = [[...headers, "error"].join(",")];
  for (const r of result) resLines.push([r.productId, r.height, r.width, r.length, r.weightKg, r.source, r.itemRef, (r as any).error].map(esc).join(","));
  fs.writeFileSync(resultPath, resLines.join("\n"));
  console.log(`Resultado em ${resultPath}`);
  console.log(`Resumo: ok=${ok}, fail=${fail}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
