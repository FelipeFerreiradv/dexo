/**
 * A VENDA BAIXOU A PECA ERRADA — DESFAZ E REFAZ NO LUGAR CERTO
 * ===========================================================
 *
 * Consome o JSON de `auditar-baixa-de-pedidos-ml.ts --todos` e conserta as
 * vendas PAGAS em que o estoque saiu de uma peca que nao era a vendida.
 *
 * A CAUSA, MEDIDA
 * O `seller_sku` dessas bases esta poluido: no Motors Mania o codigo "1"
 * aparece em **7.328 anuncios**, e o catalogo tem uma peca com SKU "1" (uma
 * bobina de ignicao). A resolucao por SKU textual casava tudo nela — 39 vendas
 * de pecas completamente diferentes foram lancadas na bobina, entre 14/07 e
 * 27/07. Mesmo padrao no Tijuco Preto com o "12506".
 *
 * DOIS LADOS, E OS DOIS PRECISAM SER MEDIDOS ANTES
 *  - DEVOLVER ao produto errado a unidade que ele perdeu. ⚠️ Nem sempre houve
 *    perda: o desconto tem clamp em zero, entao peca que ja estava zerada
 *    registrou `0 -> 0` e nao ha o que devolver. Das 75 vendas pagas medidas,
 *    48 tiraram estoque de verdade e 26 foram clampadas.
 *  - BAIXAR do dono certo. ⚠️ So quando ele ainda tem estoque: 65 dos 75 ja
 *    estao zerados (a peca saiu por outra via) e baixar de novo deixaria
 *    negativo ou tiraria unidade que nao existe. Sobram 9.
 *
 * IDEMPOTENTE: pula o pedido se QUALQUER movimentacao ja cita o numero dele
 * com o marcador desta correcao, dos dois lados.
 *
 * CLI:
 *   npx tsx scripts/corrigir-baixa-na-peca-errada.ts --auditoria=<arquivo.json> --dry-run
 *   npx tsx scripts/corrigir-baixa-na-peca-errada.ts --auditoria=<arquivo.json> --apply
 *   ... --cliente="Motors Mania"
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
/** Marcador que torna a correção reconhecível e a execução idempotente. */
const MARCA = "Correcao de baixa na peca errada";

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

type Plano = {
  cliente: string;
  pedido: string;
  data: string;
  anuncio: string;
  qtd: number;
  // lado A: devolver ao que perdeu por engano
  erradoId: string | null;
  erradoSku: string | null;
  erradoEstoque: number | null;
  erradoDevolver: number;
  // lado B: baixar do dono certo
  certoId: string;
  certoSku: string;
  certoNome: string;
  certoEstoque: number;
  certoBaixar: number;
};

