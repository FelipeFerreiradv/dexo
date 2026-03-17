import "dotenv/config";
import axios from "axios";
import { ML_CATEGORY_OPTIONS } from "../app/lib/product-parser";

/**
 * Quick helper to list Mercado Livre categories known by the app and flag
 * those that likely belong to the User Product/catalog flow (family_name required).
 *
 * Heurística utilizada:
 * - categorias que já falharam com erro de "required_fields [family_name]" (configure em hardcoded list);
 * - categorias cujo settings.catalog_domain existe E a última tentativa de criação retornou erro de title
 *   (não detectamos aqui, mas o script já destaca o catalog_domain para decisão manual);
 *
 * Para um diagnóstico completo, rode:
 *   npx tsx scripts/scan-ml-family-name.ts [catId ...]
 */

const HARD_FAIL_FAMILY: Set<string> = new Set([
  "MLB193419", // Cubo de Roda – comprovadamente exige family_name e remove title
  "MLB101763", // Portas – idem
]);

type CategoryInfo = {
  id: string;
  name: string;
  catalogDomain?: string | null;
  suggestedFamilyName: boolean;
};

async function fetchCategory(catId: string): Promise<CategoryInfo | null> {
  try {
    const resp = await axios.get(`https://api.mercadolibre.com/categories/${catId}`);
    const data = resp.data || {};
    const settings = data.settings || {};
    const catalogDomain = settings.catalog_domain || null;
    const suggestedFamilyName = HARD_FAIL_FAMILY.has(catId);
    return {
      id: catId,
      name: data.name || "",
      catalogDomain,
      suggestedFamilyName,
    };
  } catch (err) {
    console.error(`[scan] Falha ao buscar categoria ${catId}:`, (err as any)?.message || err);
    return null;
  }
}

async function main() {
  const cliCats = process.argv.slice(2).filter((s) => s.trim());
  // Consider only external-looking IDs (sem hífen) para evitar IDs internos (MLB1765-01)
  const seed = [
    ...HARD_FAIL_FAMILY,
    "MLB271107", // fallback atual
  ];

  const knownCats = Array.from(
    new Set([
      ...seed,
      ...ML_CATEGORY_OPTIONS.map((c) => c.id).filter((id) => /^[A-Za-z0-9]+$/.test(id)),
      ...cliCats.filter((id) => /^[A-Za-z0-9]+$/.test(id)),
    ]),
  );

  if (knownCats.length === 0) {
    console.log("Nenhuma categoria conhecida. Informe IDs externos via CLI (ex: MLB193419).");
    return;
  }

  console.log(`Verificando ${knownCats.length} categorias...`);
  const results: CategoryInfo[] = [];
  for (const cat of knownCats) {
    const info = await fetchCategory(cat);
    if (info) results.push(info);
  }

  const shouldFamily = results.filter((r) => r.suggestedFamilyName);
  const maybeFamily = results.filter(
    (r) => !r.suggestedFamilyName && r.catalogDomain && r.catalogDomain.startsWith("MLB-"),
  );

  console.log("\n=== Confirmadas (family_name obrigatório por evidência de erro) ===");
  shouldFamily.forEach((r) =>
    console.log(`- ${r.id.padEnd(10)} ${r.name} | catalog_domain=${r.catalogDomain || "-"}`),
  );

  console.log("\n=== Possíveis (catalog_domain presente; validar em produção) ===");
  maybeFamily.forEach((r) =>
    console.log(`- ${r.id.padEnd(10)} ${r.name} | catalog_domain=${r.catalogDomain}`),
  );

  console.log("\nSugestão de ML_FAMILY_NAME_ALLOWLIST para .env:");
  const allow = [...new Set([...shouldFamily.map((r) => r.id)])];
  console.log(allow.join(","));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
