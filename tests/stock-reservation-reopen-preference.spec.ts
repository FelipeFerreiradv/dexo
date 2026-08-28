import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// O SEGUNDO MOTOR DE REABERTURA — liberação de reserva.
//
// `firePostReservationEffects` nasceu em 25/08 (a propagação da reserva) e
// reabria anúncio chamando `pauseListings(..., "active")` sem nunca perguntar
// pela preferência `User.reopenListingsOnSaleCancel`, que existia desde 17/08.
// Para o lojista, excluir uma venda pendente É cancelar a venda: a peça volta
// ao disponível e o anúncio voltava ao ar, contrariando a tela.
//
// Não é hipótese: em 28/08 o ÚNICO tenant com reserva ativa em toda a produção
// era justamente um dos três que desligaram a preferência — 8 produtos com
// disponível zerado, 6 anúncios ML pausados e 49 vendas pendentes esperando.
//
// Dois pontos delicados, e cada um tem caso próprio aqui:
//  · a preferência é do TENANT, e `Product.userId` aponta para um COLABORADOR
//    em 1.009 produtos de produção. Ler a linha do colaborador daria a resposta
//    errada;
//  · com a preferência OFF não basta NÃO reabrir: o `runOnce()` logo acima já
//    empurrou o disponível, e é esse empurrão que traz o anúncio de volta. Tem
//    de pausar.
// ──────────────────────────────────────────────────────────

const runOnceMock = vi.fn();
vi.mock("../app/marketplaces/services/stock-sync-retry.service", () => ({
  StockSyncRetryService: { runOnce: runOnceMock },
}));

const pauseListingsMock = vi.fn();
vi.mock("@/app/usecases/product.usercase", () => ({
  ProductUseCase: class {
    pauseListings = pauseListingsMock;
  },
}));

// ⚠️ O factory do prisma NÃO pode fechar sobre uma variável do módulo, ao
// contrário dos dois acima: `vi.mock` é içado, e o prisma é importado de forma
// ESTÁTICA pelo serviço — o factory roda antes de qualquer `const` do arquivo
// existir ("Cannot access before initialization"). Os outros dois escapam só
// porque a cadeia os importa dinamicamente, em tempo de execução.
//
// Os dois specifiers estão registrados porque o vitest casa o mock por TEXTO,
// e a cadeia usa ambos (`../../lib/prisma` no serviço, `@/app/lib/prisma`
// alhures).
vi.mock("../app/lib/prisma", () => ({
  default: { user: { findMany: vi.fn() } },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: { user: { findMany: vi.fn() } },
}));

import prismaMock from "@/app/lib/prisma";
import { firePostReservationEffects } from "../app/marketplaces/services/stock-reservation.service";
import { PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE } from "../app/marketplaces/services/stock-deduction.service";
import { Platform } from "@prisma/client";

const findManyMock = (prismaMock as any).user.findMany as ReturnType<
  typeof vi.fn
>;

/**
 * O timer da propagação é ADIADO (5,5 s) de propósito — ver o comentário da
 * função. Adianta o relógio e depois drena as microtasks/imports dinâmicos.
 */
