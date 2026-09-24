/**
 * DESLIGA DA PECA DO FILHO O ANUNCIO QUE E DO PAI — sem tocar no anuncio do
 * marketplace.
 *
 * O CASO (Ducelo / Desmanche Tijuco Preto, 24/09/2026): pai e filho vendem
 * pelas MESMAS contas de Mercado Livre. A ingestao grudou anuncios do pai em
 * pecas migradas do filho — por colisao de etiqueta (a "2367" do pai e a
 * "2367" do filho sao pecas diferentes) e por titulo parecido. A peca 11381 do
 * filho, 1 unidade, carregava os 7 anuncios "Botao Farol Gol Bola Parati" do
 * pai: quando o pai vende por qualquer um deles, a baixa cai no estoque do
 * filho; e quando o filho vende a peca dele, a Dexo zera os 7 anuncios do pai.
 *
 * A DECISAO vem de fora (arquivo JSON), tomada por familia de anuncio (o
 * original na conta DESMANCHE DUCELO + as copias que reaproveitam as fotos
 * dele): anuncio original fora da planilha VAAPT do filho e dentro das
 * rajadas de publicacao do pai, ou copia cuja etiqueta + titulo batem com a
 * planilha do pai — e nenhuma evidencia a favor do filho. Este script nao
 * reavalia; ele se RECUSA a desligar o que nao pode sair:
 *   - vinculo que mudou desde a decisao (anuncio em outra peca, id diferente);
 *   - peca que nao e migrada da planilha do filho (EMP583) — peca que ele
 *     cadastrou na Dexo tem anuncio publicado pela propria Dexo;
 *   - anuncio publicado pela Dexo (`createdByUserId`), que e dele;
 *   - anuncio com venda, conta a receber, orcamento ou pergunta de comprador
 *     (a FK e SET NULL: desligar anularia o vinculo desse registro).
 *
 * O que faz, numa transacao por anuncio: grava o anuncio na lista de
 * ignorados (senao a varredura o religa), apaga a identidade de ingestao
 * `listing:<conta>:<anuncio>` que o dava como desta peca, apaga os jobs de
 * estoque desse anuncio (empurrariam o estoque do filho para o anuncio do pai)
 * e apaga o vinculo `ProductListing`. O produto e o estoque do filho nao mudam.
 *
 * ⛔ NUNCA chama marketplace: o anuncio segue no ar e o pai segue vendendo.
 * Backup das linhas (vinculo, identidade, jobs) ANTES de escrever. DRY-RUN
 * por padrao, roda a MESMA transacao e desfaz; escrever exige `--apply` E
 * `DESLIGAR_ANUNCIO_TERCEIRO=1`.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx scripts/catalog-dedupe/desligar-anuncio-de-terceiro.ts \
 *     --tenant=<userId> --lista=<plano.json> --motivo=pai-celao-2026-09-24-vinculo
 *   DESLIGAR_ANUNCIO_TERCEIRO=1 npx tsx ... --apply
 *
 * Formato da lista: [{ "listingId", "productId", "externalListingId" }, ...]
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import type { Prisma } from "@prisma/client";

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
const DRY = !args.includes("--apply") || process.env.DESLIGAR_ANUNCIO_TERCEIRO !== "1";

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

type Alvo = { listingId: string; productId: string; externalListingId: string };
type Desfecho = { desfecho: string };

class RollbackDoEnsaio extends Error {
  constructor(readonly res: Desfecho) {
    super("rollback do dry-run");
  }
}

/**
 * Recebe a transacao de fora — NUNCA abre uma propria: o Prisma nao aninha
 * transacao interativa, e um `$transaction` aqui dentro comitaria mesmo no
 * dry-run.
 */
async function desligarUm(tx: Prisma.TransactionClient, alvo: Alvo): Promise<Desfecho> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `desligar-anuncio:${alvo.listingId}`);

  const l = await tx.productListing.findUnique({
    where: { id: alvo.listingId },
    select: {
      id: true, productId: true, externalListingId: true, createdByUserId: true, marketplaceAccountId: true,
      marketplaceAccount: { select: { platform: true } },
      product: { select: { userId: true, sku: true, name: true, attributes: true } },
    },
  });
  if (!l) return { desfecho: "JA_DESLIGADO" };
  if (l.productId !== alvo.productId || l.externalListingId !== alvo.externalListingId) {
    return { desfecho: "PULADO: o vinculo mudou depois da decisao" };
  }
  if (l.product.userId !== TENANT) return { desfecho: `PULADO: outro tenant (${l.product.userId})` };
  const migracao = (l.product.attributes as Record<string, unknown> | null)?.migration;
  if (migracao !== "EMP583") return { desfecho: "PULADO: peca nao migrada da planilha dele" };
  if (l.createdByUserId) return { desfecho: "PULADO: anuncio publicado pela Dexo" };

  const [vendas, receber, orcamentos, perguntas] = await Promise.all([
    tx.orderItem.count({ where: { listingId: l.id } }),
    tx.receivableItem.count({ where: { listingId: l.id } }),
    tx.budgetItem.count({ where: { listingId: l.id } }),
    tx.marketplaceQuestion.count({ where: { productListingId: l.id } }),
  ]);
  if (vendas || receber || orcamentos || perguntas) {
    return {
      desfecho: `PULADO: anuncio com historico (vendas ${vendas}, receber ${receber}, orcamento ${orcamentos}, perguntas ${perguntas})`,
    };
  }

  const platform = l.marketplaceAccount.platform;
  await tx.listingIngestionIgnore.upsert({
    where: {
      userId_platform_externalListingId: { userId: TENANT, platform, externalListingId: l.externalListingId },
    },
    create: { userId: TENANT, platform, externalListingId: l.externalListingId, reason: MOTIVO },
    update: {},
  });
  await tx.productIngestionIdentity.deleteMany({
    where: {
      userId: TENANT,
      platform,
      identityKey: `listing:${l.marketplaceAccountId}:${l.externalListingId}`,
    },
  });
  await tx.stockSyncJob.deleteMany({ where: { listingId: l.id } });
  await tx.productListing.delete({ where: { id: l.id } });
  await tx.systemLog.create({
    data: {
      action: "LISTING_OWNERSHIP_REPAIRED",
      level: "INFO",
      userId: TENANT,
      resource: "ProductListing",
      resourceId: l.id,
      message: `Anúncio ${l.externalListingId} desligado da peça ${l.product.sku} (${l.product.name}): é do catálogo do pai (planilha CELÃO), não desta peça. O anúncio segue ativo no marketplace; vendas por ele não baixam mais o seu estoque.`,
      details: {
        origem: "desligar-anuncio-de-terceiro",
        motivo: MOTIVO,
        externalListingId: l.externalListingId,
        productId: l.productId,
        sku: l.product.sku,
      },
    },
  });
  return { desfecho: "DESLIGADO" };
}

