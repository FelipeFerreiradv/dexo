import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────
// BLOCO T-A — publicação de anúncio OLX/Facebook pelos PONTOS DE ENTRADA.
//
// Os dois pontos de entrada de criação são:
//   ListingDispatcher.dispatch      (fluxo single, fire-and-forget)
//   ListingDispatcher.dispatchBatch (lote, N produtos × M contas)
//
// O que se prova aqui é o ROTEAMENTO por plataforma — a camada mais barata de
// quebrar e a mais cara quando quebra: um `if` trocado manda o produto para a
// API errada, com o token errado, e o anúncio nasce na conta de outro
// marketplace. Foi bug real neste repo. Por isso cada caso afirma não só
// "chamou a certa" como "NÃO chamou as outras".
//
// Nenhuma flag de integração precisa ser mexida: o gate de OLX/Facebook mora
// DENTRO de createOlxListing/createFacebookListing, que aqui são mockados —
// o dispatcher em si não lê `*_INTEGRATION_DISABLED`.
// ──────────────────────────────────────────────────────────

import { ListingDispatcher } from "@/app/marketplaces/services/listing-dispatcher.service";
import { ListingUseCase } from "@/app/marketplaces/usecases/listing.usercase";
import { SystemLogService } from "@/app/services/system-log.service";
import type { BulkListingItemResult } from "@/app/marketplaces/repositories/bulk-listing-job.repository";

const USER_ID = "user-1";
const PRODUCT_ID = "prod-1";

