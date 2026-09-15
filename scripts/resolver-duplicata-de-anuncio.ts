import "dotenv/config";
import path from "path";
import fs from "fs";
import prisma from "../app/lib/prisma";

/**
 * Resolve as duplicatas que `dedupe-anuncios-por-foto.ts` PROVOU serem a mesma
 * peça física (anúncios que compartilham id de foto no Mercado Livre).
 *
 * Regra, que é a pedida pelo cliente: **a VAAPT é a fonte da verdade.** Em cada
 * grupo, o dono é a peça que carrega a etiqueta da VAAPT (`attributes
 * .etiquetaOrigem`); as demais são duplicatas nascidas de anúncio sem
 * `seller_sku`, e o SKU delas é um número automático que ocupa etiqueta.
 *
 * Para cada duplicata, em UMA transação:
 *   1. os anúncios dela passam a apontar para o produto dono — nenhum anúncio
 *      fica órfão, e uma venda em qualquer um deles baixa o estoque certo;
 *   2. a duplicata é apagada, liberando o número da etiqueta.
 *
 * ⚠️ O ESTOQUE DO DONO NÃO É SOMADO. A duplicata costuma ter estoque 1 porque
 * veio da quantidade do anúncio; o dono costuma ter 0 porque a VAAPT diz que a
 * peça foi vendida. Somar inventaria peça que não existe no galpão. A VAAPT
 * manda, e a diferença sai listada para conferência.
 *
 * ⚠️ TRAVA DE LASTRO: duplicata com pedido, movimentação de estoque ou NF-e NÃO
 * é apagada — o Postgres bloqueia por FK (RESTRICT) e, mais importante, apagar
 * levaria histórico junto. Ela é só renomeada para `ML-<id do anúncio>`, o que
 * já libera o número. Sai listada.
 *
 * `--aplicar-estoque-do-veredito` (OPT-IN): honra o `estoqueFinalDono` que o
 * veredito trouxer, na MESMA transação da fusão, gravando `StockLog`. Sem a
 * flag o estoque do dono não é tocado — comportamento de sempre.
 *
 * dry-run por padrão + `assertBanco()` + backup COMPLETO de cada duplicata
 * (sku, nome, preço, estoque, fotos, anúncios) antes de apagar.
 *
 *   tsx scripts/resolver-duplicata-de-anuncio.ts --user-email=<email> \
 *     --veredito=scripts/out/dedupe-por-foto-<stamp>.json --dry-run
 */

const OUT_DIR = path.resolve(__dirname, "out");

const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

function assertBanco(): string {
  const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`ABORTADO: banco '${host}' não é a produção (sa-east-1).`);
  }
  return host;
}

/**
 * ⚠️ O relatório precisa carregar a MENSAGEM do erro, não só o contador.
 * Numa aplicação no Leonardo Jotabe o resumo disse "erros: 1" e o JSON não
 * guardava nada além do número — a conferência no banco mostrou que o trabalho
 * tinha landado (0 órfãos, anúncios no dono certo), mas não deu para saber o
 * que falhou. Contador sem mensagem é um alarme que não se pode investigar.
 */
