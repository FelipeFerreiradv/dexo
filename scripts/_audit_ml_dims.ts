/**
 * Auditoria de medidas/dimensões dos anúncios ML.
 * Uso:
 *   npx tsx scripts/_audit_ml_dims.ts            -> ambas as contas, todas as listings ativas
 *   SAMPLE=50 npx tsx scripts/_audit_ml_dims.ts  -> apenas 50 itens por conta (modo amostra)
 *   ACCOUNT=<id> npx tsx scripts/_audit_ml_dims.ts -> uma conta só
 *
 * Saída: scripts/out/ml-dims-audit.json + ml-dims-audit.csv
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";

async function fetchActiveItemIds(token: string, sellerId: string, max?: number): Promise<string[]> {
  const out: string[] = [];
  let scrollId: string | undefined;
  while (true) {
    const url = new URL(`https://api.mercadolibre.com/users/${sellerId}/items/search`);
    url.searchParams.set("status", "active");
    url.searchParams.set("search_type", "scan");
    url.searchParams.set("limit", "100");
    if (scrollId) url.searchParams.set("scroll_id", scrollId);
    const r = await axios.get(url.toString(), { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const ids: string[] = r.data?.results || [];
    if (!ids.length) break;
    for (const id of ids) {
      out.push(id);
      if (max && out.length >= max) return out;
    }
    scrollId = r.data?.scroll_id;
    if (!scrollId) break;
    await new Promise(res => setTimeout(res, 100));
  }
  return out;
}

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const SAMPLE = process.env.SAMPLE ? Number(process.env.SAMPLE) : undefined;
const ACCOUNT_FILTER = process.env.ACCOUNT;

// Limites oficiais Mercado Envios padrão (Brasil): 30 kg, soma L+A+P 200 cm, lado maior 100 cm.
// Mín. técnicos: 1 cm / 1 g, valores numéricos positivos.
const ML_MAX_WEIGHT_KG = 30;
const ML_MAX_SIDE_CM = 100;
const ML_MAX_SUM_LWH_CM = 200;
const ML_MIN_DIM_CM = 1;
const ML_MIN_WEIGHT_G = 1;

type Issue =
  | "MISSING_ALL"
  | "MISSING_DIMENSIONS"
  | "MISSING_WEIGHT"
  | "INVALID_FORMAT"
  | "ZERO_OR_NEGATIVE"
  | "EXCEEDS_MAX_SIDE"
  | "EXCEEDS_MAX_SUM"
  | "EXCEEDS_MAX_WEIGHT"
  | "BELOW_MIN_DIM"
  | "BELOW_MIN_WEIGHT"
  | "ATTR_MISMATCH_SHIPPING_VS_ATTR"
  | "MODERATED";

interface Row {
  itemId: string;
  account: string;
  status: string;
  title: string;
  category: string;
  permalink?: string;
  shippingDimensionsRaw?: string | null;
  height?: number;
  width?: number;
  length?: number;
  weightG?: number;
  sumLWH?: number;
  maxSide?: number;
  attrPkgHeight?: string;
  attrPkgWidth?: string;
  attrPkgLength?: string;
  attrPkgWeight?: string;
  issues: Issue[];
  severity: "OK" | "WARN" | "BLOCK";
  notes: string[];
}

function parseShippingDimensions(s?: string | null) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/i);
  if (!m) return { invalidFormat: true as const };
  return {
    invalidFormat: false as const,
    height: Number(m[1]),
    width: Number(m[2]),
    length: Number(m[3]),
    weightG: Number(m[4]),
  };
}

function findAttr(attrs: any[] | undefined, id: string): string | undefined {
  if (!Array.isArray(attrs)) return undefined;
  const a = attrs.find((x) => x?.id === id);
  return a?.value_name ?? a?.value_struct?.number ?? undefined;
}

async function getValidAccessToken(account: any): Promise<string> {
  const now = new Date();
  if (account.expiresAt && new Date(account.expiresAt) > new Date(now.getTime() + 60_000)) {
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessToken(account.refreshToken);
  await prisma.marketplaceAccount.update({
    where: { id: account.id },
    data: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    },
  });
  return refreshed.accessToken;
}

async function auditAccount(account: any): Promise<Row[]> {
  console.log(`\n=== Conta ${account.accountName} (${account.externalUserId}) ===`);
  const token = await getValidAccessToken(account);
  const sellerId = account.externalUserId!;
  const ids = await fetchActiveItemIds(token, sellerId, SAMPLE);
  console.log(`[${account.accountName}] ${ids.length} item IDs`);

  const details = await MLApiService.getItemsDetails(token, ids);
  console.log(`[${account.accountName}] ${details.length} detalhes carregados`);

  const rows: Row[] = [];
  for (const it of details) {
    const item: any = it;
    const shippingDims = item?.shipping?.dimensions ?? null;
    const parsed = parseShippingDimensions(shippingDims);
    const attrs = item?.attributes;
    const aH = findAttr(attrs, "SELLER_PACKAGE_HEIGHT") || findAttr(attrs, "PACKAGE_HEIGHT");
    const aW = findAttr(attrs, "SELLER_PACKAGE_WIDTH") || findAttr(attrs, "PACKAGE_WIDTH");
    const aL = findAttr(attrs, "SELLER_PACKAGE_LENGTH") || findAttr(attrs, "PACKAGE_LENGTH");
    const aWg = findAttr(attrs, "SELLER_PACKAGE_WEIGHT") || findAttr(attrs, "PACKAGE_WEIGHT");

    const issues: Issue[] = [];
    const notes: string[] = [];
    let height: number | undefined,
      width: number | undefined,
      length: number | undefined,
      weightG: number | undefined;

    if (!shippingDims && !aH && !aW && !aL && !aWg) {
      issues.push("MISSING_ALL");
    } else if (parsed && parsed.invalidFormat) {
      issues.push("INVALID_FORMAT");
      notes.push(`shipping.dimensions=${shippingDims} fora do regex HxWxL,gramas`);
    } else if (parsed) {
      height = parsed.height;
      width = parsed.width;
      length = parsed.length;
      weightG = parsed.weightG;
    } else {
      issues.push("MISSING_DIMENSIONS");
    }

    if (height != null) {
      const sides = [height, width!, length!];
      if (sides.some((v) => v <= 0)) issues.push("ZERO_OR_NEGATIVE");
      if (sides.some((v) => v < ML_MIN_DIM_CM)) issues.push("BELOW_MIN_DIM");
      const maxSide = Math.max(...sides);
      const sum = sides.reduce((a, b) => a + b, 0);
      if (maxSide > ML_MAX_SIDE_CM) issues.push("EXCEEDS_MAX_SIDE");
      if (sum > ML_MAX_SUM_LWH_CM) issues.push("EXCEEDS_MAX_SUM");
      if (weightG != null) {
        if (weightG <= 0) issues.push("ZERO_OR_NEGATIVE");
        if (weightG < ML_MIN_WEIGHT_G) issues.push("BELOW_MIN_WEIGHT");
        if (weightG / 1000 > ML_MAX_WEIGHT_KG) issues.push("EXCEEDS_MAX_WEIGHT");
      } else {
        issues.push("MISSING_WEIGHT");
      }
    }

    if (parsed && !parsed.invalidFormat) {
      const triples: Array<[string | undefined, number, string]> = [
        [aH, height!, "altura"],
        [aW, width!, "largura"],
        [aL, length!, "comprimento"],
      ];
      for (const [av, sv, label] of triples) {
        if (av) {
          const num = Number(String(av).replace(/[^\d.]/g, ""));
          if (Number.isFinite(num) && Math.abs(num - sv) > 0.5) {
            issues.push("ATTR_MISMATCH_SHIPPING_VS_ATTR");
            notes.push(`${label}: attr=${av} vs shipping=${sv}`);
          }
        }
      }
      if (aWg) {
        const num = Number(String(aWg).replace(/[^\d.]/g, ""));
        const inG = String(aWg).toLowerCase().includes("kg") ? num * 1000 : num;
        if (Number.isFinite(inG) && weightG != null && Math.abs(inG - weightG) > 5) {
          issues.push("ATTR_MISMATCH_SHIPPING_VS_ATTR");
          notes.push(`peso: attr=${aWg} vs shipping=${weightG}g`);
        }
      }
    }

    if (
      item?.status === "under_review" ||
      (Array.isArray(item?.sub_status) &&
        item.sub_status.some((s: string) => /warning|freeze|moderat/i.test(s)))
    ) {
      issues.push("MODERATED");
      notes.push(`status=${item.status} sub_status=${JSON.stringify(item.sub_status || [])}`);
    }

    const severity: Row["severity"] =
      issues.length === 0
        ? "OK"
        : issues.some((i) =>
              [
                "MISSING_ALL",
                "MISSING_DIMENSIONS",
                "MISSING_WEIGHT",
                "INVALID_FORMAT",
                "EXCEEDS_MAX_SIDE",
                "EXCEEDS_MAX_SUM",
                "EXCEEDS_MAX_WEIGHT",
                "ZERO_OR_NEGATIVE",
                "MODERATED",
              ].includes(i),
            )
          ? "BLOCK"
          : "WARN";

    const sides = [height, width, length].filter((v): v is number => v != null);
    rows.push({
      itemId: item.id,
      account: account.accountName,
      status: item.status,
      title: item.title,
      category: item.category_id,
      permalink: item.permalink,
      shippingDimensionsRaw: shippingDims,
      height,
      width,
      length,
      weightG,
      sumLWH: sides.length === 3 ? sides.reduce((a, b) => a + b, 0) : undefined,
      maxSide: sides.length ? Math.max(...sides) : undefined,
      attrPkgHeight: aH,
      attrPkgWidth: aW,
      attrPkgLength: aL,
      attrPkgWeight: aWg,
      issues,
      severity,
      notes,
    });
  }
  return rows;
}

async function main() {
  const accounts = await prisma.marketplaceAccount.findMany({
    where: {
      userId: USER_ID,
      platform: "MERCADO_LIVRE",
      ...(ACCOUNT_FILTER ? { id: ACCOUNT_FILTER } : {}),
    },
  });
  console.log(
    "Contas:",
    accounts.map((a) => `${a.accountName}/${a.externalUserId}`),
  );
  const all: Row[] = [];
  for (const acc of accounts) {
    try {
      const rows = await auditAccount(acc);
      all.push(...rows);
    } catch (e: any) {
      console.error(`Falha auditando ${acc.accountName}:`, e?.message || e);
    }
  }

  fs.mkdirSync(path.join("scripts", "out"), { recursive: true });
  const jsonPath = path.join("scripts", "out", "ml-dims-audit.json");
  fs.writeFileSync(jsonPath, JSON.stringify(all, null, 2));

  const total = all.length;
  const block = all.filter((r) => r.severity === "BLOCK").length;
  const warn = all.filter((r) => r.severity === "WARN").length;
  const ok = all.filter((r) => r.severity === "OK").length;
  const byIssue: Record<string, number> = {};
  for (const r of all) for (const i of r.issues) byIssue[i] = (byIssue[i] || 0) + 1;
  const byAccount: Record<string, { total: number; block: number; warn: number; ok: number }> = {};
  for (const r of all) {
    byAccount[r.account] ||= { total: 0, block: 0, warn: 0, ok: 0 };
    byAccount[r.account].total++;
    byAccount[r.account][r.severity.toLowerCase() as "block" | "warn" | "ok"]++;
  }

  console.log("\n=== RESUMO ===");
  console.log({ total, ok, warn, block });
  console.log("Por conta:", byAccount);
  console.log("Por tipo de problema:", byIssue);
  console.log(`Detalhes salvos em ${jsonPath}`);

  const csvPath = path.join("scripts", "out", "ml-dims-audit.csv");
  const headers = [
    "itemId",
    "account",
    "status",
    "title",
    "category",
    "severity",
    "issues",
    "shipping",
    "H",
    "W",
    "L",
    "weightG",
    "attrH",
    "attrW",
    "attrL",
    "attrWeight",
    "notes",
    "permalink",
  ];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const r of all.filter((r) => r.severity !== "OK")) {
    lines.push(
      [
        r.itemId,
        r.account,
        r.status,
        r.title,
        r.category,
        r.severity,
        r.issues.join("|"),
        r.shippingDimensionsRaw,
        r.height,
        r.width,
        r.length,
        r.weightG,
        r.attrPkgHeight,
        r.attrPkgWidth,
        r.attrPkgLength,
        r.attrPkgWeight,
        r.notes.join(" | "),
        r.permalink,
      ]
        .map(esc)
        .join(","),
    );
  }
  fs.writeFileSync(csvPath, lines.join("\n"));
  console.log(`CSV salvo em ${csvPath}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
