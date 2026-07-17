import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import prisma from "../app/lib/prisma";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { applyOverridesToProduct } from "../app/marketplaces/services/listing-overrides.service";

/**
 * Backfill do atributo LADO/POSIÇÃO (POSITION) em anúncios ML já publicados
 * SEM ele — complementa o Bloco A (que passou a capturar/enviar POSITION na
 * criação/edição). Higieniza a ficha técnica dos anúncios existentes.
 *
 * DUAS FASES (READ-ONLY por padrão):
 *  - Fase 1 (padrão): NÃO escreve nada. Para cada anúncio ML ativo do
 *    user/conta, computa o produto EFETIVO (applyOverridesToProduct), deriva a
 *    POSITION pretendida com a MESMA regra do buildMLAttributes (valor do
 *    operador em product.attributes.POSITION vence; senão inferência
 *    dianteira/traseira nas 2 categorias-porta), lê a POSITION atual via
 *    GET /items/{id} e emite um CSV do que MUDARIA. Serve p/ dimensionar o
 *    alcance antes de aplicar.
 *  - Fase 2 (APPLY, opt-in): só quando POSITION_BACKFILL=apply. Para as linhas
 *    "mudaria=SIM", faz PUT /items/{id} enviando SOMENTE POSITION (nunca
 *    preço/estoque/título/fotos). Idempotente (pula quando já igual); pula
 *    inativos e (com --skip-sold) itens com venda; segue em erro (403/409/
 *    field_not_modifiable) logando. Verifica o dono do item antes de escrever.
 *
 * Uso:
 *   tsx scripts/backfill-ml-position.ts --user=ID                (Fase 1, dry-run)
 *   tsx scripts/backfill-ml-position.ts --user=ID --category=MLB101763
 *   tsx scripts/backfill-ml-position.ts --user=ID --limit=200
 *   POSITION_BACKFILL=apply tsx scripts/backfill-ml-position.ts --user=ID --limit=50  (Fase 2)
 *
 * Flags: --account-id / --account-name / --all-accounts (default: todas as
 * contas ML do user), --limit=N, --category=MLBxxxx (só essa categoria efetiva),
 * --skip-sold (pula itens com sold_quantity > 0).
 */

const DOOR_CATEGORIES = new Set(["MLB101763", "MLB458642"]);
const APPLY = process.env.POSITION_BACKFILL === "apply";
const APPLY_DELAY_MS = 250; // respeita rate-limit do ML entre PUTs

/** Remove sufixos internos "-NN" (ids sintéticos do front persistidos em
 * produtos antigos) — paridade com a normalização do fluxo de criação. Sem
 * isto, "MLB101763-01" não casaria DOOR_CATEGORIES nem o --category=. */
const normalizeCategoryId = (id: unknown): string | null => {
  const s = id === null || id === undefined ? "" : String(id).trim();
  if (!s) return null;
  return s.replace(/-\d+$/, "");
};

const args = process.argv.slice(2);
const getArg = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? null;
const userId = getArg("user");
const accountIdOverride = getArg("account-id");
const accountNameOverride = getArg("account-name");
if (
  args.includes("--all-accounts") &&
  (accountIdOverride || accountNameOverride)
) {
  console.error(
    "[backfill-position] --all-accounts não combina com --account-id/--account-name.",
  );
  process.exit(1);
}
const allAccounts =
  args.includes("--all-accounts") ||
  (!accountIdOverride && !accountNameOverride);
const categoryFilter = normalizeCategoryId(getArg("category"));
const skipSold = args.includes("--skip-sold");
// --limit inválido NÃO pode degradar silenciosamente para "sem teto" (em
// APPLY isso removeria o limite de segurança): valida e aborta.
const limitRaw = getArg("limit");
const limit = limitRaw === null ? 0 : Number(limitRaw);
if (limitRaw !== null && (!Number.isFinite(limit) || limit < 0)) {
  console.error(`[backfill-position] --limit inválido: ${limitRaw}`);
  process.exit(1);
}

interface PosValue {
  value_id?: string;
  value_name?: string;
}

