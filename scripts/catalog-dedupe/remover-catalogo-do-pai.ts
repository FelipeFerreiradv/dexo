/**
 * REMOVE DA CONTA DO FILHO AS FICHAS QUE SAO DO CATALOGO DO PAI — sem tocar
 * no anuncio do marketplace.
 *
 * O CASO (Ducelo / Desmanche Tijuco Preto, 24/09/2026): pai e filho vendem
 * pelas MESMAS contas de Mercado Livre e Shopee. A ingestao criou na conta do
 * filho fichas a partir dos anuncios do pai. A limpeza de 15/09
 * (`scripts/limpar-catalogo-de-terceiro.ts`) tirou 4.529; sobraram as que
 * foram restauradas em 15/09 06:35 (a lista daquele dia foi tirada antes) e as
 * que a planilha do pai, de 10/12/2025, nao cobre por nome.
 *
 * A DECISAO vem de fora (arquivo de ids), tomada pelo cruzamento com as duas
 * planilhas: o anuncio da conta DESMANCHE DUCELO fora da coluna MLB da
 * planilha VAAPT do filho e a prova principal (97,3% das pecas migradas dele
 * tem o anuncio na coluna; 1 em 10.380 anuncios do pai tem). Este script nao
 * reavalia a decisao — ele se RECUSA a apagar o que nao pode sair:
 *   - ficha de outro tenant, ficha migrada da planilha dele (EMP583), ficha
 *     que nao nasceu de anuncio;
 *   - ficha com venda, NF-e, conta a receber ou orcamento;
 *   - ficha cujo anuncio carrega venda, conta a receber, orcamento ou
 *     pergunta de comprador (apagar o anuncio anularia esse vinculo — FK
 *     SET NULL — e isso e alterar registro historico).
 *
 * ⛔ NUNCA chama marketplace. O pai continua vendendo por esses anuncios; o
 *    `bulkDelete` da aplicacao os ENCERRARIA (product.usercase.ts).
 * ⛔ Sem a lista de ignorados a varredura recria tudo (MK2: 998 limpos, 1.934
 *    de volta em um dia). Cada anuncio vai para `ListingIngestionIgnore` na
 *    MESMA transacao que apaga a ficha; ficha orfa (sem anuncio) tem o MLB do
 *    proprio SKU (`VAAPT-MLB…`/`ML-MLB…`) gravado no lugar.
 *
 * Backup das linhas inteiras (Product, ProductListing, StockLog,
 * ProductCompatibility, ProductIngestionIdentity) ANTES de qualquer escrita.
 * DRY-RUN por padrao; escrever exige `--apply` E `REMOVER_CATALOGO_PAI=1`. O
 * dry-run roda a MESMA transacao do apply e a desfaz no fim.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx scripts/catalog-dedupe/remover-catalogo-do-pai.ts \
 *     --tenant=<userId> --lista=<ids.txt> --motivo=pai-celao-2026-09-24
 *   REMOVER_CATALOGO_PAI=1 npx tsx ... --apply
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import type { Platform, Prisma } from "@prisma/client";

import prisma from "../../app/lib/prisma";

const args = process.argv.slice(2);
const CONHECIDAS = new Set(["tenant", "lista", "motivo", "saida", "apply", "allow-any-host"]);
for (const a of args) {
  const nome = a.replace(/^--/, "").split("=")[0];
  if (!CONHECIDAS.has(nome)) {
    console.error(`Flag desconhecida: --${nome} — abortando.`);
    process.exit(2);
  }
}
const valor = (nome: string, padrao = "") => {
  const achado = args.find((a) => a.startsWith(`--${nome}=`));
  return achado ? achado.slice(nome.length + 3) : padrao;
};
const TENANT = valor("tenant");
const LISTA = valor("lista");
const MOTIVO = valor("motivo");
const SAIDA = valor("saida", LISTA ? path.dirname(LISTA) : ".");
const DRY = !args.includes("--apply") || process.env.REMOVER_CATALOGO_PAI !== "1";
const SKU_SINTETICO = /^(VAAPT-|ML-|SHP-|MGL-)/;

if (!TENANT || !LISTA || !MOTIVO) {
  console.error("Obrigatorias: --tenant= --lista= --motivo=");
  process.exit(2);
}

function assertBanco(): void {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
  const host = /@([^/:]+)/.exec(url)?.[1] ?? "";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`Banco inesperado (${host}).`);
  }
}

/** MLB embutido no SKU cunhado pela ingestao: "VAAPT-MLB123", "ML-MLB123". */
function mlbDoSku(sku: string | null): string | null {
  return /(?:^|-)(MLB\d{6,})$/i.exec(sku ?? "")?.[1]?.toUpperCase() ?? null;
}

