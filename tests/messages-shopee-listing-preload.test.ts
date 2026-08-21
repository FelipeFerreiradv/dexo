import { describe, it, expect, vi, afterEach } from "vitest";

import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MessagesUseCase } from "@/app/marketplaces/usecases/messages.usecase";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import prisma from "@/app/lib/prisma";

/**
 * Pré-carga em LOTE dos anúncios na varredura shop-wide da Shopee.
 *
 * O problema: `syncShopeeCommentsForAccount` chamava `upsertFromShopeeComment`
 * sem o terceiro argumento, então cada comentário resolvia o próprio anúncio
 * dentro do upsert — 3.553 consultas por passada de catálogo somando as 23
 * contas Shopee (log do `dexo-sync-orders`, 21/08/2026); 205.752 chamadas
 * acumuladas na janela do `pg_stat_statements` (28,6 dias).
 *
 * O que fica travado aqui, e por quê:
 *   1. o `where` do lote carrega `marketplaceAccountId` — no `findUnique` do
 *      singular o isolamento é ESTRUTURAL (chave composta), no `findMany` vira
 *      campo opcional e há colisão real de externalItemId entre contas;
 *   2. `null` (consultei, não achei) e `undefined` (não consultei) são coisas
 *      DIFERENTES — confundir os dois grava null por cima de vínculo bom, e
 *      como `productListingId` está em CAMPOS_REESCRITOS_NA_PERGUNTA, a guarda
 *      de novidade forçaria o update em até 100 linhas por página;
 *   3. falha do lote cai no caminho por item, e a função continua sem rejeitar;
 *   4. a chave do Map e a chave que o upsert grava saem da MESMA expressão.
 */

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

const CONTA = {
  id: "acc-1",
  shopId: 123,
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: FUTURE,
};

// ===========================================================================
// chaveDeItemShopee — a expressão única
// ===========================================================================
describe("QuestionRepository.chaveDeItemShopee", () => {
  it("valor presente: é EXATAMENTE String(itemId)", () => {
    // Este é o teste estrutural: se alguém acrescentar trim/Number/parseInt na
    // chave, ela deixa de casar com o `String(comment.item_id)` que o
    // upsertFromShopeeComment usa para montar o externalItemId, e o lote passa
    // a resolver anúncio para uma chave que a gravação não usa.
    for (const v of [9002, "9002", 0, "0", 999999999999999, " 9002 "]) {
      expect(QuestionRepository.chaveDeItemShopee(v)).toBe(String(v));
    }
  });

  it("ausente (undefined/null/vazio): null, e o comentário cai no caminho por item", () => {
    expect(QuestionRepository.chaveDeItemShopee(undefined)).toBeNull();
    expect(QuestionRepository.chaveDeItemShopee(null)).toBeNull();
    expect(QuestionRepository.chaveDeItemShopee("")).toBeNull();
  });

  it("zero NÃO é tratado como ausente", () => {
    // `0` é falsy: um filtro ingênuo por truthiness o descartaria.
    expect(QuestionRepository.chaveDeItemShopee(0)).toBe("0");
  });
});

