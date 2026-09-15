/**
 * REAPONTA O ANUNCIO PARA A PECA QUE ELE REALMENTE DESCREVE
 * ========================================================
 *
 * Consome o cache de `conferir-anuncio-vs-produto-ml.ts --varrer` e conserta os
 * vinculos em que o titulo do anuncio no ML nao tem nada a ver com o produto
 * que ele aponta na Dexo.
 *
 * DE ONDE VEM O ESTRAGO
 * A autodeteccao casa anuncio->produto por igualdade textual de SKU. Nesta base
 * o `seller_sku` esta poluido ("1" em 945 anuncios, "8383" em 468), e a etiqueta
 * VAAPT de uma peca colide com o SKU que o lojista digitou noutra. Resultado
 * medido em 14/09/2026: 2.048 de 34.322 vinculos (6,0%) apontam para peca
 * diferente, 1.854 deles com semelhanca de titulo ZERO.
 *
 * Pior: o pedido resolve o produto por esse vinculo. Sete anuncios ja tinham
 * vendido apontando para a peca errada — sete baixas de estoque no produto
 * errado. O caso que o lojista viu: um chicote vendeu e a Dexo baixou um
 * puxador, porque os dois carregam "12506".
 *
 * ⚠️ MOVER O VINCULO NAO CONSERTA A VENDA PASSADA. `OrderItem` guarda
 * `productId` e `listingId` proprios; corrigir o historico e o estoque e o que
 * a flag `--corrigir-vendas` faz, e so para pedido ainda valido (nao cancelado).
 *
 * CONSERVADOR POR CONSTRUCAO — so reaponta quando:
 *   1. a semelhanca com o candidato >= --min (padrao 0,70);
 *   2. o campeao e UNICO (sem empate, com folga de ponto flutuante);
 *   3. o candidato e claramente melhor que o produto atual (--margem, 0,30);
 *   4. o candidato nao e o proprio produto atual.
 * Qualquer duvida vira BLOQUEADO e nada muda.
 *
 * CLI:
 *   npx tsx scripts/corrigir-vinculo-anuncio-produto.ts --user-email=<email> --dry-run
 *   npx tsx scripts/corrigir-vinculo-anuncio-produto.ts --user-email=<email> --apply
 *   npx tsx scripts/corrigir-vinculo-anuncio-produto.ts --user-email=<email> --apply --corrigir-vendas
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";
import { titleSimilarity, titleTokens } from "../app/lib/title-similarity";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};

const OUT_DIR = path.resolve(__dirname, "out");
const DRY = !args.includes("--apply");
const CORRIGIR_VENDAS = args.includes("--corrigir-vendas");
const MIN_SIM = Number(arg("min") ?? 0.7);
const MARGEM = Number(arg("margem") ?? 0.3);
const EPS = 1e-9;

function assertBanco() {
  const host =
    (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`DATABASE_URL aponta para "${host}", nao sa-east-1.`);
  }
  return host;
}

type Produto = {
  id: string;
  sku: string;
  name: string;
  stock: number;
  locationId: string | null;
};

async function main() {
  const host = assertBanco();
  const email = arg("user-email");
  const userIdFlag = arg("user-id");
  if (!email && !userIdFlag) throw new Error("Informe --user-email= ou --user-id=");

  const user = userIdFlag
    ? await prisma.user.findUniqueOrThrow({
        where: { id: userIdFlag },
        select: { id: true, email: true, name: true },
      })
    : await prisma.user.findFirstOrThrow({
        where: { email: { equals: email as string, mode: "insensitive" } },
        select: { id: true, email: true, name: true },
      });

  console.log(`[corrigir] banco ${host} | modo ${DRY ? "DRY-RUN" : "APPLY"}`);
  console.log(`[corrigir] cliente ${user.name} (${user.id})`);
  console.log(`[corrigir] min=${MIN_SIM} margem=${MARGEM} corrigirVendas=${CORRIGIR_VENDAS}`);

  // ADITIVO: `--plataforma` e `--cache` permitem rodar o mesmo corretor na
  // Shopee. Sem as flags, o comportamento e byte a byte o de sempre (ML).
  // O cache da Shopee usa `titulo` onde o do ML usa `title`; o leitor abaixo
  // aceita os dois para nao duplicar codigo.
  const plataforma = (arg("plataforma") ?? "MERCADO_LIVRE").toUpperCase();
  const cacheFile =
    arg("cache") ?? path.join(OUT_DIR, `anuncios-ml-cache-${user.id}.json`);
  if (!fs.existsSync(cacheFile))
    throw new Error(`Cache ausente: ${cacheFile}. Rode a varredura primeiro.`);
  const cacheBruto = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as
    | Record<string, { title?: string | null; titulo?: string | null; vendidos?: number | null }>
    | Array<{ id: string; title?: string | null; titulo?: string | null; vendidos?: number | null }>;
  const cache: Record<string, { title: string | null; vendidos: number | null }> = {};
  for (const [chave, v] of Array.isArray(cacheBruto)
    ? cacheBruto.map((x) => [x.id, x] as const)
    : Object.entries(cacheBruto)) {
    cache[chave] = {
      title: v.title ?? v.titulo ?? null,
      vendidos: v.vendidos ?? null,
    };
  }

  const produtos = (await prisma.product.findMany({
    where: { userId: user.id },
    select: { id: true, sku: true, name: true, stock: true, locationId: true },
  })) as Produto[];
  const porId = new Map(produtos.map((p) => [p.id, p]));

  // Indice invertido token -> produtos. Sem ele seriam 2.048 x 19.868
  // comparacoes de titulo; com ele so pontuamos quem divide ao menos 1 token.
  const indice = new Map<string, string[]>();
  for (const p of produtos) {
    for (const t of titleTokens(p.name ?? "")) {
      let arr = indice.get(t);
      if (!arr) indice.set(t, (arr = []));
      arr.push(p.id);
    }
  }

  const listings = await prisma.productListing.findMany({
    where: { marketplaceAccount: { userId: user.id, platform: plataforma as never } },
    select: {
      id: true,
      externalListingId: true,
      productId: true,
      marketplaceAccount: { select: { accountName: true } },
    },
  });

  type Plano = {
    listingId: string;
    anuncio: string;
    conta: string;
    tituloML: string;
    deId: string;
    deNome: string;
    deSku: string;
    paraId?: string;
    paraNome?: string;
    paraSku?: string;
    sim?: number;
    simAtual: number;
    vendidos: number;
    decisao: "REAPONTAR" | "BLOQUEADO";
    motivo?: string;
  };

  const planos: Plano[] = [];
  const motivos = new Map<string, number>();
  const conta = (m: string) => motivos.set(m, (motivos.get(m) ?? 0) + 1);

  for (const l of listings) {
    const a = cache[l.externalListingId];
    const atual = porId.get(l.productId);
    if (!a?.title || !atual?.name) continue;

    const simAtual = titleSimilarity(a.title, atual.name);
    if (simAtual >= 0.4) continue; // bate com o produto atual, nada a fazer

    const base: Plano = {
      listingId: l.id,
      anuncio: l.externalListingId,
      conta: l.marketplaceAccount.accountName,
      tituloML: a.title,
      deId: atual.id,
      deNome: atual.name,
      deSku: atual.sku,
      simAtual: Number(simAtual.toFixed(3)),
      vendidos: a.vendidos ?? 0,
      decisao: "BLOQUEADO",
    };

    // Candidatos: só quem divide ao menos um token com o título do anúncio.
    const vistos = new Set<string>();
    for (const t of titleTokens(a.title))
      for (const id of indice.get(t) ?? []) vistos.add(id);
    vistos.delete(atual.id);

    const ranked = [...vistos]
      .map((id) => {
        const p = porId.get(id) as Produto;
        return { p, s: titleSimilarity(a.title as string, p.name) };
      })
      .sort((x, y) => y.s - x.s);

    const top = ranked[0];
    const segundo = ranked[1];

    if (!top || top.s < MIN_SIM) {
      base.motivo = `nenhum produto com semelhanca >= ${MIN_SIM}`;
      conta(base.motivo);
      planos.push(base);
      continue;
    }
    if (segundo && top.s - segundo.s <= EPS) {
      base.motivo = `empate no topo (${top.s.toFixed(2)}) entre 2+ produtos`;
      conta(base.motivo);
      base.paraNome = top.p.name;
      base.sim = Number(top.s.toFixed(3));
      planos.push(base);
      continue;
    }
    if (top.s - simAtual < MARGEM) {
      base.motivo = `ganho insuficiente sobre o produto atual (${top.s.toFixed(2)} vs ${simAtual.toFixed(2)})`;
      conta(base.motivo);
      planos.push(base);
      continue;
    }

    base.decisao = "REAPONTAR";
    base.paraId = top.p.id;
    base.paraNome = top.p.name;
    base.paraSku = top.p.sku;
    base.sim = Number(top.s.toFixed(3));
    planos.push(base);
  }

  const reapontar = planos.filter((p) => p.decisao === "REAPONTAR");
  const bloqueados = planos.filter((p) => p.decisao === "BLOQUEADO");
  const vendidosReapontar = reapontar.filter((p) => p.vendidos > 0);

  // ---- fase de conferencia na API (roda na VPS) ------------------------------
  // Le o pedido no ML e anota quais anuncios ele de fato vendeu. E a unica
  // prova de que a venda lancada no produto errado veio deste anuncio.
  if (args.includes("--conferir-vendas")) {
    const contas = await prisma.marketplaceAccount.findMany({
      where: { userId: user.id, platform: plataforma as never },
      select: { id: true, accessToken: true },
    });
    const alvo = planos.filter((p) => p.vendidos > 0);
    const mapa: Record<string, string[]> = {};
    let lidos = 0;
    for (const p of alvo) {
      const itens = await prisma.orderItem.findMany({
        where: { productId: p.deId },
        select: {
          order: {
            select: { externalOrderId: true, marketplaceAccountId: true },
          },
        },
      });
      for (const it of itens) {
        const oid = it.order.externalOrderId;
        if (mapa[oid]) continue;
        const acc = contas.find((c) => c.id === it.order.marketplaceAccountId);
        if (!acc) continue;
        try {
          const r = await fetch(
            `https://api.mercadolibre.com/orders/${oid}`,
            { headers: { Authorization: `Bearer ${acc.accessToken}` } },
          );
          if (!r.ok) {
            console.warn(`[conferir] pedido ${oid}: HTTP ${r.status}`);
            continue;
          }
          const j = (await r.json()) as {
            order_items?: Array<{ item?: { id?: string } }>;
          };
          mapa[oid] = (j.order_items ?? [])
            .map((oi) => oi.item?.id ?? "")
            .filter(Boolean);
          lidos++;
        } catch (e) {
          console.warn(`[conferir] pedido ${oid}: ${(e as Error).message}`);
        }
      }
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const f = path.join(OUT_DIR, `vendas-conferidas-${user.id}.json`);
    fs.writeFileSync(f, JSON.stringify(mapa, null, 1));
    console.log(`\n[conferir] ${lidos} pedidos conferidos na API do ML`);
    console.log(`[conferir] arquivo ${f}`);
    await prisma.$disconnect();
    return;
  }

  console.log("\n--- PLANO ---");
  console.log(`vinculos divergentes     ${planos.length}`);
  console.log(`  reapontar              ${reapontar.length}`);
  console.log(`  bloqueados             ${bloqueados.length}`);
  for (const [m, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`     ${String(n).padStart(5)} ${m}`);
  console.log(`  dos reapontados, ja venderam: ${vendidosReapontar.length}`);
  for (const p of reapontar.slice(0, 6))
    console.log(
      `   ex: ${p.anuncio} ${p.sim} | "${p.tituloML.slice(0, 40)}" : ${p.deSku} -> ${p.paraSku}`,
    );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modo = DRY ? "dryrun" : "apply";
  fs.writeFileSync(
    path.join(OUT_DIR, `vinculo-anuncio-backup-${modo}-${stamp}.json`),
    JSON.stringify(planos, null, 1),
  );

  // ---- vendas ja realizadas no produto errado --------------------------------
  type Venda = {
    anuncio: string;
    pedido: string;
    statusPedido: string;
    orderItemId: string;
    produtoErrado: string;
    produtoErradoSku: string;
    estoqueErradoAntes: number;
    produtoCerto: string;
    produtoCertoSku: string;
    estoqueCertoAntes: number;
    qtd: number;
  };
  const vendas: Venda[] = [];
  if (CORRIGIR_VENDAS) {
    // ⚠️ NAO da para casar a venda pelo `listingId` do OrderItem: em 4 dos 7
    // casos medidos ele e NULO (pedido antigo, importado antes de o vinculo
    // existir). Filtrar por `listingId` corrigia 2 de 7 e calava os outros 5.
    // Casar so por `productId` tambem nao serve — o produto errado pode ter
    // vendido legitimamente por outro anuncio.
    //
    // A unica testemunha e o proprio pedido no ML: `order_items[].item.id`.
    // Por isso a correcao exige o arquivo de conferencia gerado por
    // `--conferir-vendas` (que roda na VPS, onde o token e valido).
    const confFile = path.join(OUT_DIR, `vendas-conferidas-${user.id}.json`);
    if (!fs.existsSync(confFile)) {
      throw new Error(
        `--corrigir-vendas exige ${confFile}.\n` +
          `Gere na VPS com: npx tsx scripts/corrigir-vinculo-anuncio-produto.ts --user-email=${user.email} --conferir-vendas`,
      );
    }
    const confirmado = JSON.parse(fs.readFileSync(confFile, "utf8")) as Record<
      string,
      string[]
    >;

    for (const p of vendidosReapontar) {
      const itens = await prisma.orderItem.findMany({
        where: { productId: p.deId },
        select: {
          id: true,
          quantity: true,
          order: { select: { externalOrderId: true, status: true } },
        },
      });
      for (const it of itens) {
        // Só corrige quando o ML confirma que ESTE pedido vendeu ESTE anúncio.
        const vendidosNoPedido = confirmado[it.order.externalOrderId];
        if (!vendidosNoPedido?.includes(p.anuncio)) continue;
        // Pedido cancelado ja teve (ou nao) estorno proprio; nao mexo.
        if (it.order.status === "CANCELLED") continue;
        const errado = porId.get(p.deId) as Produto;
        const certo = porId.get(p.paraId as string) as Produto;
        vendas.push({
          anuncio: p.anuncio,
          pedido: it.order.externalOrderId,
          statusPedido: it.order.status,
          orderItemId: it.id,
          produtoErrado: errado.id,
          produtoErradoSku: errado.sku,
          estoqueErradoAntes: errado.stock,
          produtoCerto: certo.id,
          produtoCertoSku: certo.sku,
          estoqueCertoAntes: certo.stock,
          qtd: it.quantity,
        });
      }
    }
    console.log(`\n--- VENDAS A CORRIGIR --- ${vendas.length}`);
    for (const v of vendas)
      console.log(
        `   pedido ${v.pedido} (${v.statusPedido}) q${v.qtd}: devolve ${v.qtd} ao ${v.produtoErradoSku} (${v.estoqueErradoAntes}), baixa do ${v.produtoCertoSku} (${v.estoqueCertoAntes})`,
      );
  }

  // ---- gravacao --------------------------------------------------------------
  let movidos = 0;
  let estoquesAjustados = 0;
  let erros = 0;

  if (!DRY) {
    for (let i = 0; i < reapontar.length; i += 200) {
      const lote = reapontar.slice(i, i + 200);
      try {
        await prisma.$transaction(
          lote.map((p) =>
            prisma.productListing.update({
              where: { id: p.listingId },
              data: { productId: p.paraId as string },
            }),
          ),
        );
        movidos += lote.length;
      } catch (e) {
        erros += lote.length;
        console.error(`[corrigir] lote ${i} falhou: ${(e as Error).message}`);
      }
      if (i % 1000 === 0)
        process.stdout.write(`\r[corrigir] ${movidos}/${reapontar.length}   `);
    }
    console.log("");

    for (const v of vendas) {
      try {
        await prisma.$transaction(async (tx) => {
          const errado = await tx.product.findUniqueOrThrow({
            where: { id: v.produtoErrado },
            select: { stock: true },
          });
          const certo = await tx.product.findUniqueOrThrow({
            where: { id: v.produtoCerto },
            select: { stock: true },
          });
          const novoErrado = errado.stock + v.qtd;
          const novoCerto = Math.max(0, certo.stock - v.qtd);

          await tx.product.update({
            where: { id: v.produtoErrado },
            data: { stock: novoErrado },
          });
          await tx.stockLog.create({
            data: {
              productId: v.produtoErrado,
              change: v.qtd,
              previousStock: errado.stock,
              newStock: novoErrado,
              reason: `Estorno: a venda #${v.pedido} era do SKU ${v.produtoCertoSku}, o anuncio apontava para esta peca por engano`,
            },
          });

          await tx.product.update({
            where: { id: v.produtoCerto },
            data: { stock: novoCerto },
          });
          await tx.stockLog.create({
            data: {
              productId: v.produtoCerto,
              change: novoCerto - certo.stock,
              previousStock: certo.stock,
              newStock: novoCerto,
              reason: `Baixa da venda #${v.pedido}, que estava lancada no SKU ${v.produtoErradoSku} por vinculo errado`,
            },
          });

          await tx.orderItem.update({
            where: { id: v.orderItemId },
            data: { productId: v.produtoCerto },
          });
        });
        estoquesAjustados++;
      } catch (e) {
        erros++;
        console.error(`[corrigir] venda ${v.pedido} falhou: ${(e as Error).message}`);
      }
    }
  }

  // ---- planilha --------------------------------------------------------------
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { Campo: "Modo", Valor: DRY ? "DRY-RUN" : "APLICADO" },
      { Campo: "Vinculos divergentes", Valor: planos.length },
      { Campo: "Reapontados", Valor: DRY ? reapontar.length : movidos },
      { Campo: "Bloqueados", Valor: bloqueados.length },
      { Campo: "Vendas corrigidas", Valor: DRY ? vendas.length : estoquesAjustados },
      { Campo: "Erros", Valor: erros },
    ]),
    "Resumo",
  );
  if (reapontar.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        reapontar.map((p) => ({
          Anuncio: p.anuncio,
          Conta: p.conta,
          "Titulo no ML": p.tituloML,
          "Estava em": p.deNome,
          "SKU antigo": p.deSku,
          "Passa para": p.paraNome,
          "SKU novo": p.paraSku,
          Semelhanca: p.sim,
          "Ja vendeu": p.vendidos,
        })),
      ),
      "Reapontados",
    );
  if (bloqueados.length)
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        bloqueados.map((p) => ({
          Anuncio: p.anuncio,
          Conta: p.conta,
          "Titulo no ML": p.tituloML,
          "Aponta para": p.deNome,
          SKU: p.deSku,
          "Melhor candidato": p.paraNome ?? "",
          Semelhanca: p.sim ?? "",
          Motivo: p.motivo,
          "Ja vendeu": p.vendidos,
        })),
      ),
      "Bloqueados",
    );
  const xlsxOut = path.join(OUT_DIR, `vinculo-anuncio-${modo}-${stamp}.xlsx`);
  XLSX.writeFile(wb, xlsxOut);

  console.log("\n===== RESUMO =====");
  console.log(`modo                 ${DRY ? "DRY-RUN (nada gravado)" : "APLICADO"}`);
  console.log(`divergentes          ${planos.length}`);
  console.log(`reapontados          ${DRY ? reapontar.length : movidos}`);
  console.log(`bloqueados           ${bloqueados.length}`);
  console.log(`vendas corrigidas    ${DRY ? vendas.length : estoquesAjustados}`);
  console.log(`erros                ${erros}`);
  console.log(`planilha             ${xlsxOut}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[corrigir][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
