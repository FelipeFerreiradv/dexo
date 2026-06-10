/**
 * Re-categorizacao automatica de produtos Shopee em categorias nao-folha.
 *
 * Contexto: a Shopee bloqueia add_item em categorias nao-folha. 44 produtos
 * do user estao em 11 categorias-pai (100919, 102187, 102225, 102226, 102231,
 * 102232, 102239, 102240, 102243, 102244, 102249). Esse script mapeia
 * automaticamente cada produto pra uma sub-folha valida via regex no nome.
 *
 * Estrategia:
 *  1. Lista produtos com shopeeCategoryId em PROBLEMATIC_CATEGORIES.
 *  2. Para cada produto, testa REGRAS_DE_KEYWORD na ordem (especifica → generica).
 *     Primeiro match wins. Se nada bater, usa fallback "Outros" da pai.
 *  3. Dry-run mostra: SKU, nome, categoria atual → categoria sugerida + nome.
 *  4. --apply executa UPDATE Product set shopeeCategoryId = ... where id IN (...)
 *
 * Uso:
 *   npm run shopee:recategorize                          # dry-run (default)
 *   npm run shopee:recategorize -- --apply               # executa
 *   npm run shopee:recategorize -- --user=<userId>       # filtra por user
 *   npm run shopee:recategorize -- --category=102243     # so 1 cat-pai
 *
 * Sem regressao: nao toca outros campos do Product, so shopeeCategoryId.
 * Idempotente: rodar 2x nao re-categoriza ja-corretos.
 */

import "dotenv/config";
import prisma from "@/app/lib/prisma";

const PROBLEMATIC_CATEGORIES = new Set([
  100919, 102187, 102225, 102226, 102231, 102232, 102239, 102240, 102243, 102244, 102249,
]);

// Fallback "Outros" da categoria pai — caso nenhuma regex bata.
// Mapeia categoria-pai problematica → folha "Outros" equivalente.
const FALLBACK_OTHERS: Record<number, { id: number; label: string }> = {
  100919: { id: 101680, label: "Outros (Brinquedos Pet) — REVISAR: produto provavelmente nao eh pet" },
  102187: { id: 102601, label: "Outros (Peças e Acessórios para Veículos)" },
  102225: { id: 102284, label: "Outros (Motor)" },
  102226: { id: 102296, label: "Outros (Carroceria)" },
  102231: { id: 102344, label: "Outros (Injeção)" },
  102232: { id: 102351, label: "Outros (Ignição)" },
  102239: { id: 102394, label: "Outros (Peças Internas)" },
  102240: { id: 102404, label: "Outros (Peças Externas)" },
  102243: { id: 102536, label: "Outros (Acessórios Externos)" },
  102244: { id: 102417, label: "Outros (Acessórios Porta-malas)" },
  102249: { id: 102528, label: "Outros (Acessórios Internos)" },
};

interface KeywordRule {
  regex: RegExp;
  categoryId: number;
  label: string;
}

