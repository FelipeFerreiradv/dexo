/**
 * Diagnostico de categorias Shopee — para cada categoryId problematica
 * mostra a estrutura na arvore + lista de produtos do DB que usam.
 *
 * Uso:
 *   npm run shopee:debug-cats -- 100919 102187 102225 ...
 *   npm run shopee:debug-cats                   # lista as 11 conhecidas
 *
 * Para cada categoria:
 *  - Nome e path na arvore Shopee (root → ... → categoria)
 *  - Se eh folha ou nao (Shopee nao aceita add_item em nao-folha)
 *  - Subcategorias filhas (se houver) — sugestao de para onde re-categorizar
 *  - Produtos do DB que tem essa shopeeCategoryId (SKU + nome)
 */

import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { Platform } from "@prisma/client";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";

const KNOWN_PROBLEMATIC = [
  100919, 102187, 102225, 102226, 102231, 102232, 102239, 102240, 102243, 102244, 102249,
];

function parseIdsFromArgs(): number[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (args.length === 0) return KNOWN_PROBLEMATIC;
  const ids: number[] = [];
  for (const a of args) {
    const n = Number(a);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  return ids;
}

interface ShopeeCategoryNode {
  category_id: number;
  category_name: string;
  parent_category_id: number;
  has_children: boolean;
  display_category_name?: string;
  original_category_name?: string;
}

async function main() {
  const ids = parseIdsFromArgs();
  console.log(`[debug-cats] analisando ${ids.length} categoria(s): ${ids.join(", ")}\n`);

  const acct = await prisma.marketplaceAccount.findFirst({
    where: { platform: Platform.SHOPEE, status: "ACTIVE" },
  });
  if (!acct || !acct.accessToken || !acct.shopId) {
    throw new Error("Nenhuma conta Shopee ativa encontrada");
  }
  const shopId =
    typeof acct.shopId === "string" ? parseInt(acct.shopId) : (acct.shopId as number);
  console.log(`[debug-cats] usando shop ${shopId} (conta ${acct.id})\n`);

  const resp = await ShopeeApiService.getCategories(acct.accessToken, shopId, "pt-BR");
  const list = (resp.category_list ?? []) as unknown as ShopeeCategoryNode[];

  // Indices: id → node, parentId → children[]
  const byId = new Map<number, ShopeeCategoryNode>();
  for (const c of list) byId.set(c.category_id, c);

  const childrenOf = new Map<number, ShopeeCategoryNode[]>();
  for (const c of list) {
    const pid = c.parent_category_id;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(c);
  }

  const getName = (c: ShopeeCategoryNode): string =>
    c.display_category_name ||
    c.category_name ||
    c.original_category_name ||
    `Cat_${c.category_id}`;

  const buildPath = (c: ShopeeCategoryNode): string => {
    const parts: string[] = [];
    let cur: ShopeeCategoryNode | undefined = c;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.category_id)) {
      seen.add(cur.category_id);
      parts.unshift(getName(cur));
      if (cur.parent_category_id > 0) {
        cur = byId.get(cur.parent_category_id);
      } else {
        break;
      }
    }
    return parts.join(" > ");
  };

  for (const id of ids) {
    console.log(`\n========== ${id} ==========`);
    const node = byId.get(id);
    if (!node) {
      console.log(`  ❌ NAO ENCONTRADA na arvore Shopee atual`);
      console.log(`     Categoria provavelmente foi removida/renomeada pela Shopee.`);
    } else {
      const children = childrenOf.get(id) ?? [];
      const isLeaf = !node.has_children && children.length === 0;
      const path = buildPath(node);

      console.log(`  Nome: ${getName(node)}`);
      console.log(`  Path: ${path}`);
      console.log(`  Folha? ${isLeaf ? "✅ SIM" : `❌ NAO (${children.length} filhos)`}`);

      if (children.length > 0) {
        console.log(`  Sub-categorias (sugestoes de re-categorizacao):`);
        for (const ch of children.slice(0, 15)) {
          const chIsLeaf = !ch.has_children && !(childrenOf.get(ch.category_id)?.length ?? 0);
          console.log(
            `    - ${ch.category_id}  ${getName(ch)}  ${chIsLeaf ? "[folha ✓]" : "[tem filhos]"}`,
          );
        }
        if (children.length > 15) {
          console.log(`    ... (+${children.length - 15} mais)`);
        }
      }
    }

    // Produtos do DB que usam essa categoryId
    const products = await prisma.product.findMany({
      where: { shopeeCategoryId: String(id) },
      select: { id: true, sku: true, name: true, brand: true, model: true, userId: true },
      take: 50,
      orderBy: { sku: "asc" },
    });
    console.log(`  Produtos do DB (${products.length}):`);
    for (const p of products) {
      const marca = [p.brand, p.model].filter(Boolean).join(" ");
      console.log(`    - SKU ${p.sku} (${p.id})  ${p.name}${marca ? `  [${marca}]` : ""}`);
    }
  }

  console.log("\n[debug-cats] DONE");
}

main()
  .catch((err) => {
    console.error("[debug-cats] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
