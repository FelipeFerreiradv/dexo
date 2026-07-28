import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";

/**
 * Item 4 da reconciliação 704: "retira do catálogo" os produtos migrados
 * (attributes.migration="704") cujos anúncios ML estão INATIVOS
 * (vendidos/encerrados/pausados) — via `stock=0` (reversível, não apaga).
 *
 * Determina os inativos = produtos com anúncio cujo MLB NÃO está na exportação
 * de anúncios ativos. Confirma buscando o status FRESCO no ML (o status do
 * banco está desatualizado). Só zera os não-`active`; grava StockLog (guarda o
 * estoque anterior → reversível). Idempotente.
 *
 * ⚠️ ZERA o estoque, não decrementa. Produtos com `stock > 1` são pulados por
 * padrão (a premissa "anúncio fora do ar = peça vendida" é de peça única); e
 * `--apply` exige `--confirmar-zeragem`.
 *
 *   npx tsx scripts/retire-704-inactive-listings.ts --dry-run
 *   npx tsx scripts/retire-704-inactive-listings.ts --apply --confirmar-zeragem
 *   npx tsx scripts/retire-704-inactive-listings.ts --dry-run --incluir-multi-unidade
 */

type RawRow = Record<string, unknown>;

const DEFAULT_USER_ID = "cmql2zugq0000vs8g376rend5"; // 704
const DEFAULT_FILE = path.resolve(__dirname, "data", "reconcile", "anuncios-704.xlsx");
const OUT_DIR = path.resolve(__dirname, "out");
const TAG = "704";
const REASON = "Migração 704 · anúncio inativo retirado do catálogo";

interface Flags {
  userId: string;
  dryRun: boolean;
  apply: boolean;
  file: string;
  limit: number | null;
  /** Confirmação explícita além de --apply: a escrita aqui é ZERAGEM. */
  confirmarZeragem: boolean;
  /** Sem esta flag, produto com stock > 1 nunca é zerado. */
  incluirMultiUnidade: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string) => {
    const p = `--${n}=`;
    const f = argv.find((a) => a.startsWith(p));
    return f ? f.slice(p.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const apply = has("apply");
  const limitRaw = get("limit");
  return {
    userId: get("user-id") ?? DEFAULT_USER_ID,
    apply,
    dryRun: has("dry-run") || !apply,
    file: get("file") ?? DEFAULT_FILE,
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    confirmarZeragem: has("confirmar-zeragem"),
    incluirMultiUnidade: has("incluir-multi-unidade"),
  };
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}
function normMlb(v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const t = s.trim().toUpperCase();
  return /^MLB\d+$/.test(t) ? t : null;
}

/** MLBs ativos, da sheet "Anúncios" (coluna ITEM_ID). */
function readActiveMlbs(filePath: string): Set<string> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`Arquivo não encontrado: ${resolved}`);
  const wb = XLSX.readFile(resolved);
  const sheetName =
    wb.SheetNames.find(
      (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() === "anuncios",
    ) ?? wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<RawRow>(wb.Sheets[sheetName], { defval: null });
  const set = new Set<string>();
  for (const r of rows) {
    const mlb = normMlb(r["ITEM_ID"]);
    if (mlb) set.add(mlb);
  }
  console.log(`[sheet] '${sheetName}': ${set.size} MLBs ativos`);
  return set;
}

interface AccountLite {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}
const tokenCache = new Map<string, string>();
/** Token válido; SEMPRE persiste o refresh (senão rotaciona e quebra a conta). */
async function getValidToken(account: AccountLite): Promise<string> {
  const cached = tokenCache.get(account.id);
  if (cached) return cached;
  if (new Date(account.expiresAt).getTime() > Date.now() + 60_000) {
    tokenCache.set(account.id, account.accessToken);
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(account.id, account.refreshToken);
  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });
  tokenCache.set(account.id, refreshed.accessToken);
  return refreshed.accessToken;
}

type MlLite = { id?: string; status?: string; sub_status?: string[] };