// REGRAS na ordem de especificidade — primeiro match wins.
const KEYWORD_RULES: KeywordRule[] = [
  // === Bem especificas (alto sinal) ===
  { regex: /ma[çc]aneta/i, categoryId: 102291, label: "Maçanetas de Automóveis" },
  { regex: /\bbico\s+injetor|injetor(?!\s+(?:de\s+)?ar)|flauta\s+(?:de\s+)?inje[çc][ãa]o|flauta\s+bico/i, categoryId: 102336, label: "Injectores de Combustível" },
  { regex: /tanque(?:\s+(?:de\s+)?combust[ií]vel)?|gargalo\s+(?:do\s+)?tanque|portinhola\s+tampa\s+tanque|tampa\s+(?:do\s+)?tanque/i, categoryId: 102292, label: "Tanque de Combustível" },
  { regex: /alma\s+(?:do\s+)?para[\s-]?choque/i, categoryId: 102288, label: "Almas de Para-choques" },
  { regex: /coletor\s+(?:de\s+)?admiss[ãa]o|cabe[çc]ote(?:\s+do?\s+motor)?|tampa\s+(?:de\s+|das?\s+)v[áa]lvulas?/i, categoryId: 102273, label: "Componentes de Motor" },
  { regex: /coxim/i, categoryId: 102280, label: "Coxins de Motor" },
  { regex: /correia\s+dentada|capa\s+(?:da\s+)?correia|distribui[çc][ãa]o\s+e\s+correia/i, categoryId: 102278, label: "Distribuição e Correias" },
  { regex: /ventoinha(?:\s+do?\s+radiador)?|eletroventilador/i, categoryId: 102275, label: "Eletroventiladores" },
  { regex: /(?<!ventoinha\s)radiador(?!.*ventoinha)/i, categoryId: 102274, label: "Radiadores" },
  { regex: /\bmangueira\b/i, categoryId: 102279, label: "Mangueiras" },
  { regex: /luz\s+(?:de\s+)?cortesia|luz\s+(?:interna|teto)/i, categoryId: 102390, label: "Luzes Internas" },
  { regex: /chave\s+(?:de\s+)?seta|acabamento.*chave|alavanca\s+(?:de\s+)?ma[çc]aneta/i, categoryId: 102385, label: "Alavancas e Maçanetas" },
  { regex: /paralama|para[\s-]lama/i, categoryId: 102293, label: "Paralamas" },
  { regex: /caixa\s+(?:de\s+)?isopor.*estepe|estepe/i, categoryId: 102417, label: "Outros (Porta-malas)" },
  { regex: /capa\s+(?:de\s+)?ca[çc]amba/i, categoryId: 102415, label: "Capa de Caçamba" },
  { regex: /sonda\s+lambda/i, categoryId: 102340, label: "Sonda Lambda" },
  { regex: /bobina\s+(?:de\s+)?igni[çc][ãa]o/i, categoryId: 102345, label: "Bobina de ignição" },
  { regex: /vela\s+(?:de\s+)?igni[çc][ãa]o/i, categoryId: 102348, label: "Velas de ignição" },
  { regex: /alternador/i, categoryId: 102346, label: "Alternadores" },
  { regex: /motor\s+(?:de\s+)?partida/i, categoryId: 102347, label: "Motor de partida" },
  { regex: /espelho\s+retrovisor.*(?:interno|interior)/i, categoryId: 102392, label: "Espelho Retrovisor (Interno)" },
  { regex: /espelho\s+retrovisor/i, categoryId: 102285, label: "Espelhos Retrovisores" },
  { regex: /apoio\s+(?:de\s+)?bra[çc]o/i, categoryId: 102380, label: "Apoio de Braço" },
  { regex: /pedal(?:\s+(?:do\s+)?(?:freio|acelerador|embreagem))?/i, categoryId: 102393, label: "Pedais" },
  { regex: /pisca\s+alerta|bot[ãa]o\s+(?:do\s+)?pisca/i, categoryId: 102394, label: "Outros (Peças Internas)" }, // sem categoria de botoes painel
  { regex: /porta[\s-]?luvas/i, categoryId: 102391, label: "Porta-luvas" },
  { regex: /buzina/i, categoryId: 102399, label: "Buzinas" },
  { regex: /lateral\s+(?:direito|esquerdo)|retalho\s+lateral/i, categoryId: 102296, label: "Outros (Carroceria) — lateral" },
  // === Genericas (menor sinal) ===
  { regex: /soleira/i, categoryId: 102530, label: "Estribos de Corrida (soleira)" },
  { regex: /longarina/i, categoryId: 102296, label: "Outros (Carroceria) — longarina" },
  { regex: /console\s+central/i, categoryId: 102394, label: "Outros (Peças Internas) — console" },
  { regex: /acabamento\s+(?:do?\s+)?porta\s*[\-]?\s*mala/i, categoryId: 102383, label: "Tampa Interna do Porta-malas" },
  { regex: /agregado.*suspens[ãa]o/i, categoryId: 102280, label: "Coxins de Motor (agregado suspensão)" },
  { regex: /cinta\s+air\s*bag/i, categoryId: 102394, label: "Outros (Peças Internas) — cinta airbag" },
  { regex: /reservat[óo]rio\s+(?:de\s+)?[óo]leo|reservat[óo]rio.*dire[çc][ãa]o/i, categoryId: 102404, label: "Outros (Peças Externas) — reservatório" },
  { regex: /caixa\s+(?:de\s+)?fus[ií]vel/i, categoryId: 102394, label: "Outros (Peças Internas) — fusíveis" },
  { regex: /suporte\s+(?:de\s+)?banco/i, categoryId: 102394, label: "Outros (Peças Internas) — suporte banco" },
  { regex: /suporte\s+(?:de\s+)?rack/i, categoryId: 102536, label: "Outros (Acessórios Externos) — rack" },
  { regex: /chicote/i, categoryId: 102536, label: "Outros (Acessórios Externos) — chicote" },
  { regex: /circuito\s+lanterna/i, categoryId: 102536, label: "Outros (Acessórios Externos) — circuito lanterna" },
  { regex: /cilindro\s+(?:do\s+)?pedal\s+embreagem|cilindro\s+(?:da\s+)?embreagem/i, categoryId: 102351, label: "Outros (Ignição) — REVISAR: embreagem nao tem categoria propria" },
  { regex: /pin[çc]a\s+(?:de\s+)?freio/i, categoryId: 102394, label: "Outros (Peças Internas) — REVISAR: freios sem categoria propria" },
];

