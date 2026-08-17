import prisma from "../../lib/prisma";
import { isStockReservationEnabled } from "../../financeiro/lib/stock-reservation";

// BLOCO G — mantém `Product.reservedStock`.
//
// ⭐ A DECISÃO DE DESENHO QUE IMPORTA: RECALCULAR, NÃO ACUMULAR.
//
// O caminho óbvio seria somar no create e subtrair no markPaid/reverse/delete.
// Ele tem uma classe de bug embutida: basta UM caminho esquecer de subtrair e
// a peça fica reservada para sempre, sem ninguém saber por quê. Com 65 vendas
// pendentes e a mais antiga aberta há 51 dias, uma reserva órfã não seria
// percebida — ela só apareceria como "peça que sumiu do estoque disponível".
//
// Aqui o valor é RECALCULADO a partir da fonte da verdade (as linhas de venda
// em aberto) para os produtos tocados. Consequências:
//   · reserva órfã deixa de ser possível — não há acumulação a divergir;
//   · um caminho esquecido causa valor DESATUALIZADO, não valor ERRADO para
//     sempre: o próximo toque naquele produto o conserta sozinho;
//   · e existe uma função única para consertar tudo, se algum dia precisar.
//
// O custo é um `groupBy` por escrita de venda. Uma venda tem poucos itens, e
// isso acontece no fluxo do balcão — não numa importação de 13 mil peças.

/** Status em que a venda SEGURA a peça. Espelha `reservesStock` do módulo puro. */
const STATUS_QUE_RESERVAM = ["PENDENTE", "VENCIDA"] as const;

/**
 * Recalcula `reservedStock` dos produtos informados, DENTRO da transação do
 * chamador.
 *
 * Roda depois da escrita que mudou a venda — é por isso que lê o estado já
 * atualizado. Fora da transação, uma venda criada e recebida em sequência
 * (o "receber agora" do PDV) poderia recalcular na ordem errada.
 *
 * Flag ausente ⇒ NADA acontece e nenhuma consulta é feita: a coluna pode não
 * existir no banco ainda.
 */
export async function recomputeReservedStockWithinTx(
  tx: any,
  productIds: Array<string | null | undefined>,
): Promise<void> {
  if (!isStockReservationEnabled()) return;
  const ids = Array.from(new Set(productIds.filter((p): p is string => !!p)));
  if (ids.length === 0) return;

  // A verdade: quanto cada peça está comprometida em vendas AINDA ABERTAS.
  const somas = await tx.receivableItem.groupBy({
    by: ["productId"],
    where: {
      productId: { in: ids },
      receivable: {
        status: { in: STATUS_QUE_RESERVAM as unknown as string[] },
      },
    },
    _sum: { quantity: true },
  });

  const porProduto = new Map<string, number>();
  for (const s of somas as Array<{
    productId: string;
    _sum: { quantity: number | null };
  }>) {
    porProduto.set(s.productId, s._sum.quantity ?? 0);
  }

  // Um UPDATE por produto. Produto sem linha aberta cai em 0 — é o que libera
  // a reserva quando a venda é recebida, cancelada ou excluída, sem nenhum dos
  // caminhos precisar saber disso.
  for (const id of ids) {
    const valor = porProduto.get(id) ?? 0;
    await tx.product.updateMany({
      where: { id },
      data: { reservedStock: valor },
    });
  }
}

/**
 * Mesma coisa, fora de transação — para os caminhos que não têm uma.
 *
 * Best-effort e NUNCA lança: a reserva é informação, e uma falha ao recalcular
 * não pode derrubar a venda que acabou de acontecer. O valor fica
 * desatualizado até o próximo toque, que é exatamente o modo de falha que o
 * desenho por recálculo torna aceitável.
 */
export function recomputeReservedStock(
  productIds: Array<string | null | undefined>,
  logPrefix = "[StockReservation]",
): void {
  if (!isStockReservationEnabled()) return;
  const ids = productIds.filter((p): p is string => !!p);
  if (ids.length === 0) return;
  setImmediate(() => {
    void recomputeReservedStockWithinTx(prisma as any, ids).catch((err) =>
      console.error(
        `${logPrefix} Falha ao recalcular estoque reservado (ignorado):`,
        err,
      ),
    );
  });
}
