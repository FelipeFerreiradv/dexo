/**
 * Diagnostico DETALHADO de atributos de categoria Shopee.
 *
 * Chama get_attribute_tree CRU (sem o mapeamento que descarta campos) pra
 * cada categoria e imprime a estrutura completa de cada atributo MANDATORY,
 * recursivamente incluindo child_attribute_list (atributos-filho que se
 * tornam obrigatorios quando um valor-pai especifico eh selecionado).
 *
 * Objetivo: descobrir por que "Registration ID" (ou outro mandatory) eh
 * rejeitado — eh top-level? eh filho de algum valor que escolhemos? exige
 * INT? — pra desenhar o fix certo.
 *
 * Uso:
 *   npm run shopee:debug-attrs -- --product=<productId>   # resolve a categoria do produto
 *   npm run shopee:debug-attrs -- --category=102336       # categoria especifica
 *   npm run shopee:debug-attrs -- --user=<userId> --only-uncovered
 *   npm run shopee:debug-attrs -- --category=102336 --grep=registr  # acha attr por nome (em qualquer nivel)
 *   npm run shopee:debug-attrs -- --category=102336 --full          # dump completo recursivo
 */

import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { Platform } from "@prisma/client";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";

const LOCALE = "pt-BR";
const RATE_LIMIT_MS = 700;

const INPUT_TYPE_LABELS: Record<number, string> = {
  1: "SINGLE_DROP_DOWN",
  2: "SINGLE_COMBO_BOX",
  3: "FREE_TEXT_FIELD",
  4: "MULTI_DROP_DOWN",
  5: "MULTI_COMBO_BOX",
};
const VALIDATION_LABELS: Record<number, string> = {
  0: "NO_VALIDATE",
  1: "INT",
  2: "STRING",
  3: "FLOAT",
  4: "DATE",
};

// Espelha as chaves do productAttrValues em listing.usercase.ts (lowercase).
const COVERED_KEYS = new Set([
  "marca", "brand", "modelo", "model", "ano", "year",
  "número de referência", "numero de referencia", "part number",
  "reference number", "auto-part number", "auto part number",
  "número da peça", "numero da peca", "part number (oem)",
  "oem part number", "oem",
]);

interface RawAttrValue {
  value_id: number;
  name: string;
  value_unit?: string;
  child_attribute_list?: RawAttrNode[];
}
interface RawAttrNode {
  attribute_id: number;
  name: string;
  mandatory: boolean;
  attribute_value_list?: RawAttrValue[];
  attribute_info?: {
    input_type?: number;
    input_validation_type?: number;
    format_type?: number;
    attribute_unit_list?: string[];
    max_value_count?: number;
    introduction?: string;
  };
  support_search_value?: boolean;
  is_oem?: boolean;
}

function parseArgs() {
  let category: number | undefined;
  let user: string | undefined;
  let product: string | undefined;
  let grep: string | undefined;
  let onlyUncovered = false;
  let full = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--only-uncovered") onlyUncovered = true;
    else if (a === "--full") full = true;
    else {
      const [k, v] = a.replace(/^--/, "").split("=");
      if (k === "category" && v) category = Number(v);
      else if (k === "user" && v) user = v;
      else if (k === "product" && v) product = v;
      else if (k === "grep" && v) grep = v;
    }
  }
  return { category, user, product, grep, onlyUncovered, full };
}

function attrSummary(a: RawAttrNode): string {
  const it = a.attribute_info?.input_type;
  const ivt = a.attribute_info?.input_validation_type;
  const enumCount = a.attribute_value_list?.length ?? 0;
  return (
    `attr_id=${a.attribute_id} "${a.name}" ${a.mandatory ? "[MANDATORY]" : "[opcional]"} ` +
    `input_type=${it ?? "?"}(${it != null ? INPUT_TYPE_LABELS[it] ?? "?" : "?"}) ` +
    `validation=${ivt ?? "?"}(${ivt != null ? VALIDATION_LABELS[ivt] ?? "?" : "?"}) ` +
    `enum=${enumCount}${a.attribute_info?.max_value_count ? ` maxVals=${a.attribute_info.max_value_count}` : ""}` +
    `${a.is_oem ? " [is_oem]" : ""}`
  );
}

/**
 * Caminha a arvore recursivamente. Para cada no, chama visit com o caminho
 * (lista de "attr → valor" que levou ate ele).
 */
function walkTree(
  nodes: RawAttrNode[],
  visit: (node: RawAttrNode, path: string[]) => void,
  path: string[] = [],
) {
  for (const node of nodes) {
    visit(node, path);
    for (const v of node.attribute_value_list ?? []) {
      if (v.child_attribute_list && v.child_attribute_list.length > 0) {
        walkTree(v.child_attribute_list, visit, [
          ...path,
          `${node.name}=${v.name}`,
        ]);
      }
    }
  }
}

