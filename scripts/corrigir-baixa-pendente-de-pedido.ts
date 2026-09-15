/**
 * BAIXA QUE NUNCA ACONTECEU EM VENDA JA CONFIRMADA
 * ================================================
 *
 * Consome o JSON de `auditar-baixa-de-pedidos-ml.ts --todos` e desconta o
 * estoque das vendas PAGAS que ficaram sem baixa mesmo tendo anuncio vinculado.
 *
 * DE ONDE VEM O CASO
 * O pedido entrou quando o anuncio ainda NAO estava vinculado a nenhuma peca —
 * tipicamente durante a montagem do catalogo do cliente. O `main` registra a
 * venda sem itens (quarentena) e nao desconta. Depois o vinculo foi criado, e
 * hoje o anuncio tem dono: a peca vendida continua marcada como disponivel.
 *
 * No MK2 os 55 casos estao todos entre 30/07 e 13/08, a janela em que o
 * catalogo estava sendo montado. Nao e defeito em curso, e passivo parado.
 *
 * ⚠️ NAO E O MESMO QUE "ANUNCIO NUNCA IMPORTADO". Quando o cliente
 * simplesmente nao importou os anuncios dele, a venda sem baixa e consequencia
 * da escolha dele, nao defeito nosso — esses casos ficam de fora (o filtro e
 * exigir que o anuncio TENHA dono hoje). Medicao de 14/09/2026: de 705
 * ocorrencias, 522 eram catalogo nao importado e so 183 eram defeito.
 *
 * ⚠️ NAO FABRICA `OrderItem`. Criar a linha exigiria inventar preco unitario,
 * e dado financeiro chutado e pior que dado ausente. O que se corrige aqui e o
 * ESTOQUE, com `StockLog` explicando a origem. O pedido ja existe no banco,
 * entao a reimportacao nao o processa de novo (guarda `orderRepository.exists`)
 * e nao ha risco de baixa dupla.
 *
 * IDEMPOTENTE: pula quem ja tem `StockLog` citando o numero do pedido.
 *
 * CLI:
 *   npx tsx scripts/corrigir-baixa-pendente-de-pedido.ts --auditoria=<arquivo.json> --dry-run
 *   npx tsx scripts/corrigir-baixa-pendente-de-pedido.ts --auditoria=<arquivo.json> --apply
 *   ... --cliente="MK2 Auto Peças"   (restringe a um cliente)
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import prisma from "../app/lib/prisma";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const p = `--${n}=`;
  const f = args.find((a) => a.startsWith(p));
  return f ? f.slice(p.length) : undefined;
};
const OUT_DIR = path.resolve(__dirname, "out");
const DRY = !args.includes("--apply");

function assertBanco() {
  const host =
    (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "(desconhecido)";
  if (!args.includes("--allow-any-host") && !host.includes("sa-east-1")) {
    throw new Error(`DATABASE_URL aponta para "${host}", nao sa-east-1.`);
  }
  return host;
}

type Achado = {
  Cliente: string;
  Pedido: string;
  Status: string;
  Data: string;
  Problema: string;
  "O ML vendeu": string;
  "A Dexo baixou": string;
  "Dono correto do anuncio": string;
};

async function main() {
  const host = assertBanco();
  const arquivo = arg("auditoria");
  const soCliente = arg("cliente");
  if (!arquivo) throw new Error("Informe --auditoria=<json do auditar-baixa-de-pedidos-ml>");

  const bruto = JSON.parse(fs.readFileSync(arquivo, "utf8")) as {
    achados: Achado[];
  };
  console.log(`[baixa] banco ${host} | modo ${DRY ? "DRY-RUN" : "APPLY"}`);

  // O recorte: venda PAGA, sem nenhuma baixa, e o anúncio TEM dono hoje.
  const candidatos = bruto.achados.filter(
    (a) =>
      a.Problema === "pedido sem nenhuma baixa" &&
      a.Status === "PAID" &&
      !/anuncio sem vinculo/.test(a["Dono correto do anuncio"] ?? "") &&
      (!soCliente || a.Cliente === soCliente),
  );
  console.log(`[baixa] candidatos no relatorio: ${candidatos.length}`);

  type Plano = {
    cliente: string;
    pedido: string;
    data: string;
    anuncio: string;
    produtoId: string;
    sku: string;
    nome: string;
    estoqueAtual: number;
    qtd: number;
    estoqueFinal: number;
  };
  const planos: Plano[] = [];
  const pulados = new Map<string, number>();
  const pula = (m: string) => pulados.set(m, (pulados.get(m) ?? 0) + 1);

  for (const a of candidatos) {
    // Idempotência: se já existe movimentação citando o pedido, nada a fazer.
    const jaTem = await prisma.stockLog.count({
      where: { reason: { contains: a.Pedido } },
    });
    if (jaTem > 0) {
      pula("ja tem movimentacao citando o pedido");
      continue;
    }

    // O pedido ganhou itens depois do relatório? Então não está mais vazio.
    const comItens = await prisma.orderItem.count({
      where: { order: { externalOrderId: a.Pedido } },
    });
    if (comItens > 0) {
      pula("o pedido ja tem itens agora");
      continue;
    }

    // Cada anúncio vendido no pedido, com a quantidade que o ML informou.
    const vendidos = [...String(a["O ML vendeu"]).matchAll(/(MLB\d+)[^]*?x(\d+)/g)];
    if (vendidos.length === 0) {
      pula("nao consegui ler o anuncio/quantidade do relatorio");
      continue;
    }

    for (const [, mlb, qtdTxt] of vendidos) {
      const qtd = Number(qtdTxt) || 1;
      const pl = await prisma.productListing.findFirst({
        where: { externalListingId: mlb },
        select: {
          product: { select: { id: true, sku: true, name: true, stock: true } },
        },
      });
      if (!pl?.product) {
        pula("o anuncio perdeu o vinculo desde o relatorio");
        continue;
      }
      if (pl.product.stock <= 0) {
        pula("o dono ja esta zerado — nada a descontar");
        continue;
      }
      planos.push({
        cliente: a.Cliente,
        pedido: a.Pedido,
        data: a.Data,
        anuncio: mlb,
        produtoId: pl.product.id,
        sku: pl.product.sku,
        nome: pl.product.name,
        estoqueAtual: pl.product.stock,
        qtd,
        estoqueFinal: Math.max(0, pl.product.stock - qtd),
      });
    }
  }

  console.log("\n--- PLANO ---");
  console.log(`baixas a aplicar   : ${planos.length}`);
  const porCliente = new Map<string, number>();
  for (const p of planos) porCliente.set(p.cliente, (porCliente.get(p.cliente) ?? 0) + 1);
  for (const [c, n] of [...porCliente.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${String(n).padStart(4)} ${c}`);
  console.log(`pulados            : ${candidatos.length - planos.length}`);
  for (const [m, n] of [...pulados.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${String(n).padStart(4)} ${m}`);
  for (const p of planos.slice(0, 6))
    console.log(
      `   ex: ${p.pedido} ${p.data} | ${p.sku} ${p.estoqueAtual}->${p.estoqueFinal} | ${p.nome.slice(0, 40)}`,
    );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modo = DRY ? "dryrun" : "apply";
  fs.writeFileSync(
    path.join(OUT_DIR, `baixa-pendente-${modo}-${stamp}.json`),
    JSON.stringify(planos, null, 1),
  );

  let feitas = 0;
  let erros = 0;
  if (!DRY) {
    for (const p of planos) {
      try {
        await prisma.$transaction(async (tx) => {
          const atual = await tx.product.findUniqueOrThrow({
            where: { id: p.produtoId },
            select: { stock: true },
          });
          if (atual.stock <= 0) return; // mudou entre o plano e agora
          const novo = Math.max(0, atual.stock - p.qtd);
          await tx.product.update({
            where: { id: p.produtoId },
            data: { stock: novo },
          });
          await tx.stockLog.create({
            data: {
              productId: p.produtoId,
              change: novo - atual.stock,
              previousStock: atual.stock,
              newStock: novo,
              reason: `Baixa retroativa da venda ML #${p.pedido} (${p.data}): o anuncio ainda nao estava vinculado a esta peca quando o pedido entrou`,
            },
          });
        });
        feitas++;
      } catch (e) {
        erros++;
        console.error(`[baixa] pedido ${p.pedido} falhou: ${(e as Error).message}`);
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      planos.map((p) => ({
        Cliente: p.cliente,
        Pedido: p.pedido,
        Data: p.data,
        Anuncio: p.anuncio,
        SKU: p.sku,
        Peca: p.nome,
        "Estoque antes": p.estoqueAtual,
        Quantidade: p.qtd,
        "Estoque depois": p.estoqueFinal,
      })),
    ),
    "Baixas",
  );
  const out = path.join(OUT_DIR, `baixa-pendente-${modo}-${stamp}.xlsx`);
  XLSX.writeFile(wb, out);

  console.log("\n===== RESUMO =====");
  console.log(`modo       ${DRY ? "DRY-RUN (nada gravado)" : "APLICADO"}`);
  console.log(`baixas     ${DRY ? planos.length : feitas}`);
  console.log(`erros      ${erros}`);
  console.log(`planilha   ${out}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[baixa][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
