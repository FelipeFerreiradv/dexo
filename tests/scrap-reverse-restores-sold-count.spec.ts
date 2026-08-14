// Fase 1.2 — CORREÇÃO 1: cancelar a venda tem de devolver a contagem de peças
// vendidas da sucata.
//
// Relato do cliente: "sucata possui 20 peças vendidas; uma venda contendo 2
// peças é cancelada; a sucata deve voltar a contabilizar 18".
//
// A CAUSA não era o estorno — `reverse` devolve o estoque corretamente. Era a
// PEÇA AVULSA: ela vira produto de catálogo no recebimento e herda a sucata
// (finance.usecase.ts:741), e no estorno a compensação simétrica a devolve ao
// catálogo com estoque 0. Como `getScrapParts` deriva o rótulo de ESTOQUE
// (`stock > 0 ? IN_STOCK : SOLD`), ela seguia "Vendida" para sempre — e é esse
// rótulo que alimenta os três contadores da tela (ImpalaProgress, tab
// "Vendidas" e badge por linha).
//
// Venda de peça CADASTRADA sempre reverteu certo; o bug era só na avulsa.

import { describe, it, expect, beforeEach, vi } from "vitest";

function makePrisma() {
  return {
    product: { findMany: vi.fn().mockResolvedValue([]) },
    orderItem: { groupBy: vi.fn().mockResolvedValue([]) },
    receivableItem: { groupBy: vi.fn().mockResolvedValue([]) },
    scrap: { findFirst: vi.fn().mockResolvedValue(null) },
  } as any;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import { ScrapRepositoryPrisma } from "../app/repositories/scrap.repository";
import { computeScrapPaint } from "../app/sucatas/lib/car-regions";

const prismaMock = prismaDefault as any;
const SCRAP = "scrap-1";
const USER = "user-owner";

function produto(over: Partial<any> = {}) {
  return {
    id: "p-x",
    name: "Peça",
    sku: "SKU-X",
    partNumber: null,
    price: "100.00",
    stock: 0,
    quality: null,
    isSecurityItem: false,
    isTraceable: false,
    autoCreatedFromSale: false,
    ...over,
  };
}

/** 18 peças cadastradas vendidas (estoque 0) + 2 avulsas de UMA venda. */
function catalogo20() {
  const cadastradas = Array.from({ length: 18 }, (_, i) =>
    produto({ id: `cad-${i}`, sku: `SKU-${i}`, stock: 0 }),
  );
  const avulsas = [
    produto({ id: "avulsa-1", sku: "AV-1", autoCreatedFromSale: true }),
    produto({ id: "avulsa-2", sku: "AV-2", autoCreatedFromSale: true }),
  ];
  return [...cadastradas, ...avulsas];
}

/** Vendas de balcão PAGA por produto (o que `soldQuantity` enxerga). */
function vendasPagas(ids: string[]) {
  return ids.map((productId) => ({ productId, _sum: { quantity: 1 } }));
}

describe("Fase 1.2 — cenário 20 → 18 do cliente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.orderItem.groupBy.mockResolvedValue([]);
  });

  it("com a venda PAGA, as 2 avulsas contam: 20 peças vendidas", async () => {
    prismaMock.product.findMany.mockResolvedValue(catalogo20());
    prismaMock.receivableItem.groupBy.mockResolvedValue(
      vendasPagas([
        ...Array.from({ length: 18 }, (_, i) => `cad-${i}`),
        "avulsa-1",
        "avulsa-2",
      ]),
    );

    const parts = await new ScrapRepositoryPrisma().getScrapParts(SCRAP, USER);
    const vendidas = parts.filter((p) => p.status === "SOLD");

    expect(parts).toHaveLength(20);
    expect(vendidas).toHaveLength(20);
    // O mesmo número que o ImpalaProgress imprime na tela.
    expect(computeScrapPaint(parts as any).soldCount).toBe(20);
  });

  it("CANCELADA a venda das 2 avulsas, a sucata volta a 18", async () => {
    // O estorno devolveu +qty e a compensação simétrica tirou −qty: as avulsas
    // seguem no catálogo com estoque 0. O que MUDA é `soldQuantity`, porque o
    // groupBy filtra `receivable.status = PAGA` e a venda saiu.
    prismaMock.product.findMany.mockResolvedValue(catalogo20());
    prismaMock.receivableItem.groupBy.mockResolvedValue(
      vendasPagas(Array.from({ length: 18 }, (_, i) => `cad-${i}`)),
    );

    const parts = await new ScrapRepositoryPrisma().getScrapParts(SCRAP, USER);
    const vendidas = parts.filter((p) => p.status === "SOLD");

    expect(vendidas).toHaveLength(18);
    expect(computeScrapPaint(parts as any).soldCount).toBe(18);
    // A peça órfã sai da tabela inteira — não vira "Em estoque" mentindo que
    // há uma peça disponível que não existe.
    expect(parts.map((p) => p.id)).not.toContain("avulsa-1");
    expect(parts).toHaveLength(18);
  });
});

