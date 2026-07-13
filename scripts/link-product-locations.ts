import "dotenv/config";
import path from "path";
import fs from "fs";
import XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import prisma from "../app/lib/prisma";

/**
 * Cria `Location` e liga `Product.locationId` para produtos que estão SEM
 * localização, a partir de um "Relatorio de Estoque" (colunas Código + Sigla/
 * Localização). Só toca em produtos com `locationId = null` (não mexe nos já
 * localizados). NUNCA cria/apaga produto. Idempotente.
 *
 * Fonte da localização por produto (por SKU = Código):
 *   1) a Sigla/Localização do ARQUIVO (autoritativo);
 *   2) fallback: o texto `product.location` que o próprio produto já tem
 *      (ligável com --use-product-text, ligado por padrão).
 *
 * Location é criada FLAT: code = caminho completo normalizado (ex.:
 * "GALPÃO 1 > ANDAR - 2 > VARÃO-1"), reusando as que já existem por code.
 *
 *   npx tsx scripts/link-product-locations.ts --user-id=<ID> --file=<xlsx> --dry-run
 *   npx tsx scripts/link-product-locations.ts --user-id=<ID> --file=<xlsx> --apply
 */

const OUT_DIR = path.resolve(__dirname, "out");

interface Flags {
  userId: string;
  file: string;
  dryRun: boolean;
  apply: boolean;
  useProductText: boolean;
  limit: number | null;
  key: "sku" | "mlb"; // chave de casamento produto↔linha do arquivo
  skuCol: string; // coluna do código/SKU (modo sku) ou do MLB (modo mlb)
  locCol: string | null; // coluna da localização (default: Sigla→Localização)
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const p = `--${n}=`;
    const f = argv.find((a) => a.startsWith(p));
    return f ? f.slice(p.length) : undefined;
  };
  const has = (n: string) => argv.includes(`--${n}`);
  const apply = has("apply");
  const limitRaw = get("limit");
  const keyRaw = (get("key") ?? "sku").toLowerCase();
  return {
    userId: get("user-id") ?? "",
    file: get("file") ?? "",
    apply,
    dryRun: has("dry-run") || !apply,
    useProductText: !has("no-product-text"),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null,
    key: keyRaw === "mlb" ? "mlb" : "sku",
    skuCol: get("sku-col") ?? (keyRaw === "mlb" ? "MLB" : "Código"),
    locCol: get("loc-col") ?? null,
  };
}

function normMlb(v: unknown): string | null {
  if (!nn(v)) return null;
  const t = String(v).trim().toUpperCase();
  return /^MLB\d+$/.test(t) ? t : null;
}