async function listCategories(
  category?: number,
  user?: string,
  product?: string,
): Promise<number[]> {
  if (product) {
    const p = await prisma.product.findUnique({
      where: { id: product },
      select: { shopeeCategoryId: true, name: true },
    });
    if (!p?.shopeeCategoryId) {
      throw new Error(`Produto ${product} sem shopeeCategoryId`);
    }
    console.log(
      `[debug-attrs] produto ${product} ("${p.name}") → categoria ${p.shopeeCategoryId}`,
    );
    return [Number(p.shopeeCategoryId)];
  }
  if (category) return [category];
  const rows = await prisma.product.findMany({
    where: {
      shopeeCategoryId: { not: null },
      ...(user ? { userId: user } : {}),
    },
    select: { shopeeCategoryId: true },
    distinct: ["shopeeCategoryId"],
  });
  const ids = new Set<number>();
  for (const r of rows) {
    const n = Number(r.shopeeCategoryId);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  }
  return [...ids].sort((a, b) => a - b);
}

async function fetchRawTree(
  accessToken: string,
  shopId: number,
  categoryId: number,
): Promise<RawAttrNode[]> {
  const path = `/api/v2/product/get_attribute_tree?category_id_list=${categoryId}&language=${LOCALE}`;
  const resp = await (ShopeeApiService as any).makeAuthenticatedRequest(
    "GET",
    path,
    accessToken,
    shopId,
  );
  if (resp?.error) {
    throw new Error(`${resp.error}: ${resp.message}`);
  }
  return resp?.response?.list?.[0]?.attribute_tree ?? [];
}

async function main() {
  const { category, user, product, grep, onlyUncovered, full } = parseArgs();
  const grepRe = grep ? new RegExp(grep, "i") : null;

  const acct = await prisma.marketplaceAccount.findFirst({
    where: { platform: Platform.SHOPEE, status: "ACTIVE" },
  });
  if (!acct?.accessToken || !acct?.shopId) {
    throw new Error("Nenhuma conta Shopee ativa");
  }
  const shopId =
    typeof acct.shopId === "string" ? parseInt(acct.shopId) : (acct.shopId as number);

  const categories = await listCategories(category, user, product);
  console.log(`[debug-attrs] ${categories.length} categoria(s), shop ${shopId}\n`);

  const uncoveredAttrs = new Map<string, Set<number>>();

  for (let i = 0; i < categories.length; i++) {
    const catId = categories[i];
    let tree: RawAttrNode[];
    try {
      tree = await fetchRawTree(acct.accessToken, shopId, catId);
    } catch (err) {
      console.log(`\n=== ${catId} === ERRO: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const lines: string[] = [];
    walkTree(tree, (node, path) => {
      const matchesGrep = grepRe ? grepRe.test(node.name) : false;
      const isChild = path.length > 0;
      const covered = COVERED_KEYS.has(node.name.toLowerCase());

      // Que imprimir:
      //  - --full: tudo
      //  - --grep: so quem casa
      //  - --only-uncovered: mandatory nao coberto (top-level OU filho)
      //  - default: mandatory (top-level OU filho)
      let show = false;
      if (full) show = true;
      else if (grepRe) show = matchesGrep;
      else if (onlyUncovered) show = node.mandatory && !covered;
      else show = node.mandatory;

      if (!show) return;

      const indent = "  ".repeat(path.length + 1);
      const flag = matchesGrep ? "🚩" : node.mandatory ? (covered ? "✓" : "✗") : "·";
      lines.push(`${indent}${flag} ${attrSummary(node)}`);
      if (isChild) {
        lines.push(`${indent}   ⤷ disparado por: ${path.join(" → ")}`);
      }
      const enumCount = node.attribute_value_list?.length ?? 0;
      if (enumCount > 0 && (full || matchesGrep || node.mandatory)) {
        const sample = node
          .attribute_value_list!.slice(0, 10)
          .map((v) => {
            const hasChildren = (v.child_attribute_list?.length ?? 0) > 0;
            return `${v.value_id}:${v.name}${hasChildren ? "⚠filhos" : ""}`;
          })
          .join(" | ");
        lines.push(`${indent}   valores: ${sample}${enumCount > 10 ? ` … (+${enumCount - 10})` : ""}`);
      }
      if (node.attribute_info?.introduction) {
        lines.push(`${indent}   intro: ${node.attribute_info.introduction.slice(0, 160)}`);
      }
      if (node.mandatory && !covered) {
        if (!uncoveredAttrs.has(node.name)) uncoveredAttrs.set(node.name, new Set());
        uncoveredAttrs.get(node.name)!.add(catId);
      }
    });

    if (lines.length > 0) {
      console.log(`\n=== ${catId} ===`);
      console.log(lines.join("\n"));
    } else if (!onlyUncovered && !grepRe) {
      console.log(`=== ${catId} === (sem atributos a mostrar)`);
    }

    if (i < categories.length - 1) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  console.log(`\n\n========== RESUMO: atributos MANDATORY nao cobertos (inclui filhos) ==========`);
  if (uncoveredAttrs.size === 0) {
    console.log("  (nenhum)");
  } else {
    for (const [name, cats] of [...uncoveredAttrs.entries()].sort(
      (a, b) => b[1].size - a[1].size,
    )) {
      const catList = [...cats].sort((a, b) => a - b);
      console.log(`  "${name}" → ${cats.size} categoria(s): ${catList.join(", ")}`);
    }
  }
  console.log("\n[debug-attrs] DONE");
}

main()
  .catch((err) => {
    console.error("[debug-attrs] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
