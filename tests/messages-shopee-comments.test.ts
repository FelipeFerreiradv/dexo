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

    await MessagesUseCase.answerQuestion("user-1", "acc-1", "q1", "Sim, temos!");

    expect(reply).toHaveBeenCalledWith("tok", 123, 555, "Sim, temos!");
    expect(attach).toHaveBeenCalledWith(
      "q1",
      expect.objectContaining({ text: "Sim, temos!", status: "ACTIVE" }),
    );
  });
});