// ===========================================================================
// resolveListingIds — o lote
// ===========================================================================
describe("QuestionRepository.resolveListingIds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filtra por marketplaceAccountId — o isolamento não pode virar opcional", async () => {
    const findMany = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await QuestionRepository.resolveListingIds("acc-1", ["9001", "9002"]);

    const arg = findMany.mock.calls[0][0] as any;
    expect(arg.where.marketplaceAccountId).toBe("acc-1");
    expect(arg.where.externalListingId.in.sort()).toEqual(["9001", "9002"]);
    expect(arg.select).toEqual({ id: true, externalListingId: true });
  });

  it("consultei e NÃO achei ⇒ null explícito no Map (não ausência)", async () => {
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);

    const mapa = await QuestionRepository.resolveListingIds("acc-1", ["9001"]);

    expect(mapa.has("9001")).toBe(true);
    expect(mapa.get("9001")).toBeNull();
  });

  it("achei ⇒ o id do anúncio", async () => {
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
      { id: "listing-1", externalListingId: "9001" },
    ] as any);

    const mapa = await QuestionRepository.resolveListingIds("acc-1", [
      "9001",
      "9002",
    ]);

    expect(mapa.get("9001")).toBe("listing-1");
    expect(mapa.get("9002")).toBeNull();
  });

  it("id que NÃO foi consultado ⇒ undefined (é o que devolve ao caminho por item)", async () => {
    vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([] as any);

    const mapa = await QuestionRepository.resolveListingIds("acc-1", ["9001"]);

    expect(mapa.get("9999")).toBeUndefined();
    expect(mapa.has("9999")).toBe(false);
  });

  it("lista vazia NÃO toca o banco", async () => {
    const findMany = vi.spyOn(prisma.productListing, "findMany");

    const mapa = await QuestionRepository.resolveListingIds("acc-1", []);

    expect(findMany).not.toHaveBeenCalled();
    expect(mapa.size).toBe(0);
  });

  it("ids repetidos viram um bind só", async () => {
    const findMany = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await QuestionRepository.resolveListingIds("acc-1", [
      "9001",
      "9001",
      "9001",
    ]);

    expect((findMany.mock.calls[0][0] as any).where.externalListingId.in).toEqual(
      ["9001"],
    );
  });

  it("EQUIVALÊNCIA com o singular: mesmo id, mesmo null e mesmo CRITÉRIO de conta", async () => {
    // Os stubs são chaveados por (conta, item) de propósito. Chavear só pelo
    // item deixaria passar divergência de CRITÉRIO: um dos gêmeos perder o
    // isolamento multi-tenant ficaria invisível, e o teste viraria álibi.
    const BANCO: Record<string, string> = {
      "acc-1|9001": "listing-1",
      "acc-2|9002": "listing-de-outro-tenant",
    };
    vi.spyOn(prisma.productListing, "findUnique").mockImplementation((async (
      arg: any,
    ) => {
      const k = arg.where.marketplaceAccountId_externalListingId;
      const id = BANCO[`${k.marketplaceAccountId}|${k.externalListingId}`];
      return id ? { id } : null;
    }) as any);
    vi.spyOn(prisma.productListing, "findMany").mockImplementation((async (
      arg: any,
    ) =>
      (arg.where.externalListingId.in as string[])
        .map((ext) => ({
          id: BANCO[`${arg.where.marketplaceAccountId}|${ext}`],
          externalListingId: ext,
        }))
        .filter((r) => r.id)) as any);

    // "9002" existe, mas em OUTRA conta: os dois caminhos têm de devolver null.
    const lote = await QuestionRepository.resolveListingIds("acc-1", [
      "9001",
      "9002",
    ]);

    for (const item of ["9001", "9002"]) {
      const singular = await QuestionRepository.resolveListingId("acc-1", item);
      expect(lote.get(item)).toBe(singular);
    }
    expect(lote.get("9002")).toBeNull();
  });

  it("o lote não pode devolver anúncio de OUTRA conta", async () => {
    const findMany = vi
      .spyOn(prisma.productListing, "findMany")
      .mockResolvedValue([] as any);

    await QuestionRepository.resolveListingIds("acc-1", ["9002"]);

    // Se o where perder o marketplaceAccountId, o `9002` da acc-2 casaria.
    expect((findMany.mock.calls[0][0] as any).where.marketplaceAccountId).toBe(
      "acc-1",
    );
  });
});

