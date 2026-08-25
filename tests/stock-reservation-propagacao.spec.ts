// BLOCO G — a PROPAGAÇÃO: a reserva saindo da tabela e chegando ao anúncio.
//
// Os specs irmãos cobrem a aritmética (`stock-reservation.spec.ts`), a sombra
// do sync (`stock-reservation-sync.spec.ts`) e a fiação das rotas
// (`stock-reservation-wiring.spec.ts` — que MOCKA este serviço, e por isso não
// enxerga nada do que está aqui).
//
// O que este arquivo trava é o elo que faltava até 25/08: o recálculo gravava
// `reservedStock` e parava. Não enfileirava `StockSyncJob`, não disparava o
// retry, não reabria anúncio. O número existia e nunca saía da tabela — e o
// `StockReconciliationService`, que seria a rede de segurança, só varre
// produtos com `StockLog` na última hora, que a reserva por definição não
// produz. Resultado: peça vendida fiado saía com o cliente e o anúncio
// continuava no ar.
//
// Testa o serviço REAL contra um `tx` de mentira. Não mocka o módulo sob teste:
// mockar o que se quer provar é como o bug passou despercebido até agora.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  firePostReservationEffects,
  recomputeReservedStockWithinTx,
} from "../app/marketplaces/services/stock-reservation.service";

type Produto = {
  id: string;
  userId: string;
  stock: number;
  reservedStock: number | null;
};

/**
 * Um `tx` de mentira com a superfície exata que o serviço usa.
 *
 * `$executeRaw` é chamado como template tag (advisory lock), então precisa ser
 * uma função comum — `vi.fn()` recebe (strings, ...values) sem reclamar.
 */
function makeTx(opts: {
  produtos?: Produto[];
  somas?: Array<{ productId: string; _sum: { quantity: number | null } }>;
  listings?: Array<{ id: string; marketplaceAccount: { platform: string } }>;
}) {
  return {
    product: {
      findMany: vi.fn().mockResolvedValue(opts.produtos ?? []),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    receivableItem: {
      groupBy: vi.fn().mockResolvedValue(opts.somas ?? []),
    },
    productListing: {
      findMany: vi.fn().mockResolvedValue(opts.listings ?? []),
    },
    stockSyncJob: { upsert: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

const UM_LISTING = [
  { id: "listing-1", marketplaceAccount: { platform: "MERCADO_LIVRE" } },
];

/** Liga as duas flags. O serviço lê `process.env` direto, sem injeção. */
function ligarTudo() {
  process.env.STOCK_RESERVATION_ENABLED = "1";
  process.env.STOCK_RESERVATION_SYNC_ENABLED = "1";
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STOCK_RESERVATION_ENABLED;
  delete process.env.STOCK_RESERVATION_SYNC_ENABLED;
});

afterEach(() => {
  delete process.env.STOCK_RESERVATION_ENABLED;
  delete process.env.STOCK_RESERVATION_SYNC_ENABLED;
  vi.useRealTimers();
});

describe("Reservar a peça EMPURRA o número para o anúncio", () => {
  it("venda fiado de peça única enfileira job com disponível ZERO", async () => {
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 0 }],
      somas: [{ productId: "p-1", _sum: { quantity: 1 } }],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    // A coluna continua sendo gravada, como sempre foi.
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1" },
      data: { reservedStock: 1 },
    });

    // E agora o número SAI: 1 em estoque − 1 reservada = 0 disponível.
    expect(r.changed).toEqual([{ productId: "p-1", before: 1, after: 0 }]);
    expect(r.enqueued).toBe(1);
    expect(tx.stockSyncJob.upsert).toHaveBeenCalledTimes(1);

    const arg = tx.stockSyncJob.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      listingId_status: { listingId: "listing-1", status: "PENDING" },
    });
    expect(arg.create.targetStock).toBe(0);
    expect(arg.create.productId).toBe("p-1");
    expect(arg.create.platform).toBe("MERCADO_LIVRE");
  });

  it("pega o advisory lock ANTES do upsert — serializa com dedução e reconciliação", async () => {
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 0 }],
      somas: [{ productId: "p-1", _sum: { quantity: 1 } }],
      listings: UM_LISTING,
    });

    await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // Sem o lock, o upsert não-atômico do Prisma dá P2002 quando o
    // StockDeductionService toca o mesmo listing.
    const ordemLock = tx.$executeRaw.mock.invocationCallOrder[0];
    const ordemUpsert = tx.stockSyncJob.upsert.mock.invocationCallOrder[0];
    expect(ordemLock).toBeLessThan(ordemUpsert);
  });

  it("peça com estoque de sobra NÃO zera: 5 em estoque, 2 vendidas ⇒ anuncia 3", async () => {
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 5, reservedStock: 0 }],
      somas: [{ productId: "p-1", _sum: { quantity: 2 } }],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(r.changed).toEqual([{ productId: "p-1", before: 5, after: 3 }]);
    expect(tx.stockSyncJob.upsert.mock.calls[0][0].create.targetStock).toBe(3);
    // Nada a reabrir: o anúncio nunca saiu do ar.
    expect(r.reopened).toEqual([]);
  });

  it("o job nasce ADIADO, e o upsert NUNCA reescreve nextRunAt", async () => {
    // ⭐ A regressão que este teste existe para impedir: no `markPaid` o
    // `deductWithinTx` acabou de enfileirar o MESMO job com `nextRunAt: now`
    // para a baixa real. Se o recálculo da reserva sobrescrevesse esse campo
    // com "daqui a 5s", a baixa de estoque chegaria atrasada ao marketplace por
    // causa de um recálculo que nem sempre muda alguma coisa.
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 0 }],
      somas: [{ productId: "p-1", _sum: { quantity: 1 } }],
      listings: UM_LISTING,
    });

    const antes = Date.now();
    await recomputeReservedStockWithinTx(tx, ["p-1"]);
    const arg = tx.stockSyncJob.upsert.mock.calls[0][0];

    expect(arg.create.nextRunAt.getTime()).toBeGreaterThan(antes);
    expect("nextRunAt" in arg.update).toBe(false);
    // E não "cura" job que vinha falhando — mesmo motivo do reconciliador.
    expect("attempts" in arg.update).toBe(false);
    expect("lastError" in arg.update).toBe(false);
    expect(arg.update).toEqual({ targetStock: 0 });
  });
});

