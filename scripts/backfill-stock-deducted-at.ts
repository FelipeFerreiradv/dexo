/**
 * Backfill de `Order.stockDeductedAt` para o historico.
 *
 * POR QUE EXISTE
 *
 * A coluna nasceu em 29/07/2026 e so e preenchida na baixa NOVA. Todo pedido
 * anterior ficou com NULL mesmo tendo baixado estoque — medido em producao em
 * 30/07/2026: 6.128 pedidos (4.592 ML, 1.534 Shopee, 2 Magalu) com StockLog de
 * venda e sem carimbo.
 *
 * Isso torna inutil justamente a consulta que a coluna existe para servir, a que
 * o suporte usa para responder "quais vendas estao sem baixa?":
 *
 *   SELECT ... FROM "Order" WHERE status <> 'CANCELLED' AND "stockDeductedAt" IS NULL
 *
 * Hoje ela devolveria os 6.128 pedidos JA baixados junto com os que realmente
 * faltam, e nao serve para nada.
 *
 * QUAL A EVIDENCIA DE QUE BAIXOU
 *
 * O `StockLog` com a `reason` deterministica da venda ("Venda ML #id",
 * "Venda Shopee #sn", "Venda Magalu #id") — a MESMA ancora que a idempotencia da
 * baixa usa. E o vinculo e reforcado exigindo que o `productId` do StockLog seja
 * um produto DAQUELE pedido, para nao casar por acidente com um pedido de outro
 * tenant que tenha o mesmo id externo.
 *
 * O carimbo recebe o instante do StockLog (o mais recente do pedido), nao
 * `now()`: e a hora em que a baixa aconteceu de verdade.
 *
 * SEGURANCA
 *
 * Nada no codigo DECIDE por `stockDeductedAt`. O unico uso e a guarda
 * `jaCarimbado` em `deductStockForOrder`, que apenas evita reescrever o carimbo.
 * Portanto o backfill nao muda comportamento de baixa, de estorno nem de
 * pendencia — so torna a coluna de diagnostico verdadeira.
 *
 * Nao toca em pedido CANCELLED (a baixa dele foi estornada) e nao toca em pedido
 * que ja tem carimbo.
 *
 * USO
 *   npx tsx scripts/backfill-stock-deducted-at.ts                # dry-run (default)
 *   npx tsx scripts/backfill-stock-deducted-at.ts --apply
 *   npx tsx scripts/backfill-stock-deducted-at.ts --apply --lote=500
 */
import "dotenv/config";
import prisma from "../app/lib/prisma";

/** Rotulo canonico da plataforma na `reason` — espelha rotuloDaPlataforma. */
const CASE_ROTULO = `CASE ma.platform::text
    WHEN 'MERCADO_LIVRE' THEN 'ML'
    WHEN 'SHOPEE' THEN 'Shopee'
    WHEN 'MAGALU' THEN 'Magalu'
    ELSE NULL
  END`;

/**
 * Pedidos sem carimbo que TEM StockLog de venda, com o instante da baixa.
 * `rotulo IS NOT NULL` deixa de fora plataforma cuja `reason` nao conhecemos.
 */
const SELECT_ALVO = `
  SELECT o.id AS order_id, MAX(sl."createdAt") AS quando
  FROM "Order" o
  JOIN "MarketplaceAccount" ma ON ma.id = o."marketplaceAccountId"
  JOIN "StockLog" sl
    ON sl.reason = 'Venda ' || ${CASE_ROTULO} || ' #' || o."externalOrderId"
   AND EXISTS (
     SELECT 1 FROM "OrderItem" oi
     WHERE oi."orderId" = o.id AND oi."productId" = sl."productId"
   )
  WHERE o."stockDeductedAt" IS NULL
    AND o.status <> 'CANCELLED'
    AND ${CASE_ROTULO} IS NOT NULL
  GROUP BY o.id
  -- Trava do laco: um "quando" NULL gravaria NULL de novo e o lote voltaria
  -- para sempre. Com o inner join isso nao acontece, mas o laco nao depende
  -- disso.
  HAVING MAX(sl."createdAt") IS NOT NULL
`;

function parseFlags() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const f = `--${name}=`;
    const x = argv.find((a) => a.startsWith(f));
    return x ? x.slice(f.length) : undefined;
  };
  const loteRaw = get("lote");
  return {
    apply: argv.includes("--apply"),
    lote: loteRaw && /^\d+$/.test(loteRaw) ? parseInt(loteRaw, 10) : 1000,
  };
}

async function main() {
  const { apply, lote } = parseFlags();

  const resumo = await prisma.$queryRawUnsafe<
    Array<{ plataforma: string; pedidos: number }>
  >(`
    SELECT ma.platform::text AS plataforma, COUNT(*)::int AS pedidos
    FROM (${SELECT_ALVO}) alvo
    JOIN "Order" o ON o.id = alvo.order_id
    JOIN "MarketplaceAccount" ma ON ma.id = o."marketplaceAccountId"
    GROUP BY 1 ORDER BY 2 DESC
  `);

  const total = resumo.reduce((s, r) => s + Number(r.pedidos), 0);
  console.log(`\nPedidos a carimbar: ${total}`);
  for (const r of resumo) {
    console.log(`  ${r.plataforma.padEnd(16)} ${r.pedidos}`);
  }

  if (!apply) {
    console.log(
      "\nDRY-RUN (default). Nada foi alterado. Rode com --apply para efetivar.\n",
    );
    return;
  }

  let carimbados = 0;
  for (;;) {
    // UPDATE ... FROM em lotes: `Order` tem 6.567 linhas, mas o lote mantem a
    // transacao curta e o script interrompivel sem deixar estado pela metade.
    const afetados = await prisma.$executeRawUnsafe(
      `
      UPDATE "Order" o
         SET "stockDeductedAt" = alvo.quando
        FROM (${SELECT_ALVO} LIMIT ${lote}) alvo
       WHERE o.id = alvo.order_id
    `,
    );
    if (!afetados) break;
    carimbados += afetados;
    console.log(`  ...${carimbados}/${total}`);
  }

  console.log(`\nAPLICADO: ${carimbados} pedido(s) carimbado(s).\n`);
}

main()
  .catch((err) => {
    console.error("FALHOU:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