/**
 * `dispatch` é fire-and-forget (retorna o snapshot sincronamente e deixa os
 * `void this.runOne()` na fila de microtasks). Sem drenar a fila, qualquer
 * assert passaria "de graça" antes do create acontecer.
 */
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Mocka os CINCO creates de uma vez e devolve os spies nomeados. */
function mockTodosOsCreates() {
  return {
    ml: vi
      .spyOn(ListingUseCase, "createMLListing")
      .mockResolvedValue({ success: true, listingId: "L-ml" } as any),
    shopee: vi
      .spyOn(ListingUseCase, "createShopeeListing")
      .mockResolvedValue({ success: true, listingId: "L-shp" } as any),
    magalu: vi
      .spyOn(ListingUseCase, "createMagaluListing")
      .mockResolvedValue({ success: true, listingId: "L-mgl" } as any),
    olx: vi
      .spyOn(ListingUseCase, "createOlxListing")
      .mockResolvedValue({ success: true, listingId: "L-olx" } as any),
    facebook: vi
      .spyOn(ListingUseCase, "createFacebookListing")
      .mockResolvedValue({ success: true, listingId: "L-fb" } as any),
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Produtividade grava via prisma real; sem este mock, todo caso com actorId
  // tentaria abrir conexão em localhost:5432.
  vi.spyOn(SystemLogService, "logListingCreate").mockResolvedValue(
    undefined as any,
  );
  // Guarda de rede: nenhum caso deste arquivo deve encostar em updateListingFields
  // (só é chamado quando há overrideTemplate, e nenhum caso aqui usa um).
  vi.spyOn(ListingUseCase, "updateListingFields").mockResolvedValue({
    success: true,
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ListingDispatcher.dispatch — roteamento por plataforma (OLX/Facebook)", () => {
  it("FACEBOOK: chama createFacebookListing com (userId, productId, categoryId, accountId, actorId) NESSA ordem e não toca as outras APIs", async () => {
    const creates = mockTodosOsCreates();

    ListingDispatcher.dispatch({
      userId: USER_ID,
      productId: PRODUCT_ID,
      requests: [
        { platform: "FACEBOOK", accountId: "acc-fb", categoryId: "cat-fb-99" },
      ],
      actorId: "colab-7",
    });
    await flush();

    // Assinatura POSICIONAL: categoryId e accountId são ambos `string?` e
    // adjacentes — invertê-los compila e só quebra em produção (o Facebook
    // receberia o id da conta como categoria). Por isso o assert é sobre a
    // lista inteira de argumentos, não sobre "foi chamado".
    expect(creates.facebook).toHaveBeenCalledTimes(1);
    expect(creates.facebook).toHaveBeenCalledWith(
      USER_ID,
      PRODUCT_ID,
      "cat-fb-99",
      "acc-fb",
      "colab-7",
    );

    // Vazamento de plataforma: nenhum outro create pode disparar. Este é o
    // assert que pega o `if` errado / o fall-through entre ramos.
    expect(creates.olx).not.toHaveBeenCalled();
    expect(creates.ml).not.toHaveBeenCalled();
    expect(creates.shopee).not.toHaveBeenCalled();
    expect(creates.magalu).not.toHaveBeenCalled();
  });

  it("OLX: espelho exato do caso do Facebook", async () => {
    const creates = mockTodosOsCreates();

    ListingDispatcher.dispatch({
      userId: USER_ID,
      productId: PRODUCT_ID,
      requests: [
        { platform: "OLX", accountId: "acc-olx", categoryId: "2101" },
      ],
      actorId: "colab-7",
    });
    await flush();

    expect(creates.olx).toHaveBeenCalledTimes(1);
    expect(creates.olx).toHaveBeenCalledWith(
      USER_ID,
      PRODUCT_ID,
      "2101",
      "acc-olx",
      "colab-7",
    );

    expect(creates.facebook).not.toHaveBeenCalled();
    expect(creates.ml).not.toHaveBeenCalled();
    expect(creates.shopee).not.toHaveBeenCalled();
    expect(creates.magalu).not.toHaveBeenCalled();
  });

  it("um dispatch com OLX + Facebook + ML dispara exatamente um create de cada", async () => {
    const creates = mockTodosOsCreates();

    ListingDispatcher.dispatch({
      userId: USER_ID,
      productId: PRODUCT_ID,
      requests: [
        { platform: "OLX", accountId: "acc-olx" },
        { platform: "FACEBOOK", accountId: "acc-fb" },
        { platform: "MERCADO_LIVRE", accountId: "acc-ml", categoryId: "MLB1" },
      ],
    });
    await flush();

    // Cada request vira UMA criação — nem duplicada (um ramo caindo no
    // seguinte) nem engolida.
    expect(creates.olx).toHaveBeenCalledTimes(1);
    expect(creates.facebook).toHaveBeenCalledTimes(1);
    expect(creates.ml).toHaveBeenCalledTimes(1);
    // A conta do ML não pode ser reutilizada pelos ramos novos.
    expect(creates.olx.mock.calls[0][3]).toBe("acc-olx");
    expect(creates.facebook.mock.calls[0][3]).toBe("acc-fb");
  });
});

describe("ListingDispatcher.dispatchBatch — isolamento de falha entre itens", () => {
  it("a exceção de UM item não aborta os demais do lote", async () => {
    mockTodosOsCreates();
    // A OLX estoura de verdade (rede). Sem o try/catch por item dentro de
    // runOneWithResult, a rejeição subiria pelo worker e derrubaria o
    // Promise.all — o lote inteiro morreria por causa de um anúncio.
    vi.spyOn(ListingUseCase, "createOlxListing").mockRejectedValue(
      new Error("connect ETIMEDOUT api.olx.com.br"),
    );

    const itens: BulkListingItemResult[] = [];
    const res = await ListingDispatcher.dispatchBatch({
      userId: USER_ID,
      productIds: [PRODUCT_ID],
      requests: [
        { platform: "OLX", accountId: "acc-olx" },
        { platform: "FACEBOOK", accountId: "acc-fb" },
        { platform: "MERCADO_LIVRE", accountId: "acc-ml" },
      ],
      onItemDone: (item) => {
        itens.push(item);
      },
    });

    // Contabilidade do lote: 1 falha, 2 sucessos — e o callback recebeu os TRÊS.
    expect(res.failed).toBe(1);
    expect(res.success).toBe(2);
    expect(itens).toHaveLength(3);

    const olx = itens.find((i) => i.platform === "OLX");
    const fb = itens.find((i) => i.platform === "FACEBOOK");
    const ml = itens.find((i) => i.platform === "MERCADO_LIVRE");

    // O erro é reportado no item (não silenciado) e a mensagem original chega
    // ao usuário — é o que distingue "tratou" de "engoliu".
    expect(olx?.success).toBe(false);
    expect(olx?.error).toContain("ETIMEDOUT");
    expect(res.lastError).toContain("ETIMEDOUT");

    // E os vizinhos foram até o fim, com o listingId do próprio create.
    expect(fb?.success).toBe(true);
    expect(fb?.listingId).toBe("L-fb");
    expect(ml?.success).toBe(true);
    expect(ml?.listingId).toBe("L-ml");
  });

  it("a falha de NEGÓCIO (success:false, sem throw) também não contamina os vizinhos", async () => {
    mockTodosOsCreates();
    vi.spyOn(ListingUseCase, "createFacebookListing").mockResolvedValue({
      success: false,
      error: "Catálogo do Facebook não configurado para esta conta",
    } as any);

    const itens: BulkListingItemResult[] = [];
    const res = await ListingDispatcher.dispatchBatch({
      userId: USER_ID,
      productIds: [PRODUCT_ID],
      requests: [
        { platform: "FACEBOOK", accountId: "acc-fb" },
        { platform: "OLX", accountId: "acc-olx" },
      ],
      onItemDone: (item) => {
        itens.push(item);
      },
    });

    expect(res.success).toBe(1);
    expect(res.failed).toBe(1);
    expect(itens.find((i) => i.platform === "FACEBOOK")?.error).toContain(
      "Catálogo do Facebook",
    );
    expect(itens.find((i) => i.platform === "OLX")?.success).toBe(true);
  });
});

describe('ListingDispatcher — o actorId chega ao create e ao "Criado por"', () => {
  it("batch OLX/Facebook: actorId é repassado ao create E vira o autor do CREATE_LISTING", async () => {
    const creates = mockTodosOsCreates();
    const logSpy = vi
      .spyOn(SystemLogService, "logListingCreate")
      .mockResolvedValue(undefined as any);

    await ListingDispatcher.dispatchBatch({
      userId: USER_ID,
      productIds: [PRODUCT_ID],
      requests: [
        { platform: "OLX", accountId: "acc-olx", categoryId: "2101" },
        { platform: "FACEBOOK", accountId: "acc-fb", categoryId: "cat-fb" },
      ],
      onItemDone: () => {},
      actorId: "colab-9",
    });

    // 5º argumento = actorId. Se o batch parasse de repassá-lo, o anúncio
    // continuaria sendo criado — só que o "Criado por" ficaria com o DONO da
    // conta em vez do colaborador que apertou o botão. Falha silenciosa.
    expect(creates.olx.mock.calls[0][4]).toBe("colab-9");
    expect(creates.facebook.mock.calls[0][4]).toBe("colab-9");

    // O log de produtividade é atribuído ao ATOR (1º arg), não ao userId do
    // tenant, e traz o rótulo humano de cada marketplace.
    expect(logSpy).toHaveBeenCalledWith(
      "colab-9",
      "L-olx",
      PRODUCT_ID,
      "OLX",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "colab-9",
      "L-fb",
      PRODUCT_ID,
      "Facebook",
    );
  });

  it("sem actorId (fluxo de sistema) o anúncio é criado, mas NENHUM autor é fabricado", async () => {
    const creates = mockTodosOsCreates();
    const logSpy = vi
      .spyOn(SystemLogService, "logListingCreate")
      .mockResolvedValue(undefined as any);

    await ListingDispatcher.dispatchBatch({
      userId: USER_ID,
      productIds: [PRODUCT_ID],
      requests: [{ platform: "FACEBOOK", accountId: "acc-fb" }],
      onItemDone: () => {},
    });

    expect(creates.facebook).toHaveBeenCalledTimes(1);
    expect(creates.facebook.mock.calls[0][4]).toBeUndefined();
    // Guarda `if (!actorId) return` em logCreatedListing: sem ator humano não
    // se inventa atribuição de produtividade.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("dispatch single do Facebook também atribui o CREATE_LISTING ao ator", async () => {
    mockTodosOsCreates();
    const logSpy = vi
      .spyOn(SystemLogService, "logListingCreate")
      .mockResolvedValue(undefined as any);

    ListingDispatcher.dispatch({
      userId: USER_ID,
      productId: PRODUCT_ID,
      requests: [{ platform: "FACEBOOK", accountId: "acc-fb" }],
      actorId: "colab-3",
    });
    await flush();

    expect(logSpy).toHaveBeenCalledWith(
      "colab-3",
      "L-fb",
      PRODUCT_ID,
      "Facebook",
    );
  });

  it("create que falha NÃO gera CREATE_LISTING (produtividade não conta anúncio que não existe)", async () => {
    mockTodosOsCreates();
    vi.spyOn(ListingUseCase, "createOlxListing").mockResolvedValue({
      success: false,
      error: "REFUSED_SUSPECT_PRICE",
    } as any);
    const logSpy = vi
      .spyOn(SystemLogService, "logListingCreate")
      .mockResolvedValue(undefined as any);

    ListingDispatcher.dispatch({
      userId: USER_ID,
      productId: PRODUCT_ID,
      requests: [{ platform: "OLX", accountId: "acc-olx" }],
      actorId: "colab-3",
    });
    await flush();

    expect(logSpy).not.toHaveBeenCalled();
  });
});