describe("RECEBER a venda não faz o anúncio piscar", () => {
  it("disponível igual antes e depois ⇒ zero job, zero chamada", async () => {
    // ⭐ O caso do contrato de aceite. No `markPaid` o `deductWithinTx` roda
    // ANTES do recálculo, na mesma transação: quando chegamos aqui o `stock` da
    // peça já caiu de 1 para 0 e a venda já é PAGA (soma vazia).
    //   antes  = max(0, 0 − 1) = 0
    //   depois = max(0, 0 − 0) = 0
    // Igual ⇒ nada a propagar. Se algum dia isto virar `changed`, o anúncio
    // volta ao ar entre reservar e receber, que é exatamente o que o dono do
    // sistema pediu para não acontecer.
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 0, reservedStock: 1 }],
      somas: [],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(r.changed).toEqual([]);
    expect(r.reopened).toEqual([]);
    expect(r.enqueued).toBe(0);
    // Nem sequer vai buscar os anúncios: sem mudança, não há trabalho.
    expect(tx.productListing.findMany).not.toHaveBeenCalled();
    expect(tx.stockSyncJob.upsert).not.toHaveBeenCalled();
    // Mas a coluna FOI zerada — a reserva deixou de existir.
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1" },
      data: { reservedStock: 0 },
    });
  });
});

describe("LIBERAR a reserva devolve a peça e reabre o anúncio", () => {
  it("excluir a venda: disponível sobe de 0 para 1 e marca reabertura", async () => {
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 1 }],
      somas: [], // a venda sumiu
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(r.changed).toEqual([{ productId: "p-1", before: 0, after: 1 }]);
    expect(r.reopened).toEqual([{ productId: "p-1", userId: "u-1" }]);
    expect(tx.stockSyncJob.upsert.mock.calls[0][0].create.targetStock).toBe(1);
  });

  it("a reabertura usa Product.userId — e não o dono do tenant", async () => {
    // 1.009 produtos em produção (25/08) têm `Product.userId` apontando para um
    // COLABORADOR. `pauseListings` valida posse comparando contra essa mesma
    // coluna, então usar o `dataOwnerId` da requisição faria a reabertura
    // falhar em silêncio justamente neles.
    ligarTudo();
    const tx = makeTx({
      produtos: [
        { id: "p-1", userId: "colaborador-77", stock: 1, reservedStock: 1 },
      ],
      somas: [],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(r.reopened).toEqual([
      { productId: "p-1", userId: "colaborador-77" },
    ]);
  });

  it("peça que continua sem disponível NÃO é reaberta", async () => {
    // Reserva cai de 2 para 1, mas o estoque é 1: continua tudo comprometido.
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 2 }],
      somas: [{ productId: "p-1", _sum: { quantity: 1 } }],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(r.changed).toEqual([]);
    expect(r.reopened).toEqual([]);
  });
});

describe("Over-reserve: a venda dupla já aconteceu", () => {
  it("nada fica negativo e nada é enfileirado", async () => {
    // Peça vendida no ML no mesmo dia do fiado: stock 0, reserva 2.
    // `availableForSale` clampa em 0 dos dois lados ⇒ sem mudança, sem anúncio
    // zumbi, sem quantidade negativa saindo para o marketplace.
    ligarTudo();
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 0, reservedStock: 1 }],
      somas: [{ productId: "p-1", _sum: { quantity: 2 } }],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(r.changed).toEqual([]);
    expect(r.enqueued).toBe(0);
    // A coluna registra o over-reserve, que é o sinal para o operador.
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1" },
      data: { reservedStock: 2 },
    });
  });
});

