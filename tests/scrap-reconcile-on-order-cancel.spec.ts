// Bug G — cancelar pedido de marketplace deixava o lote "Esgotado" para sempre.
//
// `ScrapStatusReconcileService` só tinha entrada pela conta a receber
// (`reconcileForReceivable`), e os dois únicos chamadores em todo o repositório
// eram `markPaid` e `reverse` do balcão. O cancelamento de pedido restaurava o
// estoque e reabria o anúncio, mas `Scrap.status` — que é coluna PERSISTIDA —
// ficava com o valor antigo.
//
// O sintoma é uma contradição na tela: o rótulo POR PEÇA se autocura (é
// derivado de estoque em tempo real) e volta a "Em estoque", enquanto o lote
// continua com o badge "Esgotada".
//
// A query de fatos do serviço sempre soube ler os DOIS canais (OrderItem de
// pedido PAID/SHIPPED/DELIVERED + ReceivableItem de conta PAGA) — só faltava
// alguém disparar pelo lado do marketplace.

import { describe, it, expect, vi, beforeEach } from "vitest";

const reconcileScrapCalls: Array<[string, string]> = [];

function makePrisma() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(async (cb: any) => cb({})),
    scrap: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } as any;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import { ScrapStatusReconcileService } from "../app/marketplaces/services/scrap-status-reconcile.service";

const prisma = prismaDefault as any;
const USER = "u-1";

/** `reconcileForProducts` agenda em setImmediate — deixa o event loop girar. */
const drain = () => new Promise((r) => setImmediate(r));

describe("Bug G — reconciliação por PRODUTOS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reconcileScrapCalls.length = 0;
    prisma.$queryRaw.mockResolvedValue([]);
  });

  it("resolve as sucatas DISTINTAS dos produtos e fecha o escopo de tenant", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ scrapId: "s-1" }]);

    ScrapStatusReconcileService.reconcileForProducts({
      productIds: ["p-1", "p-2"],
      userId: USER,
    });
    await drain();

    expect(prisma.$queryRaw).toHaveBeenCalled();
    const sql = String(prisma.$queryRaw.mock.calls[0][0]?.strings?.join("?"));
    // Sem o JOIN em Scrap.userId, um produto de outro tenant apontando para
    // esta sucata arrastaria a reconciliação para fora do dono.
    expect(sql).toContain('JOIN "Scrap"');
    expect(sql).toContain('s."userId"');
    expect(sql).toContain("DISTINCT");
  });

  it("lista vazia é no-op — não abre consulta nenhuma", async () => {
    ScrapStatusReconcileService.reconcileForProducts({
      productIds: [],
      userId: USER,
    });
    await drain();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("deduplica ids repetidos antes de consultar", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    ScrapStatusReconcileService.reconcileForProducts({
      productIds: ["p-1", "p-1", "p-1"],
      userId: USER,
    });
    await drain();

    // Um pedido pode repetir o mesmo produto em linhas diferentes; consultar
    // três vezes o mesmo id seria desperdício puro.
    const sql = String(prisma.$queryRaw.mock.calls[0][0]?.strings?.join("?"));
    const params = prisma.$queryRaw.mock.calls[0][0]?.values ?? [];
    expect(sql).toContain('p."id" IN');
    expect(params.filter((v: unknown) => v === "p-1")).toHaveLength(1);
  });

  it("é best-effort: falha na consulta NÃO estoura no chamador", async () => {
    // O chamador é pós-commit de um cancelamento que já persistiu. Estourar
    // aqui não desfaria nada e ainda derrubaria o fluxo do pedido.
    prisma.$queryRaw.mockRejectedValueOnce(new Error("db down"));

    expect(() =>
      ScrapStatusReconcileService.reconcileForProducts({
        productIds: ["p-1"],
        userId: USER,
      }),
    ).not.toThrow();
    await drain();
    await drain();
  });

  it("não bloqueia o chamador (retorna antes de consultar)", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    ScrapStatusReconcileService.reconcileForProducts({
      productIds: ["p-1"],
      userId: USER,
    });
    // Ainda no mesmo tick: o setImmediate não rodou.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();

    await drain();
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });
});