/** Regra fiel ao buildMLAttributes: operador vence; senão inferência nas portas. */
function intendedPosition(
  effProduct: any,
  resolvedCategoryId: string | null,
): PosValue | null {
  const opPos = effProduct?.attributes?.POSITION;
  const opId =
    typeof opPos?.value_id === "string" && opPos.value_id.trim().length > 0
      ? opPos.value_id.trim()
      : undefined;
  const opName =
    typeof opPos?.value_name === "string" && opPos.value_name.trim().length > 0
      ? opPos.value_name.trim()
      : undefined;
  if (opId || opName) return { value_id: opId, value_name: opName };

  if (resolvedCategoryId && DOOR_CATEGORIES.has(resolvedCategoryId)) {
    const name = String(effProduct?.name || "").toLowerCase();
    const pos = /dianteir|frente/.test(name)
      ? "Dianteira"
      : /traseir|tras|trás/.test(name)
        ? "Traseira"
        : null;
    if (pos) return { value_name: pos };
  }
  return null;
}

/** POSITION atual do item vivo (attributes[]). */
function currentPosition(item: any): PosValue | null {
  const attrs = item?.attributes;
  if (!Array.isArray(attrs)) return null;
  const p = attrs.find((a: any) => a?.id === "POSITION");
  if (!p) return null;
  return { value_id: p.value_id ?? undefined, value_name: p.value_name ?? undefined };
}

const normPos = (s?: string) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** Igualdade: por value_id quando AMBOS têm id; senão por value_name
 * NORMALIZADO (case/acento-insensível). O ML canonicaliza value_name (ex.:
 * "dianteira" → "Dianteira") — comparação exata marcaria "mudaria=SIM"
 * perpétuo e geraria PUT redundante em toda execução apply. */
function samePosition(intended: PosValue, current: PosValue | null): boolean {
  if (!current) return false;
  if (intended.value_id && current.value_id)
    return intended.value_id === current.value_id;
  const a = normPos(intended.value_name);
  return a !== "" && a === normPos(current.value_name);
}

const tokenCache = new Map<string, string>();
async function getValidToken(account: {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}): Promise<string> {
  const cached = tokenCache.get(account.id);
  if (cached) return cached;
  if (new Date(account.expiresAt).getTime() > Date.now() + 60_000) {
    tokenCache.set(account.id, account.accessToken);
    return account.accessToken;
  }
  const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
    account.id,
    account.refreshToken,
  );
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

