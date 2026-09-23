/**
 * REMOVE A FICHA DUPLICADA QUE ESTA VAZIA.
 *
 * Alvo estreito de proposito: ficha que (a) duplica outra pelo titulo e pela
 * foto, (b) esta com estoque ZERO, (c) nao tem anuncio, e (d) nao tem NENHUM
 * vinculo — nem StockLog, nem OrderItem, nem NfeItem, nem ReceivableItem, nem
 * BudgetItem, nem identidade de ingestao.
 *
 * POR QUE ESTA CLASSE PODE SAIR SEM PERGUNTAR AO LOJISTA
 * Uma ficha assim nao carrega estoque, nao esta anunciada e nao tem historico:
 * removê-la nao tira nada dele, nao muda saldo e nao apaga registro de venda. E
 * a unica classe de duplicata em que isso e verdade — e por isso o script se
 * recusa a tocar em qualquer outra. Ficha com venda no passado FICA, mesmo
 * parecendo vazia: o historico e dela.
 *
 * DRY-RUN POR PADRAO. Escrever exige `--apply` E `REMOVER_FICHA_VAZIA=1`.
 *
 * Uso (na VPS, a partir de /var/www/dexo):
 *   npx tsx scripts/catalog-dedupe/remover-ficha-vazia.ts --lista=<arquivo.json>
 *   REMOVER_FICHA_VAZIA=1 npx tsx ... --lista=<arquivo.json> --apply
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
const DRY = !args.includes("--apply") || process.env.REMOVER_FICHA_VAZIA !== "1";
const LISTA = valor("lista", "/root/auditoria-fusao-18-09/fichas-vazias.json");
const SAIDA = valor("saida", path.dirname(LISTA));

function assertBanco(): void {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
  const host = /@([^/:]+)/.exec(url)?.[1] ?? "";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`Banco inesperado (${host}).`);
  }
}

type Candidata = { id: string; sku: string; nome: string; donoSku: string };

/**
 * Revalida TUDO ao vivo dentro da transacao: a lista e uma foto de antes, e
 * entre a medicao e agora o lojista pode ter posto estoque, anunciado ou
 * vendido. Qualquer vinculo faz o caso ser pulado, nao removido.
 */
async function removerUma(c: Candidata): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `ficha-vazia:${c.id}`);

    const p = await tx.product.findUnique({
      where: { id: c.id },
      select: { id: true, sku: true, name: true, stock: true, reservedStock: true, userId: true },
    });
    if (!p) return "PULADO: ficha ja nao existe";
    if (p.stock !== 0 || p.reservedStock !== 0) return `PULADO: ganhou estoque (${p.stock}/${p.reservedStock})`;

    const [listings, stockLogs, orderItems, nfeItems, receivableItems, budgetItems, identidades] = await Promise.all([
      tx.productListing.count({ where: { productId: c.id } }),
      tx.stockLog.count({ where: { productId: c.id } }),
      tx.orderItem.count({ where: { productId: c.id } }),
      tx.nfeItem.count({ where: { productId: c.id } }),
      tx.receivableItem.count({ where: { productId: c.id } }),
      tx.budgetItem.count({ where: { productId: c.id } }),
      tx.productIngestionIdentity.count({ where: { productId: c.id } }),
    ]);
    const presa =
      listings || stockLogs || orderItems || nfeItems || receivableItems || budgetItems || identidades;
    if (presa) {
      return `PULADO: tem vinculo (anuncios ${listings}, estoque ${stockLogs}, vendas ${orderItems}, nfe ${nfeItems}, receber ${receivableItems}, orcamento ${budgetItems}, identidade ${identidades})`;
    }

    await tx.product.delete({ where: { id: c.id } });
    await tx.systemLog.create({
      data: {
        action: "CATALOG_EMPTY_DUPLICATE_REMOVED",
        level: "INFO",
        message: `Ficha duplicada e vazia removida: ${p.sku ?? "?"} — ${p.name}. Sem estoque, sem anúncio e sem histórico; a peça segue cadastrada em ${c.donoSku}.`,
        userId: p.userId,
        resource: "Product",
        resourceId: c.id,
        details: {
          origem: "remover-ficha-vazia",
          sku: p.sku,
          nome: p.name,
          fichaQueFica: c.donoSku,
        },
      },
    });
    return "REMOVIDA";
  });
}

async function main(): Promise<void> {
  assertBanco();
  const todas = JSON.parse(fs.readFileSync(LISTA, "utf8")) as Array<Candidata & { preso: boolean }>;
  const alvos = todas.filter((c) => !c.preso);

  console.log(`${DRY ? "DRY-RUN" : "APLICANDO"} — ${alvos.length} ficha(s) vazia(s) de ${todas.length} na lista`);
  console.log(`  ${todas.length - alvos.length} ficaram de fora por terem vinculo (historico e delas)`);

  // Backup ANTES de qualquer escrita: a linha inteira, para poder recriar.
  const backup = await prisma.product.findMany({ where: { id: { in: alvos.map((a) => a.id) } } });
  const arquivo = path.join(SAIDA, `backup-fichas-vazias-${backup.length}.json`);
  fs.writeFileSync(arquivo, JSON.stringify(backup, null, 1));
  console.log(`  backup das linhas: ${arquivo} (${backup.length} fichas)`);

  if (DRY) {
    for (const a of alvos.slice(0, 5)) console.log(`   ${a.sku} — ${a.nome} (fica ${a.donoSku})`);
    console.log("\nnada foi escrito. Para aplicar: REMOVER_FICHA_VAZIA=1 ... --apply");
    await prisma.$disconnect();
    return;
  }

  const contagem: Record<string, number> = {};
  for (const a of alvos) {
    let desfecho: string;
    try {
      desfecho = await removerUma(a);
    } catch (erro) {
      desfecho = `ERRO: ${erro instanceof Error ? erro.message : String(erro)}`;
    }
    const chave = desfecho.split(":")[0];
    contagem[chave] = (contagem[chave] ?? 0) + 1;
    if (chave !== "REMOVIDA") console.log(`   ${a.sku}: ${desfecho}`);
  }
  console.log(JSON.stringify(contagem, null, 1));
  await prisma.$disconnect();
}

main().catch(async (erro) => {
  await prisma.$disconnect();
  throw erro;
});