describe("As flags — REGRA ZERO", () => {
  it("flag principal DESLIGADA: nenhuma consulta, nenhuma escrita", async () => {
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 0 }],
      somas: [{ productId: "p-1", _sum: { quantity: 1 } }],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(tx.product.findMany).not.toHaveBeenCalled();
    expect(tx.receivableItem.groupBy).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.stockSyncJob.upsert).not.toHaveBeenCalled();
    expect(r).toEqual({ changed: [], reopened: [], enqueued: 0 });
  });

  it("sub-flag de propagação DESLIGADA: grava a coluna e para — como antes de 25/08", async () => {
    // É o estado intermediário da ativação: a reserva vira informação, e o
    // número ainda não viaja. Nenhuma consulta NOVA em relação ao que o
    // recálculo já fazia — nem o findMany do estado anterior.
    process.env.STOCK_RESERVATION_ENABLED = "1";
    const tx = makeTx({
      produtos: [{ id: "p-1", userId: "u-1", stock: 1, reservedStock: 0 }],
      somas: [{ productId: "p-1", _sum: { quantity: 1 } }],
      listings: UM_LISTING,
    });

    const r = await recomputeReservedStockWithinTx(tx, ["p-1"]);

    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1" },
      data: { reservedStock: 1 },
    });
    expect(tx.product.findMany).not.toHaveBeenCalled();
    expect(tx.productListing.findMany).not.toHaveBeenCalled();
    expect(tx.stockSyncJob.upsert).not.toHaveBeenCalled();
    expect(r.enqueued).toBe(0);
  });

  it("item MANUAL (sem productId) não toca em nada", async () => {
    // Peça avulsa é 52 das 65 vendas abertas em produção. Não tem produto de
    // catálogo a segurar — e não pode disparar pausa nem alerta.
    ligarTudo();
    const tx = makeTx({ listings: UM_LISTING });

    const r = await recomputeReservedStockWithinTx(tx, [null, undefined]);

    expect(tx.receivableItem.groupBy).not.toHaveBeenCalled();
    expect(tx.stockSyncJob.upsert).not.toHaveBeenCalled();
    expect(r.enqueued).toBe(0);
  });
});

describe("firePostReservationEffects", () => {
  it("não agenda nada quando não houve o que enfileirar", () => {
    vi.useFakeTimers();
    firePostReservationEffects({ changed: [], reopened: [], enqueued: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tolera retorno ausente — o caminho da flag desligada", () => {
    vi.useFakeTimers();
    expect(() => firePostReservationEffects(null)).not.toThrow();
    expect(() => firePostReservationEffects(undefined)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("agenda ADIADO, e não imediato: o job nasce com nextRunAt no futuro", () => {
    // `setImmediate` não serviria: a query do retry filtra `nextRunAt <= now`
    // (stock-sync-retry.service.ts:124-131), então um disparo imediato não veria
    // o próprio job recém-criado e a peça só sairia do disponível no tick de
    // 30s do serviço.
    vi.useFakeTimers();
    firePostReservationEffects({
      changed: [{ productId: "p-1", before: 1, after: 0 }],
      reopened: [],
      enqueued: 1,
    });
    expect(vi.getTimerCount()).toBe(1);
  });
});

// ── O BECO SEM SAÍDA DA VENDA PARCELADA PENDENTE ────────────────────────────
//
// Descoberto durante o diagnóstico: uma venda parcelada que NUNCA foi recebida
// não tinha caminho nenhum. O `delete` a recusava por ter parcelas filhas e o
// `reverse` a recusava por não estar PAGA. Sem reserva era um incômodo; com a
// reserva ligada a peça fica comprometida PARA SEMPRE.
//
// Aqui testo a decisão pura: quando é seguro apagar tudo.
describe("Venda parcelada PENDENTE — quando destravar é seguro", () => {
  /** Espelha o predicado do `delete` (finance.usecase.ts). */
  function podeApagarTudo(
    flagOn: boolean,
    statusMae: string,
    statusFilhas: string[],
  ): boolean {
    return (
      flagOn && statusMae !== "PAGA" && !statusFilhas.some((s) => s === "PAGA")
    );
  }

  it("nada pago ⇒ pode apagar: nenhum estoque saiu, nenhum dinheiro entrou", () => {
    expect(podeApagarTudo(true, "PENDENTE", ["PENDENTE", "PENDENTE"])).toBe(
      true,
    );
    expect(podeApagarTudo(true, "VENCIDA", ["VENCIDA", "PENDENTE"])).toBe(true);
  });

  it("QUALQUER parcela paga ⇒ continua bloqueado: dinheiro entrou", () => {
    expect(podeApagarTudo(true, "PENDENTE", ["PAGA", "PENDENTE"])).toBe(false);
    expect(podeApagarTudo(true, "PENDENTE", ["PENDENTE", "PAGA"])).toBe(false);
  });

  it("mãe PAGA ⇒ continua bloqueado: o estoque JÁ baixou, o caminho é estornar", () => {
    expect(podeApagarTudo(true, "PAGA", ["PENDENTE"])).toBe(false);
  });

  it("flag OFF ⇒ recusa como sempre recusou", () => {
    expect(podeApagarTudo(false, "PENDENTE", ["PENDENTE"])).toBe(false);
  });
});