type Ignorar = { platform: Platform; externalListingId: string };
type Desfecho = { desfecho: string; ignorados: Ignorar[] };

class RollbackDoEnsaio extends Error {
  constructor(readonly res: Desfecho) {
    super("rollback do dry-run");
  }
}

/**
 * Recebe a transacao de fora — NUNCA abre uma propria. O dry-run chama esta
 * mesma funcao dentro de uma transacao que ele desfaz; se ela abrisse
 * `prisma.$transaction` aqui dentro, seria uma transacao INDEPENDENTE (o
 * Prisma nao aninha) e o "ensaio" apagaria de verdade.
 */
async function removerUma(tx: Prisma.TransactionClient, id: string): Promise<Desfecho> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `catalogo-pai:${id}`);

  const p = await tx.product.findUnique({
    where: { id },
    select: {
      id: true, sku: true, name: true, userId: true, attributes: true,
      createdFromMarketplace: true, originPlatform: true,
      listings: {
        select: {
          id: true, externalListingId: true,
          marketplaceAccount: { select: { platform: true } },
        },
      },
    },
  });
  if (!p) return { desfecho: "JA_REMOVIDA", ignorados: [] };
  if (p.userId !== TENANT) return { desfecho: `PULADO: outro tenant (${p.userId})`, ignorados: [] };
  const migracao = (p.attributes as Record<string, unknown> | null)?.migration;
  if (migracao === "EMP583") return { desfecho: "PULADO: peca migrada da planilha dele", ignorados: [] };
  const nasceuDeAnuncio =
    p.createdFromMarketplace || SKU_SINTETICO.test(p.sku ?? "") || p.originPlatform != null;
  if (!nasceuDeAnuncio) return { desfecho: "PULADO: nao nasceu de anuncio", ignorados: [] };

  const listingIds = p.listings.map((l) => l.id);
  const [vendas, nfes, receber, orcamentos, vendasAnuncio, receberAnuncio, orcamentoAnuncio, perguntas] =
    await Promise.all([
      tx.orderItem.count({ where: { productId: id } }),
      tx.nfeItem.count({ where: { productId: id } }),
      tx.receivableItem.count({ where: { productId: id } }),
      tx.budgetItem.count({ where: { productId: id } }),
      tx.orderItem.count({ where: { listingId: { in: listingIds } } }),
      tx.receivableItem.count({ where: { listingId: { in: listingIds } } }),
      tx.budgetItem.count({ where: { listingId: { in: listingIds } } }),
      tx.marketplaceQuestion.count({ where: { productListingId: { in: listingIds } } }),
    ]);
  if (vendas || nfes || receber || orcamentos) {
    return {
      desfecho: `PULADO: tem historico (vendas ${vendas}, nfe ${nfes}, receber ${receber}, orcamento ${orcamentos})`,
      ignorados: [],
    };
  }
  if (vendasAnuncio || receberAnuncio || orcamentoAnuncio || perguntas) {
    return {
      desfecho: `PULADO: anuncio com historico (vendas ${vendasAnuncio}, receber ${receberAnuncio}, orcamento ${orcamentoAnuncio}, perguntas ${perguntas})`,
      ignorados: [],
    };
  }

  const ignorados: Ignorar[] = p.listings
    .filter((l) => l.marketplaceAccount?.platform)
    .map((l) => ({ platform: l.marketplaceAccount!.platform, externalListingId: l.externalListingId }));
  const doSku = mlbDoSku(p.sku);
  if (doSku && !ignorados.some((i) => i.externalListingId.toUpperCase() === doSku)) {
    ignorados.push({ platform: "MERCADO_LIVRE", externalListingId: doSku });
  }

  for (const i of ignorados) {
    await tx.listingIngestionIgnore.upsert({
      where: {
        userId_platform_externalListingId: {
          userId: TENANT,
          platform: i.platform,
          externalListingId: i.externalListingId,
        },
      },
      create: { userId: TENANT, platform: i.platform, externalListingId: i.externalListingId, reason: MOTIVO },
      update: {},
    });
  }
  await tx.stockLog.deleteMany({ where: { productId: id } });
  await tx.productListing.deleteMany({ where: { productId: id } });
  await tx.product.delete({ where: { id } });
  await tx.systemLog.create({
    data: {
      action: "DELETE_PRODUCT",
      level: "INFO",
      userId: TENANT,
      resource: "Product",
      resourceId: id,
      message: `Produto excluído: ${p.name}. Peça do catálogo do pai (planilha CELÃO), não do seu estoque; os anúncios seguem ativos no marketplace.`,
      details: {
        origem: "remover-catalogo-do-pai",
        motivo: MOTIVO,
        sku: p.sku,
        externalListingIds: ignorados.map((i) => i.externalListingId),
      },
    },
  });
  return { desfecho: "REMOVIDA", ignorados };
}

