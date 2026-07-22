import "dotenv/config";
import prisma from "../app/lib/prisma";
import { areTitlesSimilar } from "../app/lib/title-similarity";

/**
 * Resolve produtos que compartilham o MESMO (userId, skuNormalized).
 *
 * Motivo: a identidade real de um produto é o SKU NORMALIZADO, mas a unique do
 * banco é sobre o SKU CRU — então "mk2-204" e "Mk2-204" convivem como dois
 * produtos sem violar constraint nenhuma. Este script limpa o passivo para que
 * o índice único parcial (ver docs/dedupe-sku-sql.md) possa ser criado; a partir
 * dele o banco passa a garantir o invariante.
 *
 * Duas classes, tratadas de formas DIFERENTES (a distinção importa):
 *
 *  - MESMO PRODUTO (títulos parecidos): duplicata de verdade — os anúncios do
 *    perdedor migram para o sobrevivente (o mais antigo) e o perdedor é
 *    removido. Se o perdedor tiver histórico (pedido/financeiro com
 *    onDelete: Restrict), a remoção falha de propósito: nesse caso ele apenas
 *    recebe SKU sintético, preservando 100% do histórico.
 *
 *  - SKU DE CAIXA (títulos claramente diferentes): NÃO são duplicatas — são
 *    peças distintas que reusam a mesma etiqueta de caixa/prateleira. Nunca
 *    são fundidas: recebem SKU sintético (VAAPT-DEDUP-<id>) para liberar o
 *    índice, e ambos os produtos continuam existindo.
 *
 * SEGURANÇA: sem `--apply` nada é escrito (dry-run é o padrão).
 *
 *   npx tsx scripts/dedupe-products-by-normalized-sku.ts
 *   npx tsx scripts/dedupe-products-by-normalized-sku.ts --user-id=<ID>
 *   npx tsx scripts/dedupe-products-by-normalized-sku.ts --apply
 */

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const f = process.argv.slice(2).find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
}

type Row = {
  id: string;
  userId: string;
  sku: string;
  skuNormalized: string;
  name: string;
  createdAt: Date;
};

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const userId = arg("user-id");

  const grupos = await prisma.$queryRawUnsafe<
    Array<{ userId: string; skuNormalized: string }>
  >(
    `SELECT "userId","skuNormalized" FROM "Product"
      WHERE "skuNormalized" IS NOT NULL AND "skuNormalized" <> ''
        ${userId ? `AND "userId" = $1` : ""}
      GROUP BY 1,2 HAVING COUNT(*) > 1
      ORDER BY 1,2`,
    ...(userId ? [userId] : []),
  );

  console.log(
    `${apply ? "APLICANDO" : "DRY-RUN"} — ${grupos.length} grupo(s) com SKU normalizado repetido\n`,
  );

  let fundidos = 0;
  let renomeados = 0;
  let preservados = 0;

  for (const g of grupos) {
    const produtos = (await prisma.product.findMany({
      where: { userId: g.userId, skuNormalized: g.skuNormalized },
      select: {
        id: true,
        userId: true,
        sku: true,
        skuNormalized: true,
        name: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    })) as Row[];

    const [sobrevivente, ...perdedores] = produtos;
    console.log(`SKU "${g.skuNormalized}" (user ${g.userId})`);
    console.log(
      `  MANTÉM  ${sobrevivente.id} [${sobrevivente.sku}] ${sobrevivente.name.slice(0, 50)}`,
    );

    const plataformasDo = async (productId: string) =>
      new Set(
        (
          await prisma.productListing.findMany({
            where: { productId },
            select: { marketplaceAccount: { select: { platform: true } } },
          })
        ).map((l) => l.marketplaceAccount.platform),
      );
    const platsSobrevivente = await plataformasDo(sobrevivente.id);

    for (const p of perdedores) {
      // DOIS critérios, ambos obrigatórios, para fundir:
      //  (1) títulos parecidos E
      //  (2) plataformas DISJUNTAS — o cenário real da duplicação é "mesmo
      //      item anunciado em marketplaces diferentes". Dois produtos na
      //      MESMA plataforma com o mesmo SKU são reuso de etiqueta pelo
      //      vendedor, nunca duplicata — e fundi-los perderia uma peça.
      //      Sem o critério (2), "Borracha Porta Dianteira" e "Borracha Porta
      //      Mala" (ambas no ML, SKU "saco borracha rav4 2") seriam fundidas
      //      por terem títulos parecidos. São peças distintas.
      const platsPerdedor = await plataformasDo(p.id);
      const plataformasDisjuntas =
        platsPerdedor.size > 0 &&
        platsSobrevivente.size > 0 &&
        ![...platsPerdedor].some((pl) => platsSobrevivente.has(pl));
      const mesmoProduto =
        areTitlesSimilar(sobrevivente.name, p.name) && plataformasDisjuntas;
      const syntheticSku = `VAAPT-DEDUP-${p.id}`;

      if (!mesmoProduto) {
        // Peças distintas (etiqueta de caixa reusada, ou mesma plataforma):
        // preserva as duas, só desambigua o SKU.
        console.log(
          `  MANTÉM² ${p.id} [${p.sku}] ${p.name.slice(0, 50)} → SKU ${syntheticSku}`,
        );
        if (apply) {
          await prisma.product.update({
            where: { id: p.id },
            data: { sku: syntheticSku, skuNormalized: syntheticSku.toLowerCase() },
          });
        }
        renomeados++;
        continue;
      }

      // Duplicata real: anúncios vão para o sobrevivente e o perdedor sai.
      const listings = await prisma.productListing.count({
        where: { productId: p.id },
      });
      console.log(
        `  FUNDE   ${p.id} [${p.sku}] ${p.name.slice(0, 50)} (${listings} anúncio(s) → sobrevivente)`,
      );

      if (!apply) {
        fundidos++;
        continue;
      }

      await prisma.productListing.updateMany({
        where: { productId: p.id },
        data: { productId: sobrevivente.id },
      });

      try {
        await prisma.product.delete({ where: { id: p.id } });
        fundidos++;
      } catch (e) {
        // onDelete: Restrict (pedido/financeiro apontando p/ este produto).
        // Preservar o histórico é mais importante que remover a linha: o SKU
        // sintético já libera o índice único.
        await prisma.product.update({
          where: { id: p.id },
          data: { sku: syntheticSku, skuNormalized: syntheticSku.toLowerCase() },
        });
        preservados++;
        console.log(
          `          ↳ tem histórico; NÃO removido — SKU virou ${syntheticSku} (${e instanceof Error ? e.message.split("\n")[0] : e})`,
        );
      }
    }
    console.log("");
  }

  console.log(
    `Resumo: ${fundidos} fundido(s), ${renomeados} SKU de caixa renomeado(s), ${preservados} preservado(s) por histórico.`,
  );
  if (!apply) {
    console.log("\nNada foi gravado. Rode de novo com --apply para executar.");
  }
}

main()
  .catch((e) => {
    console.error("ERRO:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
