import { describe, it, expect, vi, afterEach } from "vitest";

import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { MessagesUseCase } from "@/app/marketplaces/usecases/messages.usecase";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import prisma from "@/app/lib/prisma";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

// ===========================================================================
// QuestionRepository.upsertFromShopeeComment (Q&A 1:1, authorType NULL)
// ===========================================================================
describe("QuestionRepository.upsertFromShopeeComment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem reply: status UNANSWERED, authorType ausente, sem attachAnswer", async () => {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      null as any,
    );
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q1" } as any);
    const attach = vi.spyOn(QuestionRepository, "attachAnswer");

    const r = await QuestionRepository.upsertFromShopeeComment("acc-1", {
      comment_id: 555,
      comment: "tem na cor preta?",
      buyer_username: "ana123",
      item_id: 9001,
      create_time: 1_750_000_000,
      comment_reply: null,
    });

    expect(r).toEqual({ id: "q1", isNew: true });
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.status).toBe("UNANSWERED");
    expect(arg.create.externalQuestionId).toBe("555");
    expect(arg.create.externalItemId).toBe("9001");
    expect(arg.create.externalBuyerId).toBe("ana123");
    expect(arg.create.authorType).toBeUndefined(); // Q&A não usa authorType
    expect(attach).not.toHaveBeenCalled();
  });

  it("com comment_reply: anexa a resposta (attachAnswer)", async () => {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(null as any);
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    vi.spyOn(prisma.marketplaceQuestion, "upsert").mockResolvedValue({
      id: "q2",
    } as any);
    // Nada gravado ainda: a guarda de novidade deixa passar.
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      null as any,
    );
    const attach = vi
      .spyOn(QuestionRepository, "attachAnswer")
      .mockResolvedValue(undefined as any);

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      comment_id: 556,
      comment: "qual a garantia?",
      buyer_username: "bob",
      item_id: 9001,
      create_time: 1_750_000_000,
      comment_reply: { reply: "1 ano", create_time: 1_750_000_100 },
    });

    expect(attach).toHaveBeenCalledTimes(1);
    const [qid, ans] = attach.mock.calls[0];
    expect(qid).toBe("q2");
    expect(ans.text).toBe("1 ano");
    expect(ans.status).toBe("ACTIVE");
  });
});

// ===========================================================================
// QuestionRepository.upsertFromShopeeComment — readAt inicial
//
// O cron da Shopee varre os comentários shop-wide; um comentário que o vendedor
// já respondeu pelo app da Shopee chega aqui pela PRIMEIRA vez já com
// `comment_reply`. Antes desta regra ele nascia não lido e reacendia o número
// numa conversa respondida (1.284 linhas nesse estado em produção).
// ===========================================================================
describe("QuestionRepository.upsertFromShopeeComment — readAt inicial", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mocka o que o upsert toca e devolve o spy.
   *
   * `respostaGravada` é o que a guarda de novidade lê: `null` = ainda não há
   * resposta no banco, então o attachAnswer roda (comportamento legado).
   */
  function mockarUpsert(
    existente: { id: string } | null = null,
    respostaGravada: {
      text: string;
      status: string;
      dateCreated: Date;
    } | null = null,
  ) {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      existente as any,
    );
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      respostaGravada as any,
    );
    vi.spyOn(QuestionRepository, "attachAnswer").mockResolvedValue(
      undefined as any,
    );
    return vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: existente?.id ?? "q1" } as any);
  }

  const COMENTARIO = {
    comment_id: 777,
    comment: "chega em quantos dias?",
    buyer_username: "carla",
    item_id: 9002,
    create_time: 1_750_000_000,
  };

  it("sem reply: create.readAt null (nasce NÃO lido, como antes)", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: null,
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toBeNull();
    expect(arg.create.status).toBe("UNANSWERED");
    expect(arg.update.readAt).toBeUndefined();
  });

  it("com reply: create.readAt = data da RESPOSTA", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis", create_time: 1_750_000_100 },
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toEqual(new Date(1_750_000_100 * 1000));
    expect(arg.create.status).toBe("ANSWERED");
    expect(arg.update.readAt).toBeUndefined();
  });

  it("reply sem create_time: cai na data do COMENTÁRIO (nunca Invalid Date)", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis" },
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toEqual(new Date(1_750_000_000 * 1000));
    expect(Number.isNaN(arg.create.readAt.getTime())).toBe(false);
  });

  it("re-sync de linha existente: update segue com os MESMOS 5 campos", async () => {
    const upsert = mockarUpsert({ id: "q-existente" });

    const r = await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis", create_time: 1_750_000_100 },
    });

    expect(r).toEqual({ id: "q-existente", isNew: false });
    const arg = upsert.mock.calls[0][0] as any;
    expect(Object.keys(arg.update).sort()).toEqual([
      "buyerNickname",
      "lastSyncedAt",
      "productListingId",
      "status",
      "text",
    ]);
  });
});

