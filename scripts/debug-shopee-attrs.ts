/**
 * Diagnostico DETALHADO de atributos de categoria Shopee.
 *
 * Chama get_attribute_tree CRU (sem o mapeamento que descarta campos) pra
 * cada categoria, e imprime a estrutura completa de cada atributo MANDATORY:
 *   - attribute_id, nome, input_type (1-5), input_validation_type (INT/STRING/...)
 *   - se tem enum (e os primeiros valores)
 *   - se o productAttrValues atual cobre o nome do atributo
 *
 * Objetivo: descobrir por que "Registration ID" (ou outro mandatory) eh
 * rejeitado — eh enum? texto livre? exige INT? — pra desenhar o fix certo.
 *
 * Uso:
 *   npm run shopee:debug-attrs                          # todas categorias de produtos
 *   npm run shopee:debug-attrs -- --category=102336    # uma categoria
 *   npm run shopee:debug-attrs -- --user=<userId>      # filtra categorias por user
 *   npm run shopee:debug-attrs -- --only-uncovered     # so mandatory sem cobertura
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

interface RawAttrNode {
  attribute_id: number;
  name: string;
  mandatory: boolean;
  attribute_value_list?: Array<{ value_id: number; name: string; value_unit?: string }>;
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
  let onlyUncovered = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--only-uncovered") onlyUncovered = true;
    else {
      const [k, v] = a.replace(/^--/, "").split("=");
      if (k === "category" && v) category = Number(v);
      else if (k === "user" && v) user = v;
    }
  }
  return { category, user, onlyUncovered };
}

async function listCategories(category?: number, user?: string): Promise<number[]> {
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
  const { category, user, onlyUncovered } = parseArgs();

  const acct = await prisma.marketplaceAccount.findFirst({
    where: { platform: Platform.SHOPEE, status: "ACTIVE" },
  });
  if (!acct?.accessToken || !acct?.shopId) {
    throw new Error("Nenhuma conta Shopee ativa");
  }
  const shopId =
    typeof acct.shopId === "string" ? parseInt(acct.shopId) : (acct.shopId as number);

  const categories = await listCategories(category, user);
  console.log(`[debug-attrs] ${categories.length} categoria(s), shop ${shopId}\n`);

  // Mapa global: nome do atributo mandatory NAO coberto → categorias que o exigem
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
    const mandatory = tree.filter((a) => a.mandatory === true);
    const printable = onlyUncovered
      ? mandatory.filter((a) => !COVERED_KEYS.has(a.name.toLowerCase()))
      : mandatory;

    if (printable.length === 0) {
      if (!onlyUncovered) console.log(`=== ${catId} === (${mandatory.length} mandatory, todos cobertos)`);
    } else {
      console.log(`\n=== ${catId} === (${mandatory.length} mandatory)`);
      for (const a of printable) {
        const covered = COVERED_KEYS.has(a.name.toLowerCase());
        const it = a.attribute_info?.input_type;
        const ivt = a.attribute_info?.input_validation_type;
        const enumCount = a.attribute_value_list?.length ?? 0;
        console.log(
          `  ${covered ? "✓" : "✗"} attr_id=${a.attribute_id} "${a.name}"`,
        );
        console.log(
          `     input_type=${it ?? "?"}(${it != null ? INPUT_TYPE_LABELS[it] ?? "?" : "?"}) ` +
            `validation=${ivt ?? "?"}(${ivt != null ? VALIDATION_LABELS[ivt] ?? "?" : "?"}) ` +
            `enum=${enumCount}${a.attribute_info?.max_value_count ? ` maxVals=${a.attribute_info.max_value_count}` : ""}` +
            `${a.is_oem ? " [is_oem]" : ""}${a.support_search_value ? " [searchable]" : ""}`,
        );
        if (enumCount > 0) {
          const sample = a.attribute_value_list!.slice(0, 8)
            .map((v) => `${v.value_id}:${v.name}`)
            .join(" | ");
          console.log(`     valores: ${sample}${enumCount > 8 ? ` … (+${enumCount - 8})` : ""}`);
        }
        if (a.attribute_info?.introduction) {
          console.log(`     intro: ${a.attribute_info.introduction.slice(0, 120)}`);
        }
        if (!covered) {
          if (!uncoveredAttrs.has(a.name)) uncoveredAttrs.set(a.name, new Set());
          uncoveredAttrs.get(a.name)!.add(catId);
        }
      }
    }

    if (i < categories.length - 1) {
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  console.log(`\n\n========== RESUMO: atributos MANDATORY nao cobertos ==========`);
  if (uncoveredAttrs.size === 0) {
    console.log("  (nenhum — todos os mandatory tem mapeamento no productAttrValues)");
  } else {
    for (const [name, cats] of [...uncoveredAttrs.entries()].sort(
      (a, b) => b[1].size - a[1].size,
    )) {
      const catList = [...cats].sort((a, b) => a - b);
      console.log(`  "${name}" → exigido em ${cats.size} categoria(s): ${catList.join(", ")}`);
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