async function main(): Promise<void> {
  assertBanco();
  const bruto = JSON.parse(fs.readFileSync(LISTA, "utf8")) as Alvo[];
  const vistos = new Set<string>();
  const alvos = bruto.filter((a) => a.listingId && !vistos.has(a.listingId) && vistos.add(a.listingId));
  console.log(`${DRY ? "DRY-RUN" : "APLICANDO"} — ${alvos.length} anuncio(s), tenant ${TENANT}, motivo ${MOTIVO}`);

  // Backup ANTES de qualquer escrita: as linhas inteiras, para poder religar.
  const ids = alvos.map((a) => a.listingId);
  const [vinculos, jobs] = await Promise.all([
    prisma.productListing.findMany({ where: { id: { in: ids } } }),
    prisma.stockSyncJob.findMany({ where: { listingId: { in: ids } } }),
  ]);
  const chaves = vinculos.map((v) => `listing:${v.marketplaceAccountId}:${v.externalListingId}`);
  const identidades = await prisma.productIngestionIdentity.findMany({
    where: { userId: TENANT, identityKey: { in: chaves } },
  });
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const arquivo = path.join(SAIDA, `backup-desligar-anuncio-${DRY ? "dry" : "apply"}-${carimbo}.json`);
  fs.writeFileSync(arquivo, JSON.stringify({ vinculos, identidades, jobs }));
  console.log(`  backup: ${arquivo} (vinculos ${vinculos.length}, identidades ${identidades.length}, jobs ${jobs.length})`);

  const contagem: Record<string, number> = {};
  const pulados: Array<{ listingId: string; desfecho: string }> = [];
  const desligados: string[] = [];
  for (const [i, alvo] of alvos.entries()) {
    let r: Desfecho;
    try {
      r = await prisma.$transaction(
        async (tx) => {
          const res = await desligarUm(tx, alvo);
          // Dry-run: a MESMA transacao roda inteira e e desfeita.
          if (DRY) throw new RollbackDoEnsaio(res);
          return res;
        },
        { timeout: 30_000 },
      );
    } catch (erro) {
      r =
        erro instanceof RollbackDoEnsaio
          ? erro.res
          : { desfecho: `ERRO: ${erro instanceof Error ? erro.message : String(erro)}` };
    }
    const chave = r.desfecho.split(":")[0];
    contagem[chave] = (contagem[chave] ?? 0) + 1;
    if (chave === "DESLIGADO") desligados.push(alvo.externalListingId);
    else pulados.push({ listingId: alvo.listingId, desfecho: r.desfecho });
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${alvos.length} ${JSON.stringify(contagem)}`);
  }

  if (!DRY && desligados.length) {
    // Todo anuncio desligado tem de estar na lista, senao a varredura religa.
    const naLista = await prisma.listingIngestionIgnore.count({
      where: { userId: TENANT, externalListingId: { in: desligados } },
    });
    if (naLista < desligados.length) {
      throw new Error(`ATENCAO: ${desligados.length - naLista} anuncio(s) desligado(s) FORA da lista de ignorados.`);
    }
  }

  const relatorio = path.join(SAIDA, `resultado-desligar-anuncio-${DRY ? "dry" : "apply"}-${carimbo}.json`);
  fs.writeFileSync(relatorio, JSON.stringify({ contagem, pulados, desligados }, null, 1));
  console.log(JSON.stringify(contagem, null, 1));
  for (const p of pulados.slice(0, 15)) console.log(`   ${p.listingId}: ${p.desfecho}`);
  console.log(`  relatorio: ${relatorio}`);
  if (DRY) console.log("\nnada foi escrito. Para aplicar: DESLIGAR_ANUNCIO_TERCEIRO=1 ... --apply");
}

main()
  .catch((erro) => {
    console.error("FALHA:", erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