describe("Fase 1.2 — o filtro é estreito (sem regressão)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.orderItem.groupBy.mockResolvedValue([]);
    prismaMock.receivableItem.groupBy.mockResolvedValue([]);
  });

  it("peça CADASTRADA com estoque 0 e sem venda continua listada como hoje", async () => {
    // Pode ter zerado por ajuste, perda ou importação. Não é escopo desta
    // correção e o comportamento tem de ficar idêntico.
    prismaMock.product.findMany.mockResolvedValue([
      produto({ id: "cad-1", stock: 0, autoCreatedFromSale: false }),
    ]);

    const parts = await new ScrapRepositoryPrisma().getScrapParts(SCRAP, USER);

    expect(parts).toHaveLength(1);
    expect(parts[0].status).toBe("SOLD");
  });

  it("peça avulsa de venda AINDA PAGA continua contando (intenção do Bloco F)", async () => {
    prismaMock.product.findMany.mockResolvedValue([
      produto({ id: "avulsa-1", stock: 0, autoCreatedFromSale: true }),
    ]);
    prismaMock.receivableItem.groupBy.mockResolvedValue(
      vendasPagas(["avulsa-1"]),
    );

    const parts = await new ScrapRepositoryPrisma().getScrapParts(SCRAP, USER);

    expect(parts).toHaveLength(1);
    expect(parts[0].status).toBe("SOLD");
    expect(parts[0].soldQuantity).toBe(1);
  });

  it("avulsa vendida no MARKETPLACE também sustenta a peça", async () => {
    // `soldQuantity` soma os dois canais — olhar só o balcão esconderia metade.
    prismaMock.product.findMany.mockResolvedValue([
      produto({ id: "avulsa-1", stock: 0, autoCreatedFromSale: true }),
    ]);
    prismaMock.orderItem.groupBy.mockResolvedValue(vendasPagas(["avulsa-1"]));

    const parts = await new ScrapRepositoryPrisma().getScrapParts(SCRAP, USER);
    expect(parts).toHaveLength(1);
  });

  it("peça avulsa REPOSTA (estoque > 0) NÃO é descartada", async () => {
    // Se alguém repôs a peça no catálogo, ela virou peça de verdade com
    // inventário físico. Escondê-la esconderia estoque que existe — por isso o
    // filtro exige `stock === 0` além de não ter venda viva.
    prismaMock.product.findMany.mockResolvedValue([
      produto({ id: "avulsa-1", stock: 3, autoCreatedFromSale: true }),
    ]);

    const parts = await new ScrapRepositoryPrisma().getScrapParts(SCRAP, USER);

    expect(parts).toHaveLength(1);
    expect(parts[0].status).toBe("IN_STOCK");
  });
});

describe("Fase 1.2 — o contador da listagem conta as mesmas peças", () => {
  // ESCOPO DESTE TESTE: ele prova que a consulta SAI com o filtro — não que o
  // Postgres devolve o número certo (isso exigiria banco). O valor é travar o
  // filtro contra uma remoção acidental que voltaria a divergir da tabela.
  it("o _count de produtos exclui a peça avulsa órfã", async () => {
    prismaMock.scrap.findFirst.mockResolvedValue(null);
    await new ScrapRepositoryPrisma().findById(SCRAP, USER);

    const arg = prismaMock.scrap.findFirst.mock.calls[0][0];
    const where = arg.include._count.select.products.where;

    // As TRÊS condições do descarte, na mesma semântica de getScrapParts.
    expect(where.NOT.autoCreatedFromSale).toBe(true);
    expect(where.NOT.stock).toBe(0);
    expect(where.NOT.receivableItems).toEqual({
      none: { receivable: { status: "PAGA" } },
    });
    expect(where.NOT.orderItems).toEqual({
      none: { order: { status: { in: ["PAID", "SHIPPED", "DELIVERED"] } } },
    });
  });
});