interface ClusterProduto { id: string; sku: string; nome: string; estoque: number; daVaapt: boolean; lastro: boolean; anuncios: number }
interface Cluster {
  anuncios: string[]; produtos: ClusterProduto[]; dono: string; duplicatas: string[];
  /**
   * ADITIVO (opcional). Estoque que o dono deve ficar depois da fusão, decidido
   * por quem gerou o veredito. Só é lido com `--aplicar-estoque-do-veredito`;
   * ausente ou sem a flag ⇒ o estoque do dono não é tocado, como sempre.
   *
   * POR QUE EXISTE. Na Shopee da MK2 os 1.321 anúncios a fundir estão TODOS
   * ativos, e 629 dos donos estão com estoque 0 porque a VAAPT diz "não
   * estocado" (a peça nunca foi endereçada) ou "Vendido". Fundir sem decidir o
   * estoque na MESMA transação abre uma janela em que o anúncio ativo aponta
   * para produto zerado — e a sincronia de estoque pausa o anúncio nessa
   * janela. A decisão vem junto ou não vem.
   */
  estoqueFinalDono?: number;
  politicaEstoque?: string;
  /**
   * ADITIVO. Prefixo do SKU quando a duplicata NÃO pode ser apagada (ganhou
   * lastro entre a análise e o apply). Ausente ⇒ "ML", como sempre. Existe
   * porque o veredito da Shopee marcaria uma peça Shopee como `ML-<id>`, e o
   * rótulo errado fica gravado no catálogo do cliente.
   */
  prefixoRenomear?: string;
}

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  const veredito = arg("veredito");
  if (!email) throw new Error("Faltou --user-email=<email>");
  if (!veredito) throw new Error("Faltou --veredito=<caminho do JSON do dedupe>");
  const dryRun = !args.includes("--apply");
  const limite = Number(arg("limite") ?? "0");
  // OPT-IN: sem a flag, o estoque do dono não é tocado (comportamento de sempre).
  const aplicarEstoque = args.includes("--aplicar-estoque-do-veredito");

  const user = await prisma.user.findFirstOrThrow({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true },
  });

  const rel = JSON.parse(fs.readFileSync(veredito, "utf8"));
  const clusters: Cluster[] = (rel.clusters ?? []).filter((c: Cluster) => c.dono);

  console.log(`\n===== RESOLVER DUPLICATA DE ANÚNCIO =====`);
  console.log(`banco : ${host}`);
  console.log(`user  : ${user.email}`);
  console.log(`modo  : ${dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`fonte : ${path.basename(veredito)} — ${clusters.length} grupos com dono claro`);
  console.log(`estoque: ${aplicarEstoque ? "aplica o `estoqueFinalDono` do veredito (na mesma transação)" : "NÃO tocado (padrão)"}`);
  if (limite) console.log(`limite: só os ${limite} primeiros`);

  interface Plano {
    donoId: string; donoSku: string; donoEstoque: number;
    dupId: string; dupSku: string; dupNome: string; dupEstoque: number;
    anunciosMover: string[]; apagar: boolean; motivoNaoApagar: string;
    estoqueFinalDono: number | null; politicaEstoque: string; prefixoRenomear: string;
  }
  const planos: Plano[] = [];
  const falhas: Array<{ dupSku: string; dupId: string; donoSku: string; erro: string }> = [];
  const recusas: Array<{ sku: string; motivo: string }> = [];

  // ⚠️ A MESMA DUPLICATA PODE APARECER EM VARIOS CLUSTERS. Um produto que
  // compartilha foto com dois grupos distintos entra no plano duas ou tres
  // vezes; o primeiro delete funciona e os seguintes falham com "Record to
  // delete does not exist" — erro que ASSUSTA no resumo e nao e dano nenhum.
  // Medido no Revive: o SKU 1901 estava em 3 clusters e gerou 2 "erros".
  const jaPlanejada = new Set<string>();
  const alvo = limite ? clusters.slice(0, limite) : clusters;
  for (const c of alvo) {
    const dono = c.produtos.find((p) => p.sku === c.dono);
    if (!dono) { recusas.push({ sku: c.dono, motivo: "dono não encontrado no grupo" }); continue; }
    // reconfere no banco: o veredito pode ter envelhecido
    const donoAtual = await prisma.product.findFirst({ where: { id: dono.id, userId: user.id }, select: { id: true, sku: true, stock: true } });
    if (!donoAtual) { recusas.push({ sku: c.dono, motivo: "o produto dono não existe mais" }); continue; }

    for (const dupSku of c.duplicatas) {
      const dup = c.produtos.find((p) => p.sku === dupSku);
      if (!dup) continue;
      const dupAtual = await prisma.product.findFirst({
        where: { id: dup.id, userId: user.id },
        select: { id: true, sku: true, name: true, stock: true,
          listings: { select: { id: true, externalListingId: true } },
          _count: { select: { orderItems: true, stockLogs: true, nfeItens: true } } },
      });
      if (!dupAtual) { recusas.push({ sku: dupSku, motivo: "a duplicata não existe mais" }); continue; }
      if (jaPlanejada.has(dupAtual.id)) {
        recusas.push({ sku: dupSku, motivo: "duplicata ja planejada noutro grupo — ignorada aqui" });
        continue;
      }
      jaPlanejada.add(dupAtual.id);
      const temLastro = dupAtual._count.orderItems > 0 || dupAtual._count.stockLogs > 0 || dupAtual._count.nfeItens > 0;
      planos.push({
        donoId: donoAtual.id, donoSku: donoAtual.sku, donoEstoque: donoAtual.stock,
        dupId: dupAtual.id, dupSku: dupAtual.sku, dupNome: dupAtual.name, dupEstoque: dupAtual.stock,
        anunciosMover: dupAtual.listings.map((l) => l.externalListingId ?? "").filter(Boolean),
        apagar: !temLastro,
        motivoNaoApagar: temLastro ? "tem pedido/movimentação/NF-e — só renomeia" : "",
        estoqueFinalDono:
          aplicarEstoque && typeof c.estoqueFinalDono === "number"
            ? c.estoqueFinalDono
            : null,
        politicaEstoque: c.politicaEstoque ?? "",
        prefixoRenomear: (c.prefixoRenomear ?? "ML").replace(/[^A-Za-z0-9]/g, "") || "ML",
      });
    }
  }

  console.log(`\n--- PLANO ---`);
  console.log(`  duplicatas a resolver ........: ${planos.length}`);
  console.log(`     apagar (sem lastro) .......: ${planos.filter((p) => p.apagar).length}`);
  console.log(`     só renomear (com lastro) ..: ${planos.filter((p) => !p.apagar).length}`);
  console.log(`  anúncios a mover para o dono .: ${planos.reduce((s, p) => s + p.anunciosMover.length, 0)}`);
  const difEstoque = planos.filter((p) => p.dupEstoque !== p.donoEstoque);
  console.log(`  estoque diferente entre os dois: ${difEstoque.length} (fica o do dono, a VAAPT manda)`);
  console.log(`  recusados ....................: ${recusas.length}`);
  console.log(`\n  amostra:`);
  for (const p of planos.slice(0, 8)) {
    console.log(`     dup ${p.dupSku.padEnd(8)} (est ${p.dupEstoque}) → dono ${p.donoSku.padEnd(10)} (est ${p.donoEstoque}) | move ${p.anunciosMover.length} anúncio | ${p.apagar ? "APAGAR" : "renomear: " + p.motivoNaoApagar}`);
    console.log(`        "${p.dupNome.slice(0, 56)}"`);
  }
  for (const r of recusas.slice(0, 6)) console.log(`     ✗ ${r.sku}: ${r.motivo}`);

  // ---------- backup completo antes de qualquer escrita ----------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ids = planos.map((p) => p.dupId);
  const backup = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, sku: true, name: true, description: true, price: true, stock: true, quality: true,
      location: true, locationId: true, imageUrl: true, imageUrls: true, partNumber: true,
      brand: true, model: true, year: true, category: true, attributes: true, createdAt: true,
      listings: { select: { id: true, externalListingId: true, marketplaceAccountId: true } },
    },
  });
  const bkp = path.join(OUT_DIR, `duplicatas-backup-${dryRun ? "dryrun" : "apply"}-${stamp}.json`);
  fs.writeFileSync(bkp, JSON.stringify({ banco: host, user: user.email, produtos: backup }, null, 1), "utf8");
  console.log(`\n  backup completo das duplicatas: scripts/out/${path.basename(bkp)}`);

  let movidos = 0, apagados = 0, renomeados = 0, erros = 0, estoquesAjustados = 0;
  if (!dryRun) {
    console.log(`\n[dados] resolvendo ${planos.length}...`);
    for (const p of planos) {
      try {
        await prisma.$transaction(async (tx) => {
          // 1. anúncios da duplicata passam para o dono
          const r = await tx.productListing.updateMany({ where: { productId: p.dupId }, data: { productId: p.donoId } });
          movidos += r.count;
          // 2. some a duplicata (ou só renomeia, se tiver histórico)
          if (p.apagar) {
            await tx.product.delete({ where: { id: p.dupId } });
            apagados++;
          } else {
            const novo = `${p.prefixoRenomear}-${p.anunciosMover[0] ?? p.dupId.slice(-12)}`;
            await tx.product.update({ where: { id: p.dupId }, data: { sku: novo, skuNormalized: novo.toLowerCase() } });
            renomeados++;
          }
          // 3. estoque do dono, se o veredito decidiu (OPT-IN). Na MESMA
          // transação do passo 1: o anúncio ativo não pode existir nem por um
          // instante apontando para um estoque que ainda não foi decidido.
          // Relê antes de escrever — o veredito pode ter envelhecido — e grava
          // MOVIMENTO, para o número não mudar sozinho no histórico.
          if (p.estoqueFinalDono !== null) {
            const atual = await tx.product.findUnique({ where: { id: p.donoId }, select: { stock: true } });
            if (atual && atual.stock !== p.estoqueFinalDono) {
              await tx.product.update({ where: { id: p.donoId }, data: { stock: p.estoqueFinalDono } });
              await tx.stockLog.create({
                data: {
                  productId: p.donoId,
                  change: p.estoqueFinalDono - atual.stock,
                  previousStock: atual.stock,
                  newStock: p.estoqueFinalDono,
                  reason: `Fusão de duplicata de anúncio (${p.politicaEstoque || "veredito"}): SKU ${p.dupSku} unificado nesta peça`,
                },
              });
              estoquesAjustados++;
            }
          }
        });
      } catch (e) {
        erros++;
        const msg = e instanceof Error ? e.message : String(e);
        // Vai para o JSON também: o console rola e some, o relatório fica.
        falhas.push({ dupSku: p.dupSku, dupId: p.dupId, donoSku: p.donoSku, erro: msg });
        if (erros <= 10) console.error(`  ✗ ${p.dupSku}: ${msg}`);
      }
    }
  }

  const saida = path.join(OUT_DIR, `duplicatas-${dryRun ? "dryrun" : "apply"}-${stamp}.json`);
  fs.writeFileSync(saida, JSON.stringify({
    banco: host, user: user.email, modo: dryRun ? "dry-run" : "apply", veredito: path.basename(veredito),
    aplicarEstoque, falhas,
    totais: { planos: planos.length, apagar: planos.filter((p) => p.apagar).length, renomear: planos.filter((p) => !p.apagar).length, movidos, apagados, renomeados, estoquesAjustados, erros, recusados: recusas.length },
    planos, recusas, backup: path.basename(bkp),
  }, null, 1), "utf8");

  console.log(`\n===== RESUMO =====`);
  console.log(`modo: ${dryRun ? "DRY-RUN (0 escritas)" : "APPLY"}`);
  console.log(`  duplicatas ${dryRun ? "a resolver" : "resolvidas"}: ${dryRun ? planos.length : apagados + renomeados}`);
  console.log(`     apagadas: ${apagados} | renomeadas: ${renomeados} | anúncios movidos: ${movidos}`);
  if (aplicarEstoque) {
    const comEstoque = planos.filter((p) => p.estoqueFinalDono !== null);
    const mudam = comEstoque.filter((p) => p.estoqueFinalDono !== p.donoEstoque);
    console.log(`  estoque pelo veredito: ${dryRun ? `${mudam.length} a ajustar de ${comEstoque.length}` : `${estoquesAjustados} ajustados`}`);
    const pol = new Map<string, number>();
    for (const p of comEstoque) pol.set(p.politicaEstoque || "-", (pol.get(p.politicaEstoque || "-") ?? 0) + 1);
    for (const [k, v] of [...pol].sort((a, b) => b[1] - a[1])) console.log(`     ${k.padEnd(20)} ${v}`);
  }
  console.log(`  erros: ${erros}`);
  console.log(`  detalhe: scripts/out/${path.basename(saida)}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
