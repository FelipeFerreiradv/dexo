/**
 * APLICA O RELIGAMENTO — a UNICA escrita desta frente.
 *
 * Consome `religamento-plano.json` (saida de `propor-religamento.ts`) e reaponta
 * para a peca certa SOMENTE os casos com veredito RELIGAR. Tudo o mais e
 * ignorado: o plano ja separou.
 *
 * DRY-RUN POR PADRAO. Escrever exige as DUAS chaves: `--apply` na linha de
 * comando e `RELIGAR_VINCULO_APPLY=1` no ambiente. Uma so nao basta de proposito
 * — este script apaga o vinculo anterior de um anuncio de cliente.
 *
 * O QUE CADA CASO FAZ, numa transacao so:
 *   1. trava o anuncio por advisory lock;
 *   2. REVALIDA ao vivo tudo o que o plano afirmou (o plano e uma foto de
 *      minutos atras);
 *   3. troca `ProductListing.productId` com COMPARE-AND-SWAP: se o vinculo nao
 *      for mais o que foi medido, alguem mexeu nele e o caso e PULADO;
 *   4. corrige `ProductIngestionIdentity` da chave `listing:<conta>:<anuncio>`,
 *      senao a proxima ingestao envenena a linha para AMBIGUOUS/NULL e o alias
 *      daquele anuncio morre para sempre;
 *   5. registra em `SystemLog` COM o `userId` do dono, que e o que faz o
 *      registro aparecer para o lojista.
 *
 * O QUE ELE NAO FAZ, de proposito:
 *   - nao empurra quantidade para o marketplace (seria escrita em anuncio real);
 *   - nao mexe em venda passada: `OrderItem` congela o produto no momento da
 *     venda, e reescrever historico e outra decisao, com outra ferramenta;
 *   - nao limpa override: o plano ja recusa anuncio que tenha algum.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx scripts/catalog-dedupe/aplicar-religamento.ts --plano=<dir>            # dry-run
 *   RELIGAR_VINCULO_APPLY=1 npx tsx ... --plano=<dir> --apply --limite=20
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

import prisma from "../../app/lib/prisma";

const args = process.argv.slice(2);
const valor = (nome: string, padrao: string) => {
  const achado = args.find((a) => a.startsWith(`--${nome}=`));
  return achado ? achado.slice(nome.length + 3) : padrao;
};
const DRY = !args.includes("--apply") || process.env.RELIGAR_VINCULO_APPLY !== "1";
const PLANO = valor("plano", "/root/auditoria-fusao-18-09");
const LIMITE = Number(valor("limite", "0"));

/** O mesmo molde de `corrigir-vinculo-anuncio-produto.ts`: producao e sa-east-1. */
function assertBanco(): void {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
  const host = /@([^/:]+)/.exec(url)?.[1] ?? "";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`Banco inesperado (${host}). Use --allow-any-host se for de proposito.`);
  }
}

type Caso = {
  veredito: string;
  externo: string;
  conta: string;
  link: string;
  tituloNoMl: string;
  de: string;
  para: string | null;
};

type Resolvido = {
  externo: string;
  listingId: string;
  contaId: string;
  ownerId: string;
  deId: string;
  paraId: string;
  paraNome: string;
  motivoDoPulo?: string;
};

async function resolverCaso(caso: Caso): Promise<Resolvido | { externo: string; motivoDoPulo: string }> {
  const listing = await prisma.productListing.findFirst({
    where: { externalListingId: caso.externo, status: "active" },
    select: {
      id: true,
      productId: true,
      marketplaceAccountId: true,
      marketplaceAccount: { select: { userId: true, user: { select: { parentUserId: true, id: true } } } },
    },
  });
  if (!listing) return { externo: caso.externo, motivoDoPulo: "anuncio nao esta mais ativo na Dexo" };

  // O plano guarda "SKU NOME" em texto; o id vem do nome exato, dentro do tenant.
  const dono = listing.marketplaceAccount.user.parentUserId ?? listing.marketplaceAccount.user.id;
  const nomeDoDestino = (caso.para ?? "").replace(/^\S*\s/, "");
  const destino = await prisma.product.findFirst({
    where: { name: nomeDoDestino, user: { OR: [{ id: dono }, { parentUserId: dono }] } },
    select: { id: true, name: true },
  });
  if (!destino) return { externo: caso.externo, motivoDoPulo: `peca de destino nao encontrada: ${nomeDoDestino}` };

  return {
    externo: caso.externo,
    listingId: listing.id,
    contaId: listing.marketplaceAccountId,
    ownerId: dono,
    deId: listing.productId,
    paraId: destino.id,
    paraNome: destino.name,
  };
}

/**
 * Revalida ao vivo e escreve, tudo sob o mesmo lock. Qualquer divergencia
 * derruba a transacao inteira: o plano e uma foto, o banco e a verdade.
 */
