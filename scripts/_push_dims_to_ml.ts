/**
 * Envia SELLER_PACKAGE_HEIGHT/WIDTH/LENGTH/WEIGHT para anúncios ML, respeitando:
 *  - skip-already-filled  → não toca (evita regredir manual do usuário)
 *  - push-tier            → usa tier resolvido por _ml_dim_defaults
 *  - push-with-catalog-floor → max(tier, catalog) por eixo (constraint do catálogo ML)
 *
 * Lê: scripts/out/ml-dims-enriched.json (gerado por _enrich_audit_catalog.ts)
 * Saída:
 *   - scripts/out/ml-push-plan.csv      (sempre)
 *   - scripts/out/ml-push-result.csv    (apenas com APPLY=1)
 *
 * Modos:
 *   npx tsx scripts/_push_dims_to_ml.ts             -> DRY-RUN
 *   APPLY=1 npx tsx scripts/_push_dims_to_ml.ts     -> aplica tudo
 *   LIMIT=20 APPLY=1 ...                            -> smoke-test
 *   ACCOUNT="JOTABEDESMONTE" ...                    -> filtra conta
 *   STRATEGY=push-tier ...                          -> roda só uma estratégia
 *
 * Segurança:
 *  - NÃO toca em shipping.dimensions (campo imutável em itens existentes).
 *  - Concorrência baixa (4) e pausa entre requests para suavizar rate limit.
 *  - Cada PUT é isolado: falha de um item não para o lote.
 *  - Valida limites Mercado Envios (lado ≤100cm, soma ≤200cm, peso ≤30kg).
 *    Itens que violam → marcados como skip-violation, NÃO enviados.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { resolveDim } from "./_ml_dim_defaults";

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const APPLY = process.env.APPLY === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
const ACCOUNT_FILTER = process.env.ACCOUNT;
const STRATEGY_FILTER = process.env.STRATEGY;
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

// Limites Mercado Envios padrão Brasil
const MAX_SIDE_CM = 100;
const MAX_SUM_CM = 200;
const MAX_WEIGHT_G = 30_000;

interface CatalogDims {
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  weightG?: number;
}

interface EnrichedRow {
  itemId: string;
  account: string;
  status: string;
  title: string;
  category: string;
  catalogProductId: string | null;
  catalogDims: CatalogDims | null;
  strategy:
    | "skip-already-filled"
    | "skip-no-shipping-immutable"
    | "push-with-catalog-floor"
    | "push-tier"
    | "skip-not-block";
}

async function getValidAccessToken(account: any): Promise<string | null> {
  const now = new Date();
  if (account.expiresAt && new Date(account.expiresAt) > new Date(now.getTime() + 60_000)) {
    return account.accessToken;
  }
  try {
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
  } catch (e: any) {
    console.warn(`[token] FALHA refresh ${account.accountName}: ${e?.message || e}`);
    return null;
  }
}

async function main() {
  const enrichedPath = path.join("scripts", "out", "ml-dims-enriched.json");
  if (!fs.existsSync(enrichedPath)) {
    throw new Error(`${enrichedPath} não existe — rode _enrich_audit_catalog.ts antes.`);
  }
  let rows: EnrichedRow[] = JSON.parse(fs.readFileSync(enrichedPath, "utf-8"));

  // Pular itens já completos (proteção contra regressão)
  rows = rows.filter((r) => r.strategy === "push-tier" || r.strategy === "push-with-catalog-floor");
  if (ACCOUNT_FILTER) rows = rows.filter((r) => r.account === ACCOUNT_FILTER);
  if (STRATEGY_FILTER) rows = rows.filter((r) => r.strategy === STRATEGY_FILTER);
  if (LIMIT) rows = rows.slice(0, LIMIT);

  console.log(
    `[ml-push] modo=${APPLY ? "APPLY" : "DRY-RUN"} · ${rows.length} anúncios alvo · conc=${CONCURRENCY}`,
  );

  // Tokens
  const accounts = await prisma.marketplaceAccount.findMany({
    where: { userId: USER_ID, platform: "MERCADO_LIVRE" },
  });
  const tokenByAccount = new Map<string, string>();
  for (const acc of accounts) {
    const t = await getValidAccessToken(acc);
    if (!t) {
      console.warn(`[ml-push] conta ${acc.accountName} sem token válido`);
      continue;
    }
    tokenByAccount.set(acc.accountName, t);
  }

  type PlanRow = {
    itemId: string;
    account: string;
    category: string;
    title: string;
    strategy: string;
    catalogProductId: string | null;
    tierH: number;
    tierW: number;
    tierL: number;
    tierWg: number;
    catH: number | "";
    catW: number | "";
    catL: number | "";
    catWg: number | "";
    h: number;
    w: number;
    l: number;
    weightG: number;
    source: string;
    skipReason?: string;
    status?: "ok" | "error" | "skipped";
    error?: string;
  };

  // Gera plano com floor de catálogo
  const plan: PlanRow[] = rows.map((r) => {
    const tier = resolveDim(r.category, r.title);
    const tierH = tier.heightCm;
    const tierW = tier.widthCm;
    const tierL = tier.lengthCm;
    const tierWg = Math.round(tier.weightKg * 1000);

    const cat = r.catalogDims;
    const catH = cat?.heightCm;
    const catW = cat?.widthCm;
    const catL = cat?.lengthCm;
    const catWg = cat?.weightG;

    // max(tier, catalog) por eixo se push-with-catalog-floor
    const useFloor = r.strategy === "push-with-catalog-floor" && cat;
    const h = useFloor && catH ? Math.max(tierH, Math.ceil(catH)) : tierH;
    const w = useFloor && catW ? Math.max(tierW, Math.ceil(catW)) : tierW;
    const l = useFloor && catL ? Math.max(tierL, Math.ceil(catL)) : tierL;
    const weightG = useFloor && catWg ? Math.max(tierWg, Math.ceil(catWg)) : tierWg;

    // Validação Mercado Envios
    let skipReason: string | undefined;
    if (h > MAX_SIDE_CM || w > MAX_SIDE_CM || l > MAX_SIDE_CM) {
      skipReason = `side>${MAX_SIDE_CM}cm (${h}x${w}x${l})`;
    } else if (h + w + l > MAX_SUM_CM) {
      skipReason = `sum>${MAX_SUM_CM}cm (${h + w + l})`;
    } else if (weightG > MAX_WEIGHT_G) {
      skipReason = `weight>${MAX_WEIGHT_G}g (${weightG})`;
    }

    return {
      itemId: r.itemId,
      account: r.account,
      category: r.category,
      title: r.title,
      strategy: r.strategy,
      catalogProductId: r.catalogProductId,
      tierH, tierW, tierL, tierWg,
      catH: catH ?? "",
      catW: catW ?? "",
      catL: catL ?? "",
      catWg: catWg ?? "",
      h, w, l, weightG,
      source: tier.source + (useFloor ? "+catFloor" : ""),
      skipReason,
    };
  });

  // Resumo
  const summary: Record<string, number> = {};
  let willSendCount = 0;
  let skipViolationCount = 0;
  for (const p of plan) {
    summary[p.strategy] = (summary[p.strategy] || 0) + 1;
    if (p.skipReason) skipViolationCount++;
    else willSendCount++;
  }
  console.log("\n=== PLANO ===");
  console.log("Por estratégia:", summary);
  console.log(`Enviar: ${willSendCount}`);
  console.log(`Pular (violação Mercado Envios): ${skipViolationCount}`);

  // Plan CSV
  fs.mkdirSync(path.join("scripts", "out"), { recursive: true });
  const planPath = path.join("scripts", "out", "ml-push-plan.csv");
  const headers = [
    "itemId","account","category","strategy","catalogProductId",
    "tierH","tierW","tierL","tierWg","catH","catW","catL","catWg",
    "h","w","l","weightG","source","skipReason","title",
  ];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const p of plan) {
    lines.push([
      p.itemId, p.account, p.category, p.strategy, p.catalogProductId,
      p.tierH, p.tierW, p.tierL, p.tierWg, p.catH, p.catW, p.catL, p.catWg,
      p.h, p.w, p.l, p.weightG, p.source, p.skipReason, p.title,
    ].map(esc).join(","));
  }
  fs.writeFileSync(planPath, lines.join("\n"));
  console.log(`Plano salvo em ${planPath}`);

  if (!APPLY) {
    console.log("\nDRY-RUN: nenhum PUT feito.");
    process.exit(0);
  }

  // ===== APPLY =====
  console.log("\n=== APPLY ===");
  let ok = 0, err = 0, skipped = 0;
  let nextIdx = 0;
  const result: PlanRow[] = [];

  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= plan.length) break;
      const p = plan[i];

      if (p.skipReason) {
        result.push({ ...p, status: "skipped", error: p.skipReason });
        skipped++;
        continue;
      }

      const token = tokenByAccount.get(p.account);
      if (!token) {
        result.push({ ...p, status: "error", error: "no token" });
        err++;
        continue;
      }

      const payload = {
        attributes: [
          { id: "SELLER_PACKAGE_HEIGHT", value_name: `${p.h} cm` },
          { id: "SELLER_PACKAGE_WIDTH",  value_name: `${p.w} cm` },
          { id: "SELLER_PACKAGE_LENGTH", value_name: `${p.l} cm` },
          { id: "SELLER_PACKAGE_WEIGHT", value_name: `${p.weightG} g` },
        ],
      };
      try {
        await MLApiService.updateItem(token, p.itemId, payload as any);
        result.push({ ...p, status: "ok" });
        ok++;
      } catch (e: any) {
        const msg = e?.message || String(e);
        result.push({ ...p, status: "error", error: msg });
        err++;
        console.error(`[ml-push] FAIL ${p.itemId} :: ${msg.slice(0, 200)}`);
      }
      await new Promise((res) => setTimeout(res, 60));
      if ((ok + err + skipped) % 100 === 0) {
        console.log(`[ml-push] ${ok + err + skipped}/${plan.length}  ok=${ok}  err=${err}  skip=${skipped}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const resultPath = path.join("scripts", "out", "ml-push-result.csv");
  const resHeaders = [...headers, "status"];
  const resLines = [resHeaders.join(",")];
  for (const r of result) {
    resLines.push([
      r.itemId, r.account, r.category, r.strategy, r.catalogProductId,
      r.tierH, r.tierW, r.tierL, r.tierWg, r.catH, r.catW, r.catL, r.catWg,
      r.h, r.w, r.l, r.weightG, r.source, r.skipReason || r.error, r.title, r.status,
    ].map(esc).join(","));
  }
  fs.writeFileSync(resultPath, resLines.join("\n"));
  console.log(`Resultado em ${resultPath}`);
  console.log(`Final: ok=${ok}, err=${err}, skipped=${skipped}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
