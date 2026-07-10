import "dotenv/config";
import prisma from "../app/lib/prisma";
import { normalizeSku } from "../app/lib/sku";
import {
  areTitlesSimilar,
  titleSimilarity,
} from "../app/lib/title-similarity";

/**
 * Limpeza de produtos MAL-AGRUPADOS por "SKU de caixa".
 *
 * Quando o vendedor reusa um rótulo de caixa/palete como SKU do anúncio
 * (`Caixa mangueiras`, `Caixote 2`, `Palete chicote`) em vários anúncios
 * diferentes, o import antigo colapsava todos num único Product. Isto detecta
 * produtos onde UMA conta tem 2+ anúncios (sinal de reuso) e SEPARA os anúncios
 * excedentes em produtos próprios (split in-place):
 *   - mantém no produto original o anúncio cujo título (do slug do permalink)
 *     mais casa com o nome atual do produto;
 *   - cada outro anúncio vira um Product novo (nome derivado do slug do
 *     permalink, SKU sintético VAAPT-<externalListingId>, createdFromMarketplace)
 *     e o listing é re-apontado para ele.
 *
 * NÃO agrupamento legítimo multi-conta (1 anúncio por conta) NÃO é tocado.
 * Preço/estoque/imagem do produto novo herdam do original (placeholder); um
 * re-import posterior reconcilia. Título vem do slug (aproximado).
 *
 * Uso:
 *   tsx scripts/split-boxlabel-products.ts --email=x@y.com            # dry-run
 *   tsx scripts/split-boxlabel-products.ts --user-id=... --limit=10   # dry-run
 *   tsx scripts/split-boxlabel-products.ts --email=x@y.com --apply    # grava
 *
 * Sem `--apply` é DRY-RUN (não grava nada).
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

async function main() {
  const { email, userId, limit, apply } = parseArgs();
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
    `Modo: ${apply ? "APPLY (grava)" : "DRY-RUN (não grava)"} | dono ${owner.email} (${dataOwnerId})\n`,
  );

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

  console.log(`Produtos candidatos (conta com 2+ anúncios): ${candidates.length}`);
  const targets = limit ? candidates.slice(0, limit) : candidates;
  if (limit && candidates.length > limit) {
    console.log(`(limitando a ${limit} pelo --limit)\n`);
  }

  let splitsPlanned = 0;
  let productsCreated = 0;

  for (const pid of targets) {
    const listings = byProduct.get(pid)!;
    const product = listings[0].product;
    const perAccount = new Map<string, number>();
    for (const l of listings)
      perAccount.set(
        l.marketplaceAccountId,
        (perAccount.get(l.marketplaceAccountId) ?? 0) + 1,
      );

    // Keeper = anúncio cujo título (slug) mais casa com o nome atual do produto.
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

    // Splits = não-keeper, em contas com 2+ anúncios (preserva 1-por-conta
    // legítimo) E com título CLARAMENTE diferente do keeper. Títulos parecidos
    // (mesmo produto reanunciado várias vezes) NÃO são separados.
    const splits = listings.filter(
      (l) =>
        l.id !== keeper.id &&
        (perAccount.get(l.marketplaceAccountId) ?? 0) >= 2 &&
        !areTitlesSimilar(
          titleFromPermalink(l.permalink) ?? "",
          keeperTitle,
        ),
    );
    if (splits.length === 0) continue;

    console.log(
      `\n■ Produto ${product.id} "${product.name}" (sku="${product.sku}") — ${listings.length} anúncios`,
    );
    console.log(
      `  keeper: ${keeper.externalListingId} [${keeper.status}] ${keeper.accountName}`,
    );
    for (const s of splits) {
      const newName = titleFromPermalink(s.permalink) ?? `Anúncio ${s.externalListingId}`;
      const newSku = `VAAPT-${s.externalListingId}`;
      console.log(
        `  split → ${s.externalListingId} [${s.status}] ${s.accountName} :: "${newName}" (sku ${newSku})`,
      );
    }
    splitsPlanned += splits.length;

    if (apply) {
      for (const s of splits) {
        const newName =
          titleFromPermalink(s.permalink) ?? `Anúncio ${s.externalListingId}`;
        const newSku = `VAAPT-${s.externalListingId}`;
        await prisma.$transaction(async (tx) => {
          const created = await tx.product.create({
            data: {
              userId: dataOwnerId,
              name: newName,
              sku: newSku,
              skuNormalized: normalizeSku(newSku),
              price: product.price as any,
              stock: product.stock,
              imageUrl: product.imageUrl,
              createdFromMarketplace: true,
              originPlatform: (product.originPlatform as any) ?? undefined,
            },
            select: { id: true },
          });
          await tx.productListing.update({
            where: { id: s.id },
            data: { productId: created.id },
          });
        });
        productsCreated++;
      }
    }
  }

  console.log(
    `\nResumo: ${splitsPlanned} anúncio(s) a separar em ${targets.length} produto(s) candidato(s).`,
  );
  console.log(
    apply
      ? `APPLY: ${productsCreated} produto(s) criados e listing(s) re-apontados.`
      : `DRY-RUN — nada gravado (use --apply). Rode um re-import depois p/ reconciliar preço/estoque/imagem.`,
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
