/**
 * FASE 0 — Amostragem READ-ONLY (diagnóstico) da limpeza de legados Vaapt→IBR.
 *
 * NÃO escreve nada no banco. Apenas SELECT/COUNT/findMany.
 *
 * v3 — REGRAS FINAIS (confirmadas pelo cliente):
 *  EXCLUIR:
 *   - convertido: ^(100|200|300|400|500|800)\d{3,4}$  (centena + sufixo 3-4 díg, len 6-7)
 *   - cru Vaapt:  ^[HJY]-?\d+$                          (J-4997, Y-5881, H-802)
 *  PRESERVAR (nunca excluir):
 *   - qualquer numérico puro SEM prefixo de centena (inclui <18000 e >=18000)
 *   - ML-MLB..., letras V/G/C/O..., dash \d+-\d+, prefixo 359, corrompidos
 *   - qualquer um com OrderItem/NfeItem/ReceivableItem (histórico)
 *
 * Rodar:  npx tsx scripts/sampling-legacy-vaapt-ibr.ts
 */
import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { normalizeText } from "@/app/localizacoes/lib/search-utils";

const TARGET_EMAIL = "leonardo.lima.borges@outlook.com.br";

const RE_CAIXA = /^caixa[\s-]*(\d{1,4})$/; // colado / hífen / espaço
const RE_CONVERTED = /^(100|200|300|400|500|800)(\d{3,4})$/; // EXCLUIR
const RE_RAW_HJY = /^[HJY]-?\d+$/i; // EXCLUIR
const RE_DASH = /^\d+-\d+$/; // revisar

function caixaN(code: string | null | undefined): number | null {
  const n = normalizeText(code);
  if (!n || n.includes("madeira")) return null;
  const m = RE_CAIXA.exec(n);
  return m ? Number(m[1]) : null;
}
const isCaixaSimples = (code: string | null | undefined) => caixaN(code) != null;

type Bucket =
  | "EXCLUIR_convertido"
  | "EXCLUIR_cru_HJY"
  | "preserve_numerico"
  | "revisar_ML"
  | "revisar_dash"
  | "revisar_num_6_7" // prefixo numérico 6-7 fora do set (ex. 359)
  | "revisar_letra" // V/G/C/O...
  | "revisar_lixo";

function classify(skuRaw: string): { b: Bucket; detail?: string } {
  const s = (skuRaw ?? "").trim();
  if (s === "") return { b: "revisar_lixo" };
  if (RE_RAW_HJY.test(s)) return { b: "EXCLUIR_cru_HJY", detail: s[0].toUpperCase() };
  if (/^ML-/i.test(s)) return { b: "revisar_ML" };
  const conv = RE_CONVERTED.exec(s);
  if (conv) return { b: "EXCLUIR_convertido", detail: `${conv[1]}:len${s.length}` };
  if (/^\d+$/.test(s) && Number.isSafeInteger(Number(s))) {
    // numérico puro sem prefixo de centena reconhecido → PRESERVAR
    // (mas se for 6-7 díg com prefixo fora do set, marca p/ revisão)
    if (s.length >= 6 && s.length <= 7) return { b: "revisar_num_6_7", detail: s.slice(0, 3) };
    return { b: "preserve_numerico" };
  }
  if (/^[A-Za-z]/.test(s)) return { b: "revisar_letra", detail: s[0].toUpperCase() };
  if (RE_DASH.test(s)) return { b: "revisar_dash", detail: s.split("-")[0].slice(0, 3) };
  return { b: "revisar_lixo" };
}