async function resolveTargetAccountIds(): Promise<string[]> {
  const all = await prisma.marketplaceAccount.findMany({
    where: { userId: userId!, platform: "MERCADO_LIVRE" },
    select: { id: true, accountName: true },
  });
  if (allAccounts) return all.map((a) => a.id);
  if (accountIdOverride) {
    const found = all.find((a) => a.id === accountIdOverride);
    if (!found) throw new Error(`Conta ${accountIdOverride} não é ML do user ${userId}.`);
    return [found.id];
  }
  const match = (accountNameOverride ?? "").toLowerCase();
  return all
    .filter((a) => (a.accountName || "").toLowerCase().includes(match))
    .map((a) => a.id);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
const posStr = (p: PosValue | null) =>
  !p ? "" : `${p.value_id ?? ""}|${p.value_name ?? ""}`;

async function main(): Promise<void> {
  if (!userId) {
    console.error("Uso: tsx scripts/backfill-ml-position.ts --user=ID [flags]");
    process.exit(1);
  }
  console.log(
    `[backfill-position] userId=${userId} mode=${APPLY ? "APPLY" : "DRY-RUN"} ` +
      `category=${categoryFilter ?? "(todas)"} limit=${limit || "∞"} skipSold=${skipSold}`,
  );

  const accountIds = await resolveTargetAccountIds();
  if (accountIds.length === 0) {
    console.error("[backfill-position] nenhuma conta ML alvo.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const products = await prisma.product.findMany({
    where: {
      userId,
      listings: {
        some: {
          marketplaceAccountId: { in: accountIds },
          marketplaceAccount: { platform: "MERCADO_LIVRE" },
          externalListingId: { startsWith: "MLB" },
        },
      },
    },
    include: {
      listings: {
        where: {
          marketplaceAccountId: { in: accountIds },
          marketplaceAccount: { platform: "MERCADO_LIVRE" },
          externalListingId: { startsWith: "MLB" },
        },
        include: { marketplaceAccount: true },
      },
    },
  });

  const rows: string[] = [
    [
      "itemId",
      "sku",
      "categoryEfetiva",
      "status",
      "soldQty",
      "posAtual",
      "posPretendida",
      "mudaria",
      "skipReason",
    ]
      .map(csvCell)
      .join(","),
  ];

  let scanned = 0;
  let wouldChange = 0;
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  outer: for (const product of products) {
    for (const listing of product.listings) {
      if (limit && scanned >= limit) break outer;
      const itemId = listing.externalListingId;
      const eff = applyOverridesToProduct(product as any, listing as any);
      const resolvedCategoryId = normalizeCategoryId(
        (eff as any).mlCategoryId || (eff as any).mlCategory || null,
      );

      if (categoryFilter && resolvedCategoryId !== categoryFilter) continue;
      scanned++;

      const intended = intendedPosition(eff, resolvedCategoryId);
      if (!intended) {
        skipped++;
        rows.push(
          [itemId, product.sku, resolvedCategoryId, listing.status, "", "", "", "NAO", "sem-posicao-pretendida"]
            .map(csvCell)
            .join(","),
        );
        continue;
      }

      let token: string;
      try {
        token = await getValidToken(listing.marketplaceAccount as any);
      } catch (e) {
        failed++;
        rows.push(
          [itemId, product.sku, resolvedCategoryId, listing.status, "", "", posStr(intended), "?", `token-erro: ${e instanceof Error ? e.message : e}`]
            .map(csvCell)
            .join(","),
        );
        continue;
      }

      let item: any;
      try {
        item = await MLApiService.getItemDetails(token, itemId);
      } catch (e) {
        failed++;
        rows.push(
          [itemId, product.sku, resolvedCategoryId, listing.status, "", "", posStr(intended), "?", `get-erro: ${e instanceof Error ? e.message : e}`]
            .map(csvCell)
            .join(","),
        );
        continue;
      }

      const liveStatus = item?.status ?? listing.status;
      const soldQty = Number(item?.sold_quantity ?? 0);
      const current = currentPosition(item);

      // Dono do item: o token já é o da conta dona da linha, mas conferimos
      // explicitamente o seller_id do item vivo contra o externalUserId da
      // conta antes de qualquer PUT (defesa extra contra vínculo corrompido).
      const accExternalUserId = (listing.marketplaceAccount as any)
        .externalUserId as string | null | undefined;
      const ownerMismatch =
        !!accExternalUserId &&
        item?.seller_id != null &&
        String(item.seller_id) !== String(accExternalUserId);

      let skipReason = "";
      if (ownerMismatch) skipReason = "dono-divergente";
      else if (liveStatus !== "active") skipReason = `status=${liveStatus}`;
      else if (skipSold && soldQty > 0) skipReason = `sold=${soldQty}`;
      else if (samePosition(intended, current)) skipReason = "ja-igual";

      const changes = !skipReason;
      if (changes) wouldChange++;
      else skipped++;

      rows.push(
        [
          itemId,
          product.sku,
          resolvedCategoryId,
          liveStatus,
          soldQty,
          posStr(current),
          posStr(intended),
          changes ? "SIM" : "NAO",
          skipReason,
        ]
          .map(csvCell)
          .join(","),
      );

      if (changes && APPLY) {
        try {
          const posAttr: PosValue & { id: string } = { id: "POSITION" };
          if (intended.value_id) posAttr.value_id = intended.value_id;
          if (intended.value_name) posAttr.value_name = intended.value_name;
          await MLApiService.updateItem(token, itemId, {
            attributes: [posAttr],
          } as any);
          applied++;
          console.log(`  ✓ ${itemId} POSITION ← ${posStr(intended)}`);
          await new Promise((r) => setTimeout(r, APPLY_DELAY_MS));
        } catch (e) {
          failed++;
          console.warn(
            `  ✗ ${itemId} falhou: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    }
  }

  const outDir = path.join(process.cwd(), "scripts", "out");
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(
    outDir,
    `position-backfill-${APPLY ? "apply" : "dryrun"}-${stamp}.csv`,
  );
  await fs.writeFile(outFile, rows.join("\n"), "utf8");

  console.log("\n=== Resumo ===");
  console.log(`  Anúncios avaliados:        ${scanned}`);
  console.log(`  Mudariam (POSITION):       ${wouldChange}`);
  if (APPLY) console.log(`  Aplicados (PUT):           ${applied}`);
  console.log(`  Pulados:                   ${skipped}`);
  console.log(`  Falhas:                    ${failed}`);
  console.log(`  CSV: ${outFile}`);
  if (!APPLY && wouldChange > 0) {
    console.log(
      "\n  Fase 1 (read-only). Para aplicar: POSITION_BACKFILL=apply tsx scripts/backfill-ml-position.ts --user=... --limit=50",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backfill-position] erro fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