// ===========================================================================
// syncShopeeCommentsForAccount — o caminho de produção
// ===========================================================================
describe("syncShopeeCommentsForAccount — pré-carga em lote", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MESSAGES_SHOPEE_LISTING_BATCH_LEGACY;
  });

  const COMENTARIOS = [
    { comment_id: 1, item_id: 9001 },
    { comment_id: 2, item_id: 9002 },
    { comment_id: 3, item_id: 9001 },
  ];

  function montar(
    mapa: Map<string, string | null> | Error,
    comentarios: unknown[] = COMENTARIOS,
  ) {
    vi.spyOn(ShopeeApiService, "getComments").mockResolvedValue({
      comments: comentarios as any,
      more: false,
      nextCursor: "",
    });
    const lote = vi.spyOn(QuestionRepository, "resolveListingIds");
    if (mapa instanceof Error) lote.mockRejectedValue(mapa);
    else lote.mockResolvedValue(mapa);
    const upsert = vi
      .spyOn(QuestionRepository, "upsertFromShopeeComment")
      .mockResolvedValue({ id: "x", isNew: true });
    return { lote, upsert };
  }

  /** O terceiro argumento do upsert da enésima chamada. */
  const opts = (upsert: any, n: number) => upsert.mock.calls[n][2];

  it("uma consulta por página, com os itens da página", async () => {
    const { lote } = montar(new Map([["9001", "listing-1"], ["9002", null]]));

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(lote).toHaveBeenCalledTimes(1);
    expect(lote.mock.calls[0][0]).toBe("acc-1");
    expect([...lote.mock.calls[0][1]].sort()).toEqual(["9001", "9001", "9002"]);
  });

  it("achou ⇒ o id vai pré-resolvido e o upsert não consulta de novo", async () => {
    const { upsert } = montar(new Map([["9001", "listing-1"], ["9002", null]]));

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(opts(upsert, 0)).toEqual({ productListingId: "listing-1" });
    expect(opts(upsert, 2)).toEqual({ productListingId: "listing-1" });
  });

  it("consultei e não achei ⇒ null EXPLÍCITO, com a chave presente", async () => {
    // Se saísse undefined aqui, o N+1 voltaria em silêncio pelo
    // needsListingLookup — o ganho evaporaria sem nenhum teste acusar.
    const { upsert } = montar(new Map([["9001", "listing-1"], ["9002", null]]));

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect("productListingId" in (opts(upsert, 1) as object)).toBe(true);
    expect(opts(upsert, 1)).toEqual({ productListingId: null });
  });

  it("comentário SEM item_id ⇒ undefined ⇒ caminho por item, como hoje", async () => {
    const { lote, upsert } = montar(new Map(), [
      { comment_id: 1 },
      { comment_id: 2 },
    ]);

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    // Nenhuma chave utilizável ⇒ o lote nem é chamado.
    expect(lote).not.toHaveBeenCalled();
    expect(opts(upsert, 0)).toEqual({ productListingId: undefined });
  });

  it("FALHA do lote ⇒ todos caem no caminho por item e a função NÃO rejeita", async () => {
    const { upsert } = montar(new Error("pooler indisponível"));

    const r = await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    // Contrato numérico intacto: a falha do lote não conta como erro de
    // comentário, porque nenhum comentário deixou de ser gravado.
    expect(r).toEqual({ comments: 3, errors: 0 });
    for (const n of [0, 1, 2]) {
      expect(opts(upsert, n)).toEqual({ productListingId: undefined });
    }
  });

  it("Map PARCIAL: chave ausente vira undefined, NUNCA null", async () => {
    // O teste que separa "não consultei" de "consultei e não achei" no ponto
    // que importa — a leitura do Map no caller. Um `?? null` ali passaria por
    // todos os outros testes deste arquivo e desvincularia conversas: o Map
    // aqui é NÃO-nulo e está FALTANDO a chave 9002 de propósito.
    const { upsert } = montar(new Map([["9001", "listing-1"]]));

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(opts(upsert, 0)).toEqual({ productListingId: "listing-1" });
    expect(opts(upsert, 1).productListingId).toBeUndefined();
    expect(opts(upsert, 1).productListingId).not.toBeNull();
  });

  it("chave do LOTE e chave da GRAVAÇÃO saem da mesma expressão", async () => {
    // Se um dos dois lados normalizar diferente (trim, Number, parseInt), o
    // valor pré-resolvido não casa e chega undefined aqui.
    const { lote, upsert } = montar(new Map([[" 9002 ", "listing-espaco"]]), [
      { comment_id: 1, item_id: " 9002 " },
    ]);

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(lote.mock.calls[0][1]).toEqual([" 9002 "]);
    expect(opts(upsert, 0)).toEqual({ productListingId: "listing-espaco" });
  });

  it("kill-switch: com MESSAGES_SHOPEE_LISTING_BATCH_LEGACY=1 não há lote", async () => {
    process.env.MESSAGES_SHOPEE_LISTING_BATCH_LEGACY = "1";
    const { lote, upsert } = montar(new Map([["9001", "listing-1"]]));

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(lote).not.toHaveBeenCalled();
    for (const n of [0, 1, 2]) {
      expect(opts(upsert, n)).toEqual({ productListingId: undefined });
    }
  });

  it("página vazia não dispara o lote", async () => {
    const { lote, upsert } = montar(new Map(), []);

    const r = await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(lote).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(r).toEqual({ comments: 0, errors: 0 });
  });

  it("uma consulta POR PÁGINA — duas páginas, dois lotes", async () => {
    vi.spyOn(ShopeeApiService, "getComments")
      .mockResolvedValueOnce({
        comments: [{ comment_id: 1, item_id: 9001 }] as any,
        more: true,
        nextCursor: "cur2",
      })
      .mockResolvedValueOnce({
        comments: [{ comment_id: 2, item_id: 9002 }] as any,
        more: false,
        nextCursor: "",
      });
    const lote = vi
      .spyOn(QuestionRepository, "resolveListingIds")
      .mockResolvedValue(new Map());
    vi.spyOn(QuestionRepository, "upsertFromShopeeComment").mockResolvedValue({
      id: "x",
      isNew: true,
    });

    await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(lote).toHaveBeenCalledTimes(2);
    expect(lote.mock.calls[0][1]).toEqual(["9001"]);
    expect(lote.mock.calls[1][1]).toEqual(["9002"]);
  });

  it("MOTIVO DO PR — o upsert NÃO reconsulta quando recebe o valor pré-resolvido", async () => {
    // Todos os outros testes espionam upsertFromShopeeComment inteiro, então
    // provam que o 3º argumento foi PASSADO, nunca que ele é USADO. Aqui o
    // repositório roda de verdade: se ele ignorar o valor, o resolveListingId
    // volta a ser chamado e o N+1 que este PR existe para matar renasce.
    const porItem = vi.spyOn(QuestionRepository, "resolveListingId");
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      null as any,
    );
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      null as any,
    );
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q1" } as any);

    await QuestionRepository.upsertFromShopeeComment(
      "acc-1",
      {
        comment_id: 1,
        comment: "oi",
        buyer_username: "ana",
        item_id: 9001,
        create_time: 1_750_000_000,
        comment_reply: null,
      },
      { productListingId: "listing-1" },
    );

    expect(porItem).not.toHaveBeenCalled();
    expect((upsert.mock.calls[0][0] as any).create.productListingId).toBe(
      "listing-1",
    );
  });

  it("null pré-resolvido também evita a reconsulta (não é o mesmo que undefined)", async () => {
    const porItem = vi.spyOn(QuestionRepository, "resolveListingId");
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      null as any,
    );
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      null as any,
    );
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q1" } as any);

    await QuestionRepository.upsertFromShopeeComment(
      "acc-1",
      {
        comment_id: 1,
        comment: "oi",
        buyer_username: "ana",
        item_id: 9001,
        create_time: 1_750_000_000,
        comment_reply: null,
      },
      { productListingId: null },
    );

    expect(porItem).not.toHaveBeenCalled();
    expect((upsert.mock.calls[0][0] as any).create.productListingId).toBeNull();
  });

  it("falha do lote é POR PÁGINA: a página seguinte continua e ainda usa o lote", async () => {
    // Prova que o catch não interrompe a paginação — um timeout do pooler na
    // página 1 não pode custar as páginas seguintes da conta.
    vi.spyOn(ShopeeApiService, "getComments")
      .mockResolvedValueOnce({
        comments: [{ comment_id: 1, item_id: 9001 }] as any,
        more: true,
        nextCursor: "cur2",
      })
      .mockResolvedValueOnce({
        comments: [{ comment_id: 2, item_id: 9002 }] as any,
        more: false,
        nextCursor: "",
      });
    vi.spyOn(QuestionRepository, "resolveListingIds")
      .mockRejectedValueOnce(new Error("pooler"))
      .mockResolvedValueOnce(new Map([["9002", "listing-2"]]));
    const upsert = vi
      .spyOn(QuestionRepository, "upsertFromShopeeComment")
      .mockResolvedValue({ id: "x", isNew: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(r).toEqual({ comments: 2, errors: 0 });
    expect(opts(upsert, 0).productListingId).toBeUndefined();
    expect(opts(upsert, 1)).toEqual({ productListingId: "listing-2" });
  });

  it("CONVERGÊNCIA entre ciclos: fallback e lote gravam o MESMO valor", async () => {
    // O cenário que mais assusta: ciclo 1 com o lote falhando (grava pelo
    // caminho por item), ciclo 2 com o lote funcionando. Se os dois caminhos
    // divergissem, `perguntaJaGravada` acusaria diferença e reescreveria as
    // linhas a cada ciclo, para sempre — com errors=0 e ninguém percebendo.
    const gravados: (string | null)[] = [];
    const comentario = {
      comment_id: 1,
      comment: "oi",
      buyer_username: "ana",
      item_id: 9001,
      create_time: 1_750_000_000,
      comment_reply: null,
    };

    for (const loteFunciona of [false, true]) {
      vi.restoreAllMocks();
      vi.spyOn(ShopeeApiService, "getComments").mockResolvedValue({
        comments: [comentario] as any,
        more: false,
        nextCursor: "",
      });
      // O banco: o anúncio 9001 da acc-1 existe.
      vi.spyOn(prisma.productListing, "findUnique").mockResolvedValue({
        id: "listing-1",
      } as any);
      vi.spyOn(prisma.productListing, "findMany").mockResolvedValue([
        { id: "listing-1", externalListingId: "9001" },
      ] as any);
      vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
        null as any,
      );
      vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
        null as any,
      );
      const upsert = vi
        .spyOn(prisma.marketplaceQuestion, "upsert")
        .mockResolvedValue({ id: "q1" } as any);
      if (!loteFunciona) {
        vi.spyOn(QuestionRepository, "resolveListingIds").mockRejectedValue(
          new Error("pooler"),
        );
        vi.spyOn(console, "warn").mockImplementation(() => {});
      }

      await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);
      gravados.push((upsert.mock.calls[0][0] as any).create.productListingId);
    }

    // Ciclo com fallback e ciclo com lote têm de gravar exatamente o mesmo.
    expect(gravados[0]).toBe("listing-1");
    expect(gravados[1]).toBe(gravados[0]);
  });

  it("erro de UM comentário continua isolado no seu try/catch", async () => {
    vi.spyOn(ShopeeApiService, "getComments").mockResolvedValue({
      comments: COMENTARIOS as any,
      more: false,
      nextCursor: "",
    });
    vi.spyOn(QuestionRepository, "resolveListingIds").mockResolvedValue(
      new Map([["9001", "listing-1"]]),
    );
    vi.spyOn(QuestionRepository, "upsertFromShopeeComment")
      .mockRejectedValueOnce(new Error("falhou"))
      .mockResolvedValue({ id: "x", isNew: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await MessagesUseCase.syncShopeeCommentsForAccount(CONTA as any);

    expect(r).toEqual({ comments: 2, errors: 1 });
  });
});