async function main() {
  const host = assertBanco();
  const arquivo = arg("auditoria");
  const soCliente = arg("cliente");
  if (!arquivo) throw new Error("Informe --auditoria=<json>");

  const bruto = JSON.parse(fs.readFileSync(arquivo, "utf8")) as { achados: Achado[] };
  console.log(`[errada] banco ${host} | modo ${DRY ? "DRY-RUN" : "APPLY"}`);

  const candidatos = bruto.achados.filter(
    (a) =>
      a.Problema === "baixou em produto diferente do dono do anuncio" &&
      a.Status === "PAID" &&
      (!soCliente || a.Cliente === soCliente),
  );
  console.log(`[errada] vendas pagas com baixa errada: ${candidatos.length}`);

  const planos: Plano[] = [];
  const pulados = new Map<string, number>();
  const pula = (m: string) => pulados.set(m, (pulados.get(m) ?? 0) + 1);

  for (const a of candidatos) {
    const jaFeito = await prisma.stockLog.count({
      where: { reason: { contains: MARCA }, AND: { reason: { contains: a.Pedido } } },
    });
    if (jaFeito > 0) {
      pula("ja corrigido numa execucao anterior");
      continue;
    }

    const vendidos = [...String(a["O ML vendeu"]).matchAll(/(MLB\d+)[^]*?x(\d+)/g)];
    if (vendidos.length === 0) {
      pula("nao consegui ler anuncio/quantidade");
      continue;
    }

    for (const [, mlb, qtdTxt] of vendidos) {
      const qtd = Number(qtdTxt) || 1;
      const pl = await prisma.productListing.findFirst({
        where: { externalListingId: mlb },
        select: { product: { select: { id: true, sku: true, name: true, stock: true } } },
      });
      if (!pl?.product) {
        pula("o anuncio perdeu o vinculo desde o relatorio");
        continue;
      }
      const certo = pl.product;

      // O que a Dexo baixou naquele pedido, e se de fato tirou estoque.
      const logErrado = await prisma.stockLog.findFirst({
        where: { reason: { contains: a.Pedido } },
        orderBy: { createdAt: "asc" },
        select: { productId: true, change: true },
      });
      const erradoId = logErrado?.productId ?? null;
      let erradoSku: string | null = null;
      let erradoEstoque: number | null = null;
      if (erradoId) {
        const e = await prisma.product.findUnique({
          where: { id: erradoId },
          select: { sku: true, stock: true },
        });
        erradoSku = e?.sku ?? null;
        erradoEstoque = e?.stock ?? null;
      }
      // Só devolve o que foi de fato retirado (o clamp em zero grava change 0).
      const devolver = logErrado && logErrado.change < 0 ? Math.abs(logErrado.change) : 0;
      // Só baixa do dono certo se ele ainda tiver estoque.
      const baixar = certo.stock > 0 ? Math.min(qtd, certo.stock) : 0;

      if (devolver === 0 && baixar === 0) {
        pula("nada a fazer: errado foi clampado e o certo ja esta zerado");
        continue;
      }
      // O produto errado e o certo são o mesmo? Então o vínculo já foi
      // corrigido e a baixa acabou caindo no lugar certo — não mexo.
      if (erradoId && erradoId === certo.id) {
        pula("o produto baixado ja e o dono certo hoje");
        continue;
      }

      planos.push({
        cliente: a.Cliente,
        pedido: a.Pedido,
        data: a.Data,
        anuncio: mlb,
        qtd,
        erradoId,
        erradoSku,
        erradoEstoque,
        erradoDevolver: devolver,
        certoId: certo.id,
        certoSku: certo.sku,
        certoNome: certo.name,
        certoEstoque: certo.stock,
        certoBaixar: baixar,
      });
    }
  }

  console.log("\n--- PLANO ---");
  console.log(`correcoes a aplicar : ${planos.length}`);
  console.log(`  devolucoes ao produto errado : ${planos.filter((p) => p.erradoDevolver > 0).length}`);
  console.log(`  baixas no dono certo         : ${planos.filter((p) => p.certoBaixar > 0).length}`);
  const porCliente = new Map<string, number>();
  for (const p of planos) porCliente.set(p.cliente, (porCliente.get(p.cliente) ?? 0) + 1);
  for (const [c, n] of [...porCliente.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${String(n).padStart(4)} ${c}`);
  console.log(`pulados : ${candidatos.length - planos.length}`);
  for (const [m, n] of [...pulados.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${String(n).padStart(4)} ${m}`);
  for (const p of planos.slice(0, 6))
    console.log(
      `   ex: ${p.pedido} | devolve ${p.erradoDevolver} ao ${p.erradoSku ?? "?"} | baixa ${p.certoBaixar} do ${p.certoSku}`,
    );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modo = DRY ? "dryrun" : "apply";
  fs.writeFileSync(
    path.join(OUT_DIR, `baixa-errada-${modo}-${stamp}.json`),
    JSON.stringify(planos, null, 1),
  );

  let feitas = 0;
  let erros = 0;
  if (!DRY) {
    for (const p of planos) {
      try {
        await prisma.$transaction(async (tx) => {
          if (p.erradoDevolver > 0 && p.erradoId) {
            const e = await tx.product.findUniqueOrThrow({
              where: { id: p.erradoId },
              select: { stock: true },
            });
            const novo = e.stock + p.erradoDevolver;
            await tx.product.update({ where: { id: p.erradoId }, data: { stock: novo } });
            await tx.stockLog.create({
              data: {
                productId: p.erradoId,
                change: p.erradoDevolver,
                previousStock: e.stock,
                newStock: novo,
                reason: `${MARCA}: a venda ML #${p.pedido} era do SKU ${p.certoSku}, esta peca foi baixada por engano`,
              },
            });
          }
          if (p.certoBaixar > 0) {
            const c = await tx.product.findUniqueOrThrow({
              where: { id: p.certoId },
              select: { stock: true },
            });
            const novo = Math.max(0, c.stock - p.certoBaixar);
            await tx.product.update({ where: { id: p.certoId }, data: { stock: novo } });
            await tx.stockLog.create({
              data: {
                productId: p.certoId,
                change: novo - c.stock,
                previousStock: c.stock,
                newStock: novo,
                reason: `${MARCA}: baixa da venda ML #${p.pedido}, que estava lancada no SKU ${p.erradoSku ?? "outro"}`,
              },
            });
          }
        });
        feitas++;
      } catch (e) {
        erros++;
        console.error(`[errada] pedido ${p.pedido} falhou: ${(e as Error).message}`);
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
        "SKU baixado por engano": p.erradoSku ?? "",
        "Unidades devolvidas": p.erradoDevolver,
        "SKU correto": p.certoSku,
        "Peca correta": p.certoNome,
        "Estoque do correto antes": p.certoEstoque,
        "Unidades baixadas": p.certoBaixar,
      })),
    ),
    "Correcoes",
  );
  const out = path.join(OUT_DIR, `baixa-errada-${modo}-${stamp}.xlsx`);
  XLSX.writeFile(wb, out);

  console.log("\n===== RESUMO =====");
  console.log(`modo      ${DRY ? "DRY-RUN (nada gravado)" : "APLICADO"}`);
  console.log(`correcoes ${DRY ? planos.length : feitas}`);
  console.log(`erros     ${erros}`);
  console.log(`planilha  ${out}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[errada][fatal]", e);
  await prisma.$disconnect();
  process.exit(1);
});