async function aplicarUm(r: Resolvido): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `religamento:${r.listingId}`);

    const destino = await tx.product.findUnique({
      where: { id: r.paraId },
      select: { stock: true, reservedStock: true, userId: true, user: { select: { id: true, parentUserId: true } } },
    });
    if (!destino) return "PULADO: peca de destino sumiu";
    const donoDoDestino = destino.user?.parentUserId ?? destino.user?.id ?? destino.userId;
    if (donoDoDestino !== r.ownerId) return "PULADO: peca de destino e de outro cliente";
    if (destino.stock - destino.reservedStock <= 0) return "PULADO: peca de destino sem saldo";

    const jaTem = await tx.productListing.count({
      where: { productId: r.paraId, marketplaceAccountId: r.contaId, status: "active" },
    });
    if (jaTem > 0) return "PULADO: a peca de destino ja tem anuncio ativo nesta conta";

    const recebivel = await tx.receivableItem.count({
      where: { productId: r.paraId, receivable: { status: "PENDENTE" } },
    });
    if (recebivel > 0) return "PULADO: peca de destino com venda de balcao em aberto";

    // COMPARE-AND-SWAP: entre a medicao e agora o lojista pode ter arrumado o
    // vinculo. Zero linha = decisao recente de gente, que vence plano velho.
    const trocadas = await tx.$executeRaw`
      UPDATE "ProductListing"
         SET "productId" = ${r.paraId}, "updatedAt" = NOW()
       WHERE id = ${r.listingId} AND "productId" = ${r.deId}
    `;
    if (trocadas !== 1) return "PULADO: o vinculo mudou depois da medicao";

    // Sem isto a proxima ingestao envenena a identidade para AMBIGUOUS/NULL e o
    // alias aprendido daquele anuncio morre — estado GRUDENTE.
    const chave = `listing:${r.contaId}:${r.externo}`;
    await tx.$executeRaw`
      UPDATE "ProductIngestionIdentity"
         SET "productId" = ${r.paraId}, status = 'CONFIRMED', "updatedAt" = NOW()
       WHERE "userId" = ${r.ownerId} AND platform = 'MERCADO_LIVRE' AND "identityKey" = ${chave}
    `;

    // Job pendente com o produto ANTIGO nao acha mais o anuncio e cai em "Sem
    // resultado da sincronizacao" ate esgotar as tentativas: e ruido de alarme,
    // nao perda de baixa. Levar o job junto evita o ruido.
    await tx.$executeRaw`
      UPDATE "StockSyncJob" SET "productId" = ${r.paraId}, "updatedAt" = NOW()
       WHERE "listingId" = ${r.listingId} AND status = 'PENDING'
    `;

    await tx.systemLog.create({
      data: {
        action: "ML_LISTING_RELINKED",
        level: "INFO",
        message: `Anúncio ${r.externo} foi religado para a peça "${r.paraNome}", que é a que ele está vendendo.`,
        userId: r.ownerId,
        resource: "Listing",
        resourceId: r.listingId,
        details: {
          origem: "aplicar-religamento",
          externalListingId: r.externo,
          deProduto: r.deId,
          paraProduto: r.paraId,
          paraNome: r.paraNome,
          accountId: r.contaId,
        },
      },
    });

    return "RELIGADO";
  });
}

async function main(): Promise<void> {
  assertBanco();
  const plano = JSON.parse(fs.readFileSync(path.join(PLANO, "religamento-plano.json"), "utf8")) as {
    resultados: Caso[];
  };
  let alvos = plano.resultados.filter((c) => c.veredito === "RELIGAR");
  if (LIMITE > 0) alvos = alvos.slice(0, LIMITE);

  console.log(`${DRY ? "DRY-RUN" : "APLICANDO"} — ${alvos.length} caso(s) com veredito RELIGAR`);

  const resolvidos: Resolvido[] = [];
  const pulados: Array<{ externo: string; motivoDoPulo: string }> = [];
  for (const caso of alvos) {
    const r = await resolverCaso(caso);
    if ("motivoDoPulo" in r && !("listingId" in r)) pulados.push(r as { externo: string; motivoDoPulo: string });
    else resolvidos.push(r as Resolvido);
  }

  const backup = path.join(PLANO, `religamento-backup-${alvos.length}.json`);
  fs.writeFileSync(backup, JSON.stringify({ geradoEm: new Date().toISOString(), resolvidos, pulados }, null, 1));
  console.log(`backup do estado ANTERIOR: ${backup}`);

  if (DRY) {
    console.log(`resolvidos: ${resolvidos.length} | nao resolvidos: ${pulados.length}`);
    for (const p of pulados.slice(0, 10)) console.log(`  ${p.externo}: ${p.motivoDoPulo}`);
    for (const r of resolvidos.slice(0, 5)) console.log(`  ${r.externo}: ${r.deId} -> ${r.paraId} (${r.paraNome.slice(0, 40)})`);
    console.log("\nnada foi escrito. Para aplicar: RELIGAR_VINCULO_APPLY=1 ... --apply");
    await prisma.$disconnect();
    return;
  }

  const contagem: Record<string, number> = {};
  for (const r of resolvidos) {
    let desfecho: string;
    try {
      desfecho = await aplicarUm(r);
    } catch (erro) {
      desfecho = `ERRO: ${erro instanceof Error ? erro.message : String(erro)}`;
    }
    contagem[desfecho.split(":")[0]] = (contagem[desfecho.split(":")[0]] ?? 0) + 1;
    console.log(`  ${r.externo}: ${desfecho}`);
  }
  console.log(JSON.stringify(contagem, null, 1));
  await prisma.$disconnect();
}

main().catch(async (erro) => {
  await prisma.$disconnect();
  throw erro;
});