function pushCap<T>(arr: T[], item: T, cap = 5000): void {
  if (arr.length < cap) arr.push(item);
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const flags = parseFlags(process.argv.slice(2));
  console.log(`[retire-704] userId=${flags.userId} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"}`);

  // TRAVA: este script ZERA estoque (não decrementa). `--apply` sozinho não
  // basta — o estoque anterior só sobrevive no StockLog.
  if (flags.apply && !flags.confirmarZeragem) {
    console.error(
      `[retire-704] ABORTADO: --apply exige também --confirmar-zeragem.` +
        `\n[retire-704] Rode primeiro com --dry-run, confira os números e repita com --confirmar-zeragem.`,
    );
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: flags.userId },
    select: { email: true, role: true },
  });
  if (!user) throw new Error(`Usuário ${flags.userId} não encontrado.`);
  console.log(`[preflight] user=${user.email} role=${user.role}`);

  const activeMlbs = readActiveMlbs(flags.file);

  // Produtos 704 com anúncio ML.
  const products = await prisma.product.findMany({
    where: { userId: flags.userId, attributes: { path: ["migration"], equals: TAG } },
    select: {
      id: true,
      sku: true,
      name: true,
      stock: true,
      listings: {
        where: { externalListingId: { startsWith: "MLB" } },
        select: { externalListingId: true },
      },
    },
  });

  // Candidato = tem anúncio ML e NENHUM está na exportação de ativos.
  const candidates = products
    .filter((p) => {
      const mlbs = p.listings.map((l) => normMlb(l.externalListingId)).filter((m): m is string => !!m);
      return mlbs.length > 0 && !mlbs.some((m) => activeMlbs.has(m));
    })
    .map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name ?? "",
      stock: p.stock,
      mlbs: p.listings.map((l) => normMlb(l.externalListingId)).filter((m): m is string => !!m),
    }));
  const sliced = flags.limit !== null ? candidates.slice(0, flags.limit) : candidates;
  console.log(`[retire-704] candidatos (anúncio fora dos ativos): ${candidates.length}${flags.limit ? ` (limit=${sliced.length})` : ""}`);

  // Conta ML ACTIVE + token.
  const account = await prisma.marketplaceAccount.findFirst({
    where: { userId: flags.userId, status: "ACTIVE", platform: "MERCADO_LIVRE" },
    select: { id: true, accessToken: true, refreshToken: true, expiresAt: true },
  });
  if (!account) throw new Error("Nenhuma conta ML ACTIVE para o usuário — não dá p/ buscar status.");
  const token = await getValidToken(account);

  // Status FRESCO de todos os MLBs candidatos (multiget em lote).
  const allMlbs = Array.from(new Set(sliced.flatMap((c) => c.mlbs)));
  console.log(`[retire-704] buscando status de ${allMlbs.length} MLBs no ML...`);
  const details = (await MLApiService.getItemsDetails(token, allMlbs)) as unknown as MlLite[];
  const statusByMlb = new Map<string, MlLite>();
  for (const d of details) if (d.id) statusByMlb.set(String(d.id).toUpperCase(), d);

  const sum = {
    candidatos: sliced.length,
    zerar: 0,
    ja_zerado: 0,
    zerados: 0,
    manter_ativo: 0,
    pulado_multi_unidade: 0,
    pulado_multi_unidade_unidades: 0,
    por_status: {} as Record<string, number>,
    errors: 0,
    detalhes: [] as unknown[],
  };

  for (const c of sliced) {
    // status do produto: se QUALQUER MLB dele está active → mantém.
    let anyActive = false;
    let repStatus = "not_found";
    let repSub: string[] | undefined;
    for (const mlb of c.mlbs) {
      const d = statusByMlb.get(mlb);
      if (!d) continue;
      if (d.status === "active") anyActive = true;
      if (repStatus === "not_found" && d.status) {
        repStatus = d.status;
        repSub = d.sub_status;
      }
    }
    sum.por_status[repStatus] = (sum.por_status[repStatus] ?? 0) + 1;

    if (anyActive) {
      sum.manter_ativo++;
      pushCap(sum.detalhes, { id: c.id, sku: c.sku, name: c.name, mlb: c.mlbs[0], statusMl: "active", acao: "MANTER" });
      continue;
    }

    // RETIRAR
    if (c.stock <= 0) {
      sum.ja_zerado++;
      continue;
    }
    // TRAVA: "anúncio inativo ⇒ retirar do catálogo" zera TODO o saldo. Para
    // produto multi-unidade isso descarta as unidades restantes, que continuam
    // fisicamente em prateleira. Excluído por padrão.
    if (c.stock > 1 && !flags.incluirMultiUnidade) {
      sum.pulado_multi_unidade++;
      sum.pulado_multi_unidade_unidades += c.stock;
      console.warn(
        `[retire-704][MULTI-UNIDADE] sku=${c.sku} stock=${c.stock} — pulado; use --incluir-multi-unidade para zerar mesmo assim`,
      );
      continue;
    }
    sum.zerar++;
    pushCap(sum.detalhes, {
      id: c.id,
      sku: c.sku,
      name: c.name,
      mlb: c.mlbs[0],
      statusMl: repStatus,
      subStatus: repSub ?? null,
      previousStock: c.stock,
      acao: flags.dryRun ? "ZERARIA" : "ZERADO",
    });

    if (flags.dryRun) continue;
    try {
      await prisma.$transaction([
        prisma.product.update({ where: { id: c.id }, data: { stock: 0 } }),
        prisma.stockLog.create({
          data: {
            productId: c.id,
            change: -c.stock,
            reason: REASON,
            previousStock: c.stock,
            newStock: 0,
          },
        }),
      ]);
      sum.zerados++;
    } catch (err) {
      sum.errors++;
      pushCap(sum.detalhes, { id: c.id, sku: c.sku, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Relatório JSON + XLSX
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = { userId: flags.userId, mode: flags.dryRun ? "dry-run" : "apply", startedAt, finishedAt: new Date().toISOString(), summary: { ...sum, detalhes: undefined }, detalhes: sum.detalhes };
  fs.writeFileSync(path.join(OUT_DIR, `retire-704-inactive-${stamp}.json`), JSON.stringify(report, null, 2), "utf8");

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Métrica: "Candidatos (anúncio fora dos ativos)", Valor: sum.candidatos },
      { Métrica: "A ZERAR (inativos com estoque)", Valor: sum.zerar },
      { Métrica: "Já zerados (stock=0)", Valor: sum.ja_zerado },
      { Métrica: "MANTIDOS (active no ML)", Valor: sum.manter_ativo },
      ...Object.entries(sum.por_status).map(([k, v]) => ({ Métrica: `status ML: ${k}`, Valor: v })),
    ]),
    "Resumo",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet((sum.detalhes.length ? sum.detalhes : [{}]) as Record<string, unknown>[]),
    "Detalhe",
  );
  const xlsxPath = path.join(OUT_DIR, `retire-704-inactive-${stamp}.xlsx`);
  XLSX.writeFile(wb, xlsxPath);

  console.log("\n===== RESUMO — RETIRAR INATIVOS (stock=0) =====");
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  candidatos:            ${sum.candidatos}`);
  console.log(`  ${flags.dryRun ? "a zerar" : "zerados"}:              ${flags.dryRun ? sum.zerar : sum.zerados}`);
  console.log(`  já zerados (stock=0):  ${sum.ja_zerado}`);
  console.log(`  MANTIDOS (active ML):  ${sum.manter_ativo}`);
  console.log(
    `  pulados multi-unidade: ${sum.pulado_multi_unidade} (${sum.pulado_multi_unidade_unidades} unidades preservadas)`,
  );
  console.log(`  status ML:             ${JSON.stringify(sum.por_status)}`);
  console.log(`  erros:                 ${sum.errors}`);
  console.log(`  relatório:             ${xlsxPath}`);
  console.log("===============================================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[retire-704][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