// ===========================================================================
// ShopeeApiService.getComments / replyComment (contrato + normalização)
// ===========================================================================
describe("ShopeeApiService.getComments / replyComment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normaliza o campo de resposta (comment_reply e o legado cmt_reply)", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue({
      error: "",
      message: "",
      response: {
        item_comment_list: [
          { comment_id: 1, comment: "a", comment_reply: { reply: "novo" } },
          { comment_id: 2, comment: "b", cmt_reply: { reply: "legado" } },
          { comment_id: 3, comment: "c" },
        ],
        more: true,
        next_cursor: "c2",
      },
    });

    const r = await ShopeeApiService.getComments("tok", 123, { itemId: 9001 });
    expect(r.comments[0].comment_reply).toEqual({ reply: "novo" });
    expect(r.comments[1].comment_reply).toEqual({ reply: "legado" });
    expect(r.comments[2].comment_reply).toBeNull();
    expect(r.more).toBe(true);
    expect(r.nextCursor).toBe("c2");
  });

  it("passa item_id/cursor na query e normaliza ausência de resposta", async () => {
    const spy = vi
      .spyOn(ShopeeApiService as any, "makeAuthenticatedRequest")
      .mockResolvedValue({ error: "", message: "", response: {} });

    const r = await ShopeeApiService.getComments("tok", 123, {
      itemId: 9001,
      cursor: "abc",
    });
    const path = spy.mock.calls[0][1] as string;
    expect(path).toContain("/api/v2/product/get_comment");
    expect(path).toContain("item_id=9001");
    expect(path).toContain("cursor=abc");
    expect(r.comments).toEqual([]);
    expect(r.more).toBe(false);
  });

  it("replyComment: falha por-item (result_list.fail_error) vira throw", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue({
      error: "",
      message: "",
      response: {
        result_list: [
          { comment_id: 5, fail_error: "comment_has_replied", fail_message: "já respondido" },
        ],
      },
    });
    await expect(
      ShopeeApiService.replyComment("tok", 123, 5, "oi"),
    ).rejects.toThrow(/já respondido|comment_has_replied/);
  });

  it("replyComment: erro no envelope vira throw", async () => {
    vi.spyOn(ShopeeApiService as any, "makeAuthenticatedRequest").mockResolvedValue({
      error: "error_auth",
      message: "bad token",
      response: {},
    });
    await expect(
      ShopeeApiService.replyComment("tok", 123, 5, "oi"),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// MessagesUseCase.syncShopeeCommentsForAccount (cron, cursor pagination)
// ===========================================================================
describe("MessagesUseCase.syncShopeeCommentsForAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pagina por cursor e faz upsert de cada comentário", async () => {
    const getComments = vi
      .spyOn(ShopeeApiService, "getComments")
      .mockResolvedValueOnce({
        comments: [{ comment_id: 1 }, { comment_id: 2 }] as any,
        more: true,
        nextCursor: "cur2",
      })
      .mockResolvedValueOnce({
        comments: [{ comment_id: 3 }] as any,
        more: false,
        nextCursor: "",
      });
    const upsert = vi
      .spyOn(QuestionRepository, "upsertFromShopeeComment")
      .mockResolvedValue({ id: "x", isNew: true });

    const r = await MessagesUseCase.syncShopeeCommentsForAccount({
      id: "acc-1",
      shopId: 123,
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: FUTURE,
    });

    expect(r).toEqual({ comments: 3, errors: 0 });
    expect(upsert).toHaveBeenCalledTimes(3);
    // 2ª página usou o cursor da 1ª
    expect((getComments.mock.calls[1][2] as any).cursor).toBe("cur2");
  });

  it("token/shopId ausente ⇒ não chama API e reporta erro", async () => {
    const getComments = vi.spyOn(ShopeeApiService, "getComments");
    const r = await MessagesUseCase.syncShopeeCommentsForAccount({
      id: "acc-1",
      shopId: null,
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: FUTURE,
    });
    expect(r).toEqual({ comments: 0, errors: 1 });
    expect(getComments).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// MessagesUseCase.answerQuestion — dispatch Shopee (reply_comment)
// ===========================================================================
describe("MessagesUseCase.answerQuestion — Shopee", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("conta Shopee: chama replyComment e anexa a resposta localmente", async () => {
    vi.spyOn(QuestionRepository, "findById")
      .mockResolvedValueOnce({
        id: "q1",
        marketplaceAccountId: "acc-1",
        externalQuestionId: "555",
        externalItemId: "9001",
        status: "UNANSWERED",
        marketplaceAccount: { userId: "user-1", platform: "SHOPEE" },
      } as any)
      .mockResolvedValueOnce({ id: "q1", status: "ANSWERED" } as any);
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue({
      id: "acc-1",
      userId: "user-1",
      platform: "SHOPEE",
      shopId: 123,
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: FUTURE,
    } as any);
    const reply = vi
      .spyOn(ShopeeApiService, "replyComment")
      .mockResolvedValue(undefined as any);
    const attach = vi
      .spyOn(QuestionRepository, "attachAnswer")
      .mockResolvedValue(undefined as any);
    // Responder marca a conversa como lida no servidor. Spy também mantém o
    // teste hermético (sem o mock, o updateMany tenta o banco de verdade).
    const marcarLida = vi
      .spyOn(QuestionRepository, "markConversationRead")
      .mockResolvedValue(1);

    await MessagesUseCase.answerQuestion("user-1", "acc-1", "q1", "Sim, temos!");

    expect(reply).toHaveBeenCalledWith("tok", 123, 555, "Sim, temos!");
    expect(attach).toHaveBeenCalledWith(
      "q1",
      expect.objectContaining({ text: "Sim, temos!", status: "ACTIVE" }),
    );
    expect(marcarLida).toHaveBeenCalledWith("acc-1", "9001", "user-1");
  });
});