function bump<K>(m: Map<K, number>, k: K) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: TARGET_EMAIL },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error(`Usuário não encontrado: ${TARGET_EMAIL}`);
    process.exit(1);
  }
  const userId = user.id;
  console.log(`\n=== FASE 0 — AMOSTRAGEM READ-ONLY (v3 — regras finais) ===`);
  console.log(`Tenant: ${user.email}  userId=${userId}\n`);

  // 1) Escopo -----------------------------------------------------------------
  const locations = await prisma.location.findMany({
    where: { userId },
    select: { id: true, code: true },
  });
  const scope = locations.filter((l) => isCaixaSimples(l.code));
  const ns = scope.map((l) => caixaN(l.code)!);
  const scopeIds = scope.map((l) => l.id);
  console.log(
    `Escopo: ${scope.length} caixas numéricas (N ${ns.length ? Math.min(...ns) : "-"}–${ns.length ? Math.max(...ns) : "-"}); ` +
      `madeira ignoradas: ${locations.filter((l) => normalizeText(l.code).includes("madeira")).length}`,
  );

  // 2) Produtos em escopo -----------------------------------------------------
  const prods = await prisma.product.findMany({
    where: { userId, locationId: { in: scopeIds } },
    select: { id: true, sku: true },
  });
  console.log(`Produtos em escopo: ${prods.length}\n`);

  // 3) Classificação ----------------------------------------------------------
  const bucketCount = new Map<Bucket, number>();
  const samples = new Map<Bucket, string[]>();
  const convByPrefix = new Map<string, number>();
  const rawByLetter = new Map<string, number>();
  const num67Other = new Map<string, number>();
  const excluirIds: string[] = [];

  for (const p of prods) {
    const { b, detail } = classify(p.sku);
    bump(bucketCount, b);
    const arr = samples.get(b) ?? [];
    if (arr.length < 20) {
      arr.push(p.sku);
      samples.set(b, arr);
    }
    if (b === "EXCLUIR_convertido") {
      bump(convByPrefix, detail!.split(":")[0]);
      excluirIds.push(p.id);
    } else if (b === "EXCLUIR_cru_HJY") {
      bump(rawByLetter, detail!);
      excluirIds.push(p.id);
    } else if (b === "revisar_num_6_7") {
      bump(num67Other, detail!);
    }
  }

  console.log(`-- Buckets (regras finais) --`);
  console.table(Object.fromEntries([...bucketCount.entries()]));
  console.log(`-- EXCLUIR convertido por prefixo de centena --`);
  console.table(Object.fromEntries([...convByPrefix.entries()].sort()));
  console.log(`-- EXCLUIR cru por letra --`);
  console.table(Object.fromEntries([...rawByLetter.entries()].sort()));
  console.log(`-- revisar_num_6_7 por prefixo (fora do set, ex. 359) --`);
  console.table(Object.fromEntries([...num67Other.entries()].sort()));
  console.log(`\n-- Amostras por bucket --`);
  for (const [b, arr] of samples.entries()) console.log(`  [${b}] ${arr.join(", ")}`);

  // 4) Histórico/anúncios DENTRO do conjunto a_excluir ------------------------
  console.log(`\n-- Candidatos brutos a_excluir: ${excluirIds.length} --`);
  const countIn = async (where: object) => {
    let total = 0;
    for (let i = 0; i < excluirIds.length; i += 1000) {
      total += await prisma.product.count({
        where: { id: { in: excluirIds.slice(i, i + 1000) }, ...where },
      });
    }
    return total;
  };
  const [exOrder, exNfe, exRecv, exActive] = await Promise.all([
    countIn({ orderItems: { some: {} } }),
    countIn({ nfeItens: { some: {} } }),
    countIn({ receivableItems: { some: {} } }),
    countIn({ listings: { some: { status: "active" } } }),
  ]);
  const protegidoUnion = await countIn({
    OR: [
      { orderItems: { some: {} } },
      { nfeItens: { some: {} } },
      { receivableItems: { some: {} } },
    ],
  });

  console.log(`-- Dentro de a_excluir: histórico & anúncios --`);
  console.table({
    com_OrderItem: exOrder,
    com_NfeItem: exNfe,
    com_ReceivableItem: exRecv,
    PROTEGIDO_historico_uniao: protegidoUnion,
    com_listing_active: exActive,
  });

  // 5) INVARIANTE de segurança: nenhum preserve dentro de a_excluir -----------
  const excluirSkus = new Set(
    prods.filter((p) => excluirIds.includes(p.id)).map((p) => p.id),
  );
  let leakNumeric = 0;
  for (const p of prods) {
    if (!excluirSkus.has(p.id)) continue;
    const { b } = classify(p.sku);
    if (b === "preserve_numerico") leakNumeric++;
  }
  console.log(
    `\n[INVARIANTE] preserve_numerico vazando para a_excluir: ${leakNumeric} (deve ser 0)`,
  );

  console.log(`\n-- RESUMO FINAL (Fase 0) --`);
  const aExcluirLiquido = excluirIds.length - protegidoUnion;
  console.table({
    "escopo_produtos": prods.length,
    "A_EXCLUIR_bruto": excluirIds.length,
    "  convertido_100_200_300_400_500_800": bucketCount.get("EXCLUIR_convertido") ?? 0,
    "  cru_HJY": bucketCount.get("EXCLUIR_cru_HJY") ?? 0,
    "  (-) protegido_historico": protegidoUnion,
    "A_EXCLUIR_liquido": aExcluirLiquido,
    "  com_listing_active(encerrar no ML/Shopee)": exActive,
    "PRESERVADO_numerico(<>=18000)": bucketCount.get("preserve_numerico") ?? 0,
    "REVISAR_ML": bucketCount.get("revisar_ML") ?? 0,
    "REVISAR_dash": bucketCount.get("revisar_dash") ?? 0,
    "REVISAR_num_6_7(359 etc)": bucketCount.get("revisar_num_6_7") ?? 0,
    "REVISAR_letra(V/G/C/O)": bucketCount.get("revisar_letra") ?? 0,
    "REVISAR_lixo": bucketCount.get("revisar_lixo") ?? 0,
  });
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
