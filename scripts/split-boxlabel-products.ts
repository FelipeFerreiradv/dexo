import "dotenv/config";
import { Platform } from "@prisma/client";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import {
  areTitlesSimilar,
  titleSimilarity,
} from "../app/lib/title-similarity";
import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLOAuthService } from "../app/marketplaces/services/ml-oauth.service";
import { ListingAutodetectUseCase } from "../app/marketplaces/usecases/listing-autodetect.usercase";

/**
 * Limpeza de produtos MAL-AGRUPADOS por "SKU de caixa" (split in-place + enrich).
 *
 * Quando o vendedor reusa um rótulo de caixa/palete como SKU (`Caixa mangueiras`,
 * `Caixote 2`) em vários anúncios diferentes, o import antigo colapsava todos num
 * único Product. Detecta produtos onde UMA conta tem 2+ anúncios com título
 * CLARAMENTE diferente do keeper e SEPARA cada excedente num produto próprio:
 *   - mantém no produto original o anúncio cujo título mais casa com o nome atual;
 *   - cada outro anúncio vira um Product novo e o listing é re-apontado.
 *
 * ENRICH (padrão ON): busca o anúncio REAL no Mercado Livre por externalListingId
 * (qualquer status) e usa nome/preço/imagens verdadeiros no produto novo. Sem
 * enrich (ou fora do ML), cai no nome do slug do permalink + preço/imagem
 * herdados do original (placeholder). PRESERVA todos os listings e o histórico.
 *
 * Uso:
 *   tsx scripts/split-boxlabel-products.ts --email=x@y.com                # dry-run + enrich
 *   tsx scripts/split-boxlabel-products.ts --email=x@y.com --no-enrich    # dry-run rápido (slug)
 *   tsx scripts/split-boxlabel-products.ts --email=x@y.com --limit=10     # amostra
 *   tsx scripts/split-boxlabel-products.ts --email=x@y.com --apply        # grava (com enrich)
 *
 * Sem `--apply` é DRY-RUN (não grava nada). O enrich é read-only nos dois modos.
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };
  const rawLimit = get("limit");
  return {
    email: get("email"),
    userId: get("user-id"),
    limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
    apply: args.includes("--apply"),
    enrich: !args.includes("--no-enrich"),
  };
}

/** Deriva um título legível do slug do permalink do ML (MLB-<id>-slug-_JM). */
function titleFromPermalink(permalink: string | null): string | null {
  if (!permalink) return null;
  let path = permalink;
  try {
    path = new URL(permalink).pathname;
  } catch {
    /* usa a string crua */
  }
  const slug = path.replace(/\/+$/, "").replace(/-_JM$/i, "");
  const m = slug.match(/[A-Za-z]{2,4}-?\d+-(.+)$/);
  if (!m) return null;
  const words = m[1].split("-").filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 200);
}

type Account = {
  id: string;
  accountName: string | null;
  platform: Platform;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
};

type L = {
  id: string;
  productId: string;
  externalListingId: string;
  permalink: string | null;
  status: string;
  marketplaceAccountId: string;
  accountName: string | null;
  product: {
    id: string;
    name: string;
    sku: string;
    price: unknown;
    stock: number;
    imageUrl: string | null;
    originPlatform: string | null;
  };
};

type EnrichData = {
  title: string;
  price: number;
  imageUrl: string | null;
  imageUrls: string[];
};

// Token ML válido (refresca se perto de expirar). null se indisponível.
async function getMlToken(acc: Account): Promise<string | null> {
  const soon =
    !acc.accessToken ||
    (acc.expiresAt ? acc.expiresAt.getTime() - Date.now() < 5 * 60 * 1000 : false);
  if (soon && acc.refreshToken) {
    try {
      const r = await MLOAuthService.refreshAccessTokenForAccount(
        acc.id,
        acc.refreshToken,
      );
      return r.accessToken;
    } catch (e) {
      console.error(
        `  refresh token falhou p/ ${acc.accountName}:`,
        e instanceof Error ? e.message : e,
      );
      return acc.accessToken;
    }
  }
  return acc.accessToken;
}