async function dispararEDrenar() {
  await vi.advanceTimersByTimeAsync(6_000);
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

const propagacao = (reopened: Array<{ productId: string; userId: string }>) => ({
  changed: reopened.map((r) => ({ productId: r.productId, before: 0, after: 1 })),
  reopened,
  enqueued: reopened.length,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  runOnceMock.mockResolvedValue(undefined);
  pauseListingsMock.mockResolvedValue({
    success: true,
    message: "ok",
    listingResults: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("firePostReservationEffects — preferência do tenant", () => {
  it("LIGADA: reabre com 3 args, byte-idêntico ao comportamento de antes", async () => {
    findManyMock.mockResolvedValue([
      { id: "u-1", reopenListingsOnSaleCancel: true, parent: null },
    ]);

    firePostReservationEffects(propagacao([{ productId: "p-1", userId: "u-1" }]));
    await dispararEDrenar();

    expect(pauseListingsMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "active");
  });

  it("DESLIGADA: não reabre — e ainda PAUSA, porque o estoque já foi empurrado", async () => {
    findManyMock.mockResolvedValue([
      { id: "u-1", reopenListingsOnSaleCancel: false, parent: null },
    ]);

    firePostReservationEffects(propagacao([{ productId: "p-1", userId: "u-1" }]));
    await dispararEDrenar();

    expect(pauseListingsMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "paused", {
      forceRemote: true,
      platforms: PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE,
    });
  });

  it("⚠️ a liberação de reserva NUNCA despublica Shopee nem Magalu", async () => {
    // A propagação da reserva também só empurra QUANTIDADE: nesses dois canais
    // o anúncio nunca saiu do ar, e despublicá-lo aqui seria irreversível por
    // rotina automática.
    findManyMock.mockResolvedValue([
      { id: "u-1", reopenListingsOnSaleCancel: false, parent: null },
    ]);
    firePostReservationEffects(propagacao([{ productId: "p-1", userId: "u-1" }]));
    await dispararEDrenar();

    const opts = pauseListingsMock.mock.calls[0][3];
    expect(opts.platforms).not.toContain(Platform.SHOPEE);
    expect(opts.platforms).not.toContain(Platform.MAGALU);
  });

  it("o empurrão de estoque acontece nos dois casos", async () => {
    findManyMock.mockResolvedValue([
      { id: "u-1", reopenListingsOnSaleCancel: false, parent: null },
    ]);
    firePostReservationEffects(propagacao([{ productId: "p-1", userId: "u-1" }]));
    await dispararEDrenar();
    expect(runOnceMock).toHaveBeenCalledTimes(1);
  });

  it("COLABORADOR: manda a preferência do admin PAI, não a da linha do produto", async () => {
    // `Product.userId` é do colaborador; a linha dele diz `true` e o pai diz
    // `false`. Quem governa é o tenant.
    findManyMock.mockResolvedValue([
      {
        id: "colab-1",
        reopenListingsOnSaleCancel: true,
        parent: { reopenListingsOnSaleCancel: false },
      },
    ]);

    firePostReservationEffects(
      propagacao([{ productId: "p-1", userId: "colab-1" }]),
    );
    await dispararEDrenar();

    expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "colab-1", "paused", {
      forceRemote: true,
      platforms: PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE,
    });
  });

  it("ISOLAMENTO: dois tenants na mesma rodada, decisões independentes", async () => {
    findManyMock.mockResolvedValue([
      { id: "tenant-A", reopenListingsOnSaleCancel: false, parent: null },
      { id: "tenant-B", reopenListingsOnSaleCancel: true, parent: null },
    ]);

    firePostReservationEffects(
      propagacao([
        { productId: "p-a", userId: "tenant-A" },
        { productId: "p-b", userId: "tenant-B" },
      ]),
    );
    await dispararEDrenar();

    expect(pauseListingsMock).toHaveBeenCalledWith("p-a", "tenant-A", "paused", {
      forceRemote: true,
      platforms: PLATAFORMAS_QUE_SAEM_DO_AR_POR_ESTOQUE,
    });
    expect(pauseListingsMock).toHaveBeenCalledWith("p-b", "tenant-B", "active");
  });

  it("uma consulta só, por mais produtos que existam", async () => {
    findManyMock.mockResolvedValue([
      { id: "u-1", reopenListingsOnSaleCancel: true, parent: null },
    ]);
    firePostReservationEffects(
      propagacao([
        { productId: "p-1", userId: "u-1" },
        { productId: "p-2", userId: "u-1" },
        { productId: "p-3", userId: "u-1" },
      ]),
    );
    await dispararEDrenar();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(pauseListingsMock).toHaveBeenCalledTimes(3);
  });

  describe("FAIL-OPEN — a dúvida reabre, nunca esconde o anúncio em silêncio", () => {
    it("usuário ausente do resultado ⇒ reabre", async () => {
      findManyMock.mockResolvedValue([]);
      firePostReservationEffects(
        propagacao([{ productId: "p-1", userId: "u-1" }]),
      );
      await dispararEDrenar();
      expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "active");
    });

    it("coluna null (linha anterior ao DDL) ⇒ reabre", async () => {
      findManyMock.mockResolvedValue([
        { id: "u-1", reopenListingsOnSaleCancel: null, parent: null },
      ]);
      firePostReservationEffects(
        propagacao([{ productId: "p-1", userId: "u-1" }]),
      );
      await dispararEDrenar();
      expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "active");
    });

    it("consulta explodindo ⇒ reabre, e nada é lançado", async () => {
      findManyMock.mockRejectedValue(new Error("pool esgotado"));
      expect(() =>
        firePostReservationEffects(
          propagacao([{ productId: "p-1", userId: "u-1" }]),
        ),
      ).not.toThrow();
      await dispararEDrenar();
      expect(pauseListingsMock).toHaveBeenCalledWith("p-1", "u-1", "active");
    });
  });

  it("sem nada a reabrir, a preferência nem é consultada", async () => {
    firePostReservationEffects({
      changed: [{ productId: "p-1", before: 1, after: 0 }],
      reopened: [],
      enqueued: 1,
    });
    await dispararEDrenar();

    expect(runOnceMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(pauseListingsMock).not.toHaveBeenCalled();
  });
});