function nn(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}
/** Normaliza uma sigla/caminho hierárquico: colapsa espaços, " > " uniforme, UPPER. */
function normSig(raw: unknown): string | null {
  if (!nn(raw)) return null;
  const parts = String(raw)
    .split(">")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 0);
  return parts.length ? parts.join(" > ").toUpperCase() : null;
}
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  if (!flags.userId) throw new Error("Informe --user-id=<cuid>. Abortando.");
  if (!flags.file) throw new Error("Informe --file=<xlsx do Relatorio de Estoque>. Abortando.");

  const user = await prisma.user.findUnique({ where: { id: flags.userId }, select: { email: true } });
  if (!user) throw new Error(`Usuário ${flags.userId} não encontrado.`);
  console.log(
    `[link-loc] user=${user.email} modo=${flags.dryRun ? "DRY-RUN" : "APPLY"} key=${flags.key} col=${flags.skuCol} textFallback=${flags.useProductText}`,
  );

  // 1) Arquivo → Map chave(SKU|MLB) → sigla normalizada.
  const resolved = path.resolve(flags.file);
  if (!fs.existsSync(resolved)) throw new Error(`Arquivo não encontrado: ${resolved}`);
  const wb = XLSX.readFile(resolved);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: null });
  const fileMap = new Map<string, string>();
  for (const r of rows) {
    const rawKey = r[flags.skuCol];
    const key = flags.key === "mlb" ? normMlb(rawKey) : nn(rawKey) ? String(rawKey).trim() : null;
    const sig = flags.locCol
      ? normSig(r[flags.locCol])
      : normSig(r["Sigla"]) ?? normSig(r["Localização"]) ?? normSig(r["Localizacao"]);
    if (key && sig && !fileMap.has(key)) fileMap.set(key, sig);
  }
  console.log(`[link-loc] arquivo '${wb.SheetNames[0]}': ${rows.length} linhas → ${fileMap.size} ${flags.key}→sigla`);

  // 2) Produtos SEM localização (no modo mlb, com seus MLBs: listings + attributes.mlbs).
  const products = await prisma.product.findMany({
    where: { userId: flags.userId, locationId: null },
    select: {
      id: true,
      sku: true,
      location: true,
      ...(flags.key === "mlb"
        ? {
            attributes: true,
            listings: {
              where: { externalListingId: { startsWith: "MLB" } },
              select: { externalListingId: true },
            },
          }
        : {}),
    },
  });
  console.log(`[link-loc] produtos sem locationId: ${products.length}`);

  // 3) Resolve a sigla-alvo de cada produto (arquivo, fallback texto) e agrupa.
  const bySigla = new Map<string, string[]>(); // sigla → [productId]
  const sum = { sem_localizacao: products.length, com_arquivo: 0, com_texto_fallback: 0, sem_dado: 0 };
  const sliced = flags.limit !== null ? products.slice(0, flags.limit) : products;
  for (const p of sliced) {
    let sig: string | null = null;
    if (flags.key === "mlb") {
      const mlbs = new Set<string>();
      const pl = (p as unknown as { listings?: Array<{ externalListingId: string }> }).listings ?? [];
      for (const l of pl) {
        const m = normMlb(l.externalListingId);
        if (m) mlbs.add(m);
      }
      const attrs = (p as unknown as { attributes?: Record<string, unknown> | null }).attributes;
      const am = attrs?.mlbs;
      if (Array.isArray(am)) for (const v of am) {
        const m = normMlb(v);
        if (m) mlbs.add(m);
      }
      for (const m of mlbs) {
        const hit = fileMap.get(m);
        if (hit) {
          sig = hit;
          break;
        }
      }
    } else {
      sig = fileMap.get(p.sku) ?? null;
    }
    if (sig) sum.com_arquivo++;
    else if (flags.useProductText) {
      sig = normSig(p.location);
      if (sig) sum.com_texto_fallback++;
    }
    if (!sig) {
      sum.sem_dado++;
      continue;
    }
    (bySigla.get(sig) ?? bySigla.set(sig, []).get(sig)!).push(p.id);
  }
  console.log(`[link-loc] com sigla do arquivo=${sum.com_arquivo} fallback texto=${sum.com_texto_fallback} sem dado=${sum.sem_dado} | siglas distintas=${bySigla.size}`);

  // 4) Cache das locations existentes (code → id).
  const existing = await prisma.location.findMany({ where: { userId: flags.userId }, select: { id: true, code: true } });
  const codeToId = new Map(existing.map((l) => [l.code, l.id]));

  const out = { locations_criadas: 0, locations_reusadas: 0, produtos_linkados: 0, errors: 0, details: [] as unknown[] };

  let done = 0;
  for (const [sigla, productIds] of bySigla) {
    // 4a) Garante a Location (flat, code = sigla).
    let locId = codeToId.get(sigla) ?? null;
    if (locId) out.locations_reusadas++;
    else if (flags.dryRun) {
      locId = `<dry-${sigla}>`;
      out.locations_criadas++;
    } else {
      try {
        const desc = sigla.split(" > ").pop() ?? sigla;
        const c = await prisma.location.create({
          data: { userId: flags.userId, code: sigla, description: desc } as Prisma.LocationUncheckedCreateInput,
          select: { id: true },
        });
        locId = c.id;
        codeToId.set(sigla, locId);
        out.locations_criadas++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          const ex = await prisma.location.findUnique({
            where: { userId_code: { userId: flags.userId, code: sigla } },
            select: { id: true },
          });
          locId = ex?.id ?? null;
          if (locId) {
            codeToId.set(sigla, locId);
            out.locations_reusadas++;
          }
        } else {
          out.errors++;
          continue;
        }
      }
    }
    if (!locId) continue;

    // 4b) Liga os produtos (updateMany em lotes; trava locationId:null p/ segurança).
    // Preenche TAMBÉM o texto `location` (a UI usa como exibição/fallback em
    // lista/card/edição — mesmo padrão das migrações IBR/WebDesmonte).
    if (flags.dryRun) {
      out.produtos_linkados += productIds.length;
    } else if (!locId.startsWith("<dry-")) {
      for (const ids of chunk(productIds, 500)) {
        try {
          const r = await prisma.product.updateMany({
            where: { id: { in: ids }, userId: flags.userId, locationId: null },
            data: { locationId: locId, location: sigla },
          });
          out.produtos_linkados += r.count;
        } catch (err) {
          out.errors++;
          if (out.details.length < 50) out.details.push({ sigla, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    done++;
    if (done % 200 === 0) console.log(`[link-loc] ${done}/${bySigla.size} siglas | produtos linkados=${out.produtos_linkados} locations criadas=${out.locations_criadas}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(OUT_DIR, `link-locations-${flags.userId}-${stamp}.json`),
    JSON.stringify({ userId: flags.userId, mode: flags.dryRun ? "dry-run" : "apply", ...sum, ...out }, null, 2),
    "utf8",
  );

  console.log("\n===== RESUMO — linkar localizações =====");
  console.log(`modo: ${flags.dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  produtos SEM localização:      ${sum.sem_localizacao}`);
  console.log(`  resolvidos p/ arquivo:         ${sum.com_arquivo}`);
  console.log(`  resolvidos p/ texto (fallback):${sum.com_texto_fallback}`);
  console.log(`  SEM dado (não linkável):       ${sum.sem_dado}`);
  console.log(`  locations criadas:             ${out.locations_criadas}`);
  console.log(`  locations reusadas:            ${out.locations_reusadas}`);
  console.log(`  ${flags.dryRun ? "produtos a linkar" : "PRODUTOS LINKADOS"}:            ${out.produtos_linkados}`);
  console.log(`  erros:                         ${out.errors}`);
  console.log("========================================\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[link-loc][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