async function enrichFromMl(
  splitListings: L[],
  accounts: Account[],
  dataOwnerId: string,
): Promise<Map<string, EnrichData>> {
  const map = new Map<string, EnrichData>();
  const mlAccts = accounts.filter((a) => a.platform === Platform.MERCADO_LIVRE);
  const byAcct = new Map<string, string[]>();
  for (const l of splitListings) {
    if (!mlAccts.some((a) => a.id === l.marketplaceAccountId)) continue;
    const arr = byAcct.get(l.marketplaceAccountId) ?? [];
    arr.push(l.externalListingId);
    byAcct.set(l.marketplaceAccountId, arr);
  }
  for (const [acctId, ids] of byAcct) {
    const acc = mlAccts.find((a) => a.id === acctId)!;
    const token = await getMlToken(acc);
    if (!token) {
      console.log(`  enrich ${acc.accountName}: sem token → fallback slug`);
      continue;
    }
    try {
      const items = await MLApiService.getItemsDetails(token, ids);
      for (const item of items) {
        const n = ListingAutodetectUseCase.normalizeMLItem(
          { id: acc.id, userId: dataOwnerId },
          item,
        );
        map.set(item.id, {
          title: n.title,
          price: n.price,
          imageUrl: n.imageUrl,
          imageUrls: n.imageUrls ?? [],
        });
      }
      console.log(
        `  enrich ${acc.accountName}: ${items.length}/${ids.length} anúncios reais`,
      );
    } catch (e) {
      console.error(
        `  enrich ${acc.accountName} falhou → fallback slug:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return map;
}

async function main() {
  const { email, userId, limit, apply, enrich } = parseArgs();
  if (!email && !userId) {
    throw new Error("Informe --email=<e-mail> ou --user-id=<id> do dono dos dados.");
  }
  const owner = await prisma.user.findFirst({
    where: email ? { email } : { id: userId },
    select: { id: true, email: true, parentUserId: true },
  });
  if (!owner) throw new Error("Usuário não encontrado.");
  const dataOwnerId = owner.parentUserId ?? owner.id;
  console.log(
    `Modo: ${apply ? "APPLY (grava)" : "DRY-RUN (não grava)"} | enrich=${enrich ? "ON" : "OFF"} | dono ${owner.email}\n`,
  );

  const accounts = (await prisma.marketplaceAccount.findMany({
    where: { userId: dataOwnerId },
    select: {
      id: true,
      accountName: true,
      platform: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
    },
  })) as Account[];

  const rows = (await prisma.productListing.findMany({
    where: { product: { userId: dataOwnerId } },
    select: {
      id: true,
      productId: true,
      externalListingId: true,
      permalink: true,
      status: true,
      marketplaceAccountId: true,
      marketplaceAccount: { select: { accountName: true } },
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          stock: true,
          imageUrl: true,
          originPlatform: true,
        },
      },
    },
  })) as any[];

  const byProduct = new Map<string, L[]>();
  for (const r of rows) {
    const l: L = {
      id: r.id,
      productId: r.productId,
      externalListingId: r.externalListingId,
      permalink: r.permalink,
      status: r.status,
      marketplaceAccountId: r.marketplaceAccountId,
      accountName: r.marketplaceAccount?.accountName ?? null,
      product: r.product,
    };
    const arr = byProduct.get(l.productId) ?? [];
    arr.push(l);
    byProduct.set(l.productId, arr);
  }

  // Candidatos: produtos onde ALGUMA conta tem 2+ anúncios (sinal de box label).
  const candidates: string[] = [];
  for (const [pid, listings] of byProduct) {
    const perAccount = new Map<string, number>();
    for (const l of listings)
      perAccount.set(
        l.marketplaceAccountId,
        (perAccount.get(l.marketplaceAccountId) ?? 0) + 1,
      );
    if ([...perAccount.values()].some((c) => c >= 2)) candidates.push(pid);
  }
  const targets = limit ? candidates.slice(0, limit) : candidates;
  console.log(
    `Produtos candidatos: ${candidates.length}${limit ? ` (limitado a ${targets.length})` : ""}`,
  );

  // Fase 1: coleta todos os splits (keeper por casamento de título).
  type Plan = { product: L["product"]; keeper: L; splits: L[] };
  const plans: Plan[] = [];
  for (const pid of targets) {
    const listings = byProduct.get(pid)!;
    const product = listings[0].product;
    const perAccount = new Map<string, number>();
    for (const l of listings)
      perAccount.set(
        l.marketplaceAccountId,
        (perAccount.get(l.marketplaceAccountId) ?? 0) + 1,
      );

    let keeper = listings[0];
    let best = -1;
    for (const l of listings) {
      const t = titleFromPermalink(l.permalink) ?? "";
      const score =
        titleSimilarity(t, product.name) * 10 + (l.status === "active" ? 1 : 0);
      if (score > best) {
        best = score;
        keeper = l;
      }
    }
    const keeperTitle = titleFromPermalink(keeper.permalink) ?? product.name;

    const splits = listings.filter(
      (l) =>
        l.id !== keeper.id &&
        (perAccount.get(l.marketplaceAccountId) ?? 0) >= 2 &&
        !areTitlesSimilar(titleFromPermalink(l.permalink) ?? "", keeperTitle),
    );
    if (splits.length > 0) plans.push({ product, keeper, splits });
  }

  const allSplits = plans.flatMap((p) => p.splits);
  console.log(
    `A separar: ${allSplits.length} anúncio(s) em ${plans.length} produto(s).\n`,
  );

  // Fase 2: enrich (read-only) dos anúncios a separar, via ML.
  const enrichMap = enrich
    ? await enrichFromMl(allSplits, accounts, dataOwnerId)
    : new Map<string, EnrichData>();
  if (enrich) console.log("");

  // Fase 3: imprime (e aplica).
  let created = 0;
  let errors = 0;
  for (const { product, keeper, splits } of plans) {
    console.log(
      `\n■ ${product.id} "${product.name}" (sku="${product.sku}") — keeper ${keeper.externalListingId} [${keeper.status}]`,
    );
    for (const s of splits) {
      const e = enrichMap.get(s.externalListingId);
      const newName =
        e?.title ??
        titleFromPermalink(s.permalink) ??
        `Anúncio ${s.externalListingId}`;
      const newSku = `VAAPT-${s.externalListingId}`;
      const src = e ? "ML" : "slug";
      console.log(
        `  split → ${s.externalListingId} [${s.status}] ${s.accountName} :: "${newName}" (${src}, sku ${newSku})`,
      );

      if (apply) {
        // Cada split é atômico e isolado: uma falha (ex.: SKU sintético já
        // existente) não interrompe o lote — loga e segue. Re-rodar retoma os
        // restantes (listing já re-apontado deixa de ser candidato).
        try {
          await prisma.$transaction(async (tx) => {
            const createdProduct = await tx.product.create({
              data: {
                userId: dataOwnerId,
                name: newName,
                sku: newSku,
                skuNormalized: normalizeSku(newSku),
                price: (e?.price ?? product.price) as any,
                stock: product.stock,
                imageUrl: e?.imageUrl ?? product.imageUrl,
                imageUrls: e?.imageUrls ?? [],
                createdFromMarketplace: true,
                originPlatform: (product.originPlatform as any) ?? undefined,
              },
              select: { id: true },
            });
            await tx.productListing.update({
              where: { id: s.id },
              data: { productId: createdProduct.id },
            });
          });
          created++;
        } catch (err) {
          errors++;
          console.error(
            `  ✗ falha ao separar ${s.externalListingId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  console.log(
    `\nResumo: ${allSplits.length} split(s) em ${plans.length} produto(s). ` +
      `Enriquecidos do ML: ${enrichMap.size}.`,
  );
  console.log(
    apply
      ? `APPLY: ${created} produto(s) criados e listing(s) re-apontados; ${errors} falha(s).`
      : `DRY-RUN — nada gravado (use --apply).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