async function main(): Promise<void> {
  assertBanco();
  const ids = [...new Set(fs.readFileSync(LISTA, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  console.log(`${DRY ? "DRY-RUN" : "APLICANDO"} — ${ids.length} ficha(s) na lista, tenant ${TENANT}, motivo ${MOTIVO}`);

  // Backup ANTES de qualquer escrita: as linhas inteiras, para poder recriar.
  const [produtos, anuncios, movimentos, compat, identidades] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } } }),
    prisma.productListing.findMany({ where: { productId: { in: ids } } }),
    prisma.stockLog.findMany({ where: { productId: { in: ids } } }),
    prisma.productCompatibility.findMany({ where: { productId: { in: ids } } }),
    prisma.productIngestionIdentity.findMany({ where: { productId: { in: ids } } }),
  ]);
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const arquivo = path.join(SAIDA, `backup-catalogo-pai-${DRY ? "dry" : "apply"}-${carimbo}.json`);
  fs.writeFileSync(arquivo, JSON.stringify({ produtos, anuncios, movimentos, compat, identidades }));
  console.log(
    `  backup: ${arquivo} (produtos ${produtos.length}, anuncios ${anuncios.length}, movimentos ${movimentos.length}, compat ${compat.length}, identidades ${identidades.length})`,
  );
  if (produtos.length !== ids.length) console.log(`  ⚠ ${ids.length - produtos.length} id(s) da lista ja nao existem`);

  const contagem: Record<string, number> = {};
  const pulados: Array<{ id: string; desfecho: string }> = [];
  const removidos: Array<{ id: string; ignorados: Ignorar[] }> = [];
  const LOTE = 100;

  for (let i = 0; i < ids.length; i += LOTE) {
    const fatia = ids.slice(i, i + LOTE);
    for (const id of fatia) {
      let r: Desfecho;
      try {
        r = await prisma.$transaction(
          async (tx) => {
            const res = await removerUma(tx, id);
            // Dry-run: a MESMA transacao roda inteira e e desfeita — as guardas
            // sao provadas contra o banco de verdade, sem deixar rastro.
            if (DRY) throw new RollbackDoEnsaio(res);
            return res;
          },
          { timeout: 30_000 },
        );
      } catch (erro) {
        r =
          erro instanceof RollbackDoEnsaio
            ? erro.res
            : { desfecho: `ERRO: ${erro instanceof Error ? erro.message : String(erro)}`, ignorados: [] };
      }
      const chave = r.desfecho.split(":")[0];
      contagem[chave] = (contagem[chave] ?? 0) + 1;
      if (chave === "REMOVIDA") removidos.push({ id, ignorados: r.ignorados });
      else pulados.push({ id, desfecho: r.desfecho });
    }

    if (!DRY) {
      // Confere, entre lotes, que todo anuncio de ficha removida esta na lista:
      // meio-termo (ficha fora, lista vazia) e o estado que recria tudo.
      const esperados = removidos
        .filter((x) => fatia.includes(x.id))
        .flatMap((x) => x.ignorados.map((g) => g.externalListingId));
      if (esperados.length) {
        const naLista = await prisma.listingIngestionIgnore.count({
          where: { userId: TENANT, externalListingId: { in: esperados } },
        });
        if (naLista < esperados.length) {
          throw new Error(`ABORTADO: ${esperados.length - naLista} anuncio(s) de ficha removida FORA da lista de ignorados.`);
        }
      }
    }
    console.log(`  lote ${i / LOTE + 1}: ${Math.min(i + LOTE, ids.length)}/${ids.length} ${JSON.stringify(contagem)}`);
  }

  const relatorio = path.join(SAIDA, `resultado-catalogo-pai-${DRY ? "dry" : "apply"}-${carimbo}.json`);
  fs.writeFileSync(relatorio, JSON.stringify({ contagem, pulados, removidos }, null, 1));
  console.log(JSON.stringify(contagem, null, 1));
  for (const p of pulados.slice(0, 15)) console.log(`   ${p.id}: ${p.desfecho}`);
  console.log(`  relatorio: ${relatorio}`);
  if (DRY) console.log("\nnada foi escrito. Para aplicar: REMOVER_CATALOGO_PAI=1 ... --apply");
}

main()
  .catch((erro) => {
    console.error("FALHA:", erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