function parseArgs(): {
  apply: boolean;
  user?: string;
  categoryFilter?: number;
} {
  const out: { apply: boolean; user?: string; categoryFilter?: number } = {
    apply: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      out.apply = true;
    } else {
      const [k, v] = arg.replace(/^--/, "").split("=");
      if (k === "user" && v) out.user = v;
      else if (k === "category" && v) {
        const n = Number(v);
        if (Number.isFinite(n)) out.categoryFilter = n;
      }
    }
  }
  return out;
}

function suggestCategoryFromName(
  name: string,
  currentCategoryId: number,
): { id: number; label: string; via: "keyword" | "fallback" } {
  for (const rule of KEYWORD_RULES) {
    if (rule.regex.test(name)) {
      return { id: rule.categoryId, label: rule.label, via: "keyword" };
    }
  }
  const fallback = FALLBACK_OTHERS[currentCategoryId];
  if (fallback) {
    return { id: fallback.id, label: fallback.label, via: "fallback" };
  }
  return { id: currentCategoryId, label: "?? sem regra nem fallback ??", via: "fallback" };
}

async function main() {
  const { apply, user: userFilter, categoryFilter } = parseArgs();
  console.log(`[recategorize] modo=${apply ? "APPLY (real)" : "DRY-RUN (preview)"}`);
  if (userFilter) console.log(`[recategorize] user filter: ${userFilter}`);
  if (categoryFilter) console.log(`[recategorize] category filter: ${categoryFilter}`);
  console.log("");

  const categoryFilterList = categoryFilter
    ? [categoryFilter]
    : [...PROBLEMATIC_CATEGORIES].map((c) => String(c));

  const products = await prisma.product.findMany({
    where: {
      shopeeCategoryId: {
        in: Array.isArray(categoryFilterList)
          ? categoryFilterList.map(String)
          : [String(categoryFilterList)],
      },
      ...(userFilter ? { userId: userFilter } : {}),
    },
    select: {
      id: true,
      sku: true,
      name: true,
      shopeeCategoryId: true,
      brand: true,
      model: true,
    },
    orderBy: [{ shopeeCategoryId: "asc" }, { sku: "asc" }],
  });

  console.log(`[recategorize] ${products.length} produto(s) a processar\n`);

  const byNewCat = new Map<number, typeof products>();
  const stats = { keyword: 0, fallback: 0, noChange: 0 };
  const updates: Array<{ id: string; newCategoryId: string }> = [];

  for (const p of products) {
    const currentCatId = Number(p.shopeeCategoryId);
    const suggestion = suggestCategoryFromName(p.name, currentCatId);

    if (suggestion.id === currentCatId) {
      stats.noChange++;
      console.log(
        `  ─ ${p.sku} → mantem ${currentCatId} (regra apontaria pra mesma categoria)`,
      );
      continue;
    }

    if (suggestion.via === "keyword") stats.keyword++;
    else stats.fallback++;

    const flag = suggestion.via === "keyword" ? "✓" : "⚠";
    const reviseFlag = suggestion.label.includes("REVISAR") ? " 🚨" : "";
    console.log(
      `  ${flag} ${p.sku}  ${currentCatId} → ${suggestion.id} [${suggestion.via}]${reviseFlag}`,
    );
    console.log(`     "${p.name}"`);
    console.log(`     → ${suggestion.label}`);

    if (!byNewCat.has(suggestion.id)) byNewCat.set(suggestion.id, []);
    byNewCat.get(suggestion.id)!.push(p);
    updates.push({ id: p.id, newCategoryId: String(suggestion.id) });
  }

  console.log("");
  console.log(`[recategorize] resumo por nova categoria:`);
  for (const [catId, prods] of [...byNewCat.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(`  ${catId}: ${prods.length} produto(s)`);
  }

  console.log("");
  console.log(
    `[recategorize] stats: ${stats.keyword} via keyword (alta confianca), ` +
      `${stats.fallback} via fallback Outros (revise), ${stats.noChange} sem mudanca.`,
  );

  if (!apply) {
    console.log(
      `\n[recategorize] DRY-RUN — nada foi alterado no DB. Para executar use --apply.`,
    );
    return;
  }

  console.log("\n[recategorize] aplicando updates no DB...");
  let applied = 0;
  for (const u of updates) {
    try {
      await prisma.product.update({
        where: { id: u.id },
        data: { shopeeCategoryId: u.newCategoryId },
      });
      applied++;
    } catch (err) {
      console.error(
        `  ✗ ${u.id} → ${u.newCategoryId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  console.log(`[recategorize] DONE — ${applied}/${updates.length} updates aplicados`);
}

main()
  .catch((err) => {
    console.error("[recategorize] erro fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
