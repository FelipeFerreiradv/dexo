import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

import { messagesRoutes } from "@/app/routes/messages.routes";
import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { MessagesUseCase } from "@/app/marketplaces/usecases/messages.usecase";
import { MagaluChatApiService } from "@/app/marketplaces/services/magalu-chat-api.service";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import prisma from "@/app/lib/prisma";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

// ===========================================================================
// QuestionRepository — Magalu chat (write path)
// ===========================================================================
describe("QuestionRepository.upsertMagaluMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CUSTOMER: cria com authorType CUSTOMER, status UNANSWERED, readAt null", async () => {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      null as any,
    );
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q1" } as any);

    const r = await QuestionRepository.upsertMagaluMessage("acc-1", {
      conversationId: "conv-1",
      messageId: "m1",
      text: "tem disponível?",
      authorType: "CUSTOMER",
      dateCreated: new Date("2026-06-30T12:00:00Z"),
      customerExternalId: "cust-1",
      customerName: "Maria",
    });

    expect(r).toEqual({ id: "q1", isNew: true });
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.authorType).toBe("CUSTOMER");
    expect(arg.create.status).toBe("UNANSWERED");
    expect(arg.create.externalItemId).toBe("conv-1");
    expect(arg.create.externalBuyerId).toBe("cust-1");
    expect(arg.create.readAt).toBeNull();
    // re-sync NÃO mexe em readAt/status individual
    expect(arg.update.readAt).toBeUndefined();
    expect(arg.update.status).toBeUndefined();
  });

  it("SELLER: status ANSWERED e readAt = dateCreated (já lido)", async () => {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue({
      id: "q9",
    } as any);
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q9" } as any);

    const when = new Date("2026-06-30T13:00:00Z");
    const r = await QuestionRepository.upsertMagaluMessage("acc-1", {
      conversationId: "conv-1",
      messageId: "m2",
      text: "Olá! Sim, temos.",
      authorType: "SELLER",
      dateCreated: when,
      customerExternalId: "cust-1",
      customerName: "Maria",
    });

    expect(r.isNew).toBe(false);
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.authorType).toBe("SELLER");
    expect(arg.create.status).toBe("ANSWERED");
    expect(arg.create.readAt).toBe(when);
  });
});

describe("QuestionRepository.syncMagaluConversation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pending=true ⇒ reescreve status de TODAS as linhas para UNANSWERED", async () => {
    vi.spyOn(QuestionRepository, "upsertMagaluMessage").mockResolvedValue({
      id: "x",
      isNew: true,
    } as any);
    const updateMany = vi
      .spyOn(prisma.marketplaceQuestion, "updateMany")
      .mockResolvedValue({ count: 2 } as any);

    const r = await QuestionRepository.syncMagaluConversation("acc-1", {
      conversationId: "conv-1",
      customerExternalId: "cust-1",
      customerName: "Maria",
      pending: true,
      messages: [
        { messageId: "m1", text: "oi", authorType: "CUSTOMER", dateCreated: new Date() },
        { messageId: "m2", text: "ok", authorType: "SELLER", dateCreated: new Date() },
      ],
    });

    expect(r.synced).toBe(2);
    const arg = updateMany.mock.calls[0][0] as any;
    expect(arg.where).toEqual({
      marketplaceAccountId: "acc-1",
      externalItemId: "conv-1",
    });
    expect(arg.data).toEqual({ status: "UNANSWERED" });
  });

  it("pending=false ⇒ status ANSWERED", async () => {
    vi.spyOn(QuestionRepository, "upsertMagaluMessage").mockResolvedValue({
      id: "x",
      isNew: false,
    } as any);
    const updateMany = vi
      .spyOn(prisma.marketplaceQuestion, "updateMany")
      .mockResolvedValue({ count: 1 } as any);

    await QuestionRepository.syncMagaluConversation("acc-1", {
      conversationId: "conv-1",
      customerExternalId: "cust-1",
      customerName: "Maria",
      pending: false,
      messages: [
        { messageId: "m2", text: "ok", authorType: "SELLER", dateCreated: new Date() },
      ],
    });

    expect((updateMany.mock.calls[0][0] as any).data).toEqual({
      status: "ANSWERED",
    });
  });
});

// ===========================================================================
// MessagesUseCase — Magalu chat (dispatch)
// ===========================================================================
describe("MessagesUseCase.syncMagaluMessagesForAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grava a última mensagem de cada conversa, com pending = última msg CUSTOMER", async () => {
    vi.spyOn(MagaluChatApiService, "listConversations").mockResolvedValue({
      conversations: [
        {
          id: "conv-1",
          from_user: { external_id: "cust-1", full_name: "Maria", type: "CUSTOMER" },
          last_message: {
            id: "m1",
            content: "tem?",
            when_at: "2026-06-30T12:00:00Z",
            from_user: { type: "CUSTOMER", external_id: "cust-1" },
          },
        },
        {
          id: "conv-2",
          from_user: { external_id: "cust-2", full_name: "João", type: "CUSTOMER" },
          last_message: {
            id: "m2",
            content: "obrigado",
            when_at: "2026-06-30T13:00:00Z",
            from_user: { type: "SELLER", external_id: "seller-1" },
          },
        },
      ],
      total: 2,
    } as any);

    const sync = vi
      .spyOn(QuestionRepository, "syncMagaluConversation")
      .mockResolvedValue({ synced: 1, created: 1 } as any);

    const r = await MessagesUseCase.syncMagaluMessagesForAccount({
      id: "acc-1",
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: FUTURE,
    });

    expect(r).toEqual({ conversations: 2, errors: 0 });
    expect(sync).toHaveBeenCalledTimes(2);
    // conv-1: última msg é CUSTOMER → pending true
    expect((sync.mock.calls[0][1] as any).pending).toBe(true);
    expect((sync.mock.calls[0][1] as any).customerExternalId).toBe("cust-1");
    // conv-2: última msg é SELLER → pending false
    expect((sync.mock.calls[1][1] as any).pending).toBe(false);
  });

  it("conversa iniciada pelo SELLER: cliente vem de conv.to_user, não do autor da última msg", async () => {
    vi.spyOn(MagaluChatApiService, "listConversations").mockResolvedValue({
      conversations: [
        {
          id: "conv-9",
          // criador = SELLER; o cliente é o destinatário (to_user)
          from_user: { external_id: "seller-1", full_name: "Loja", type: "SELLER" },
          to_user: { external_id: "cust-9", full_name: "Ana", type: "CUSTOMER" },
          last_message: {
            id: "m9",
            content: "bom dia",
            when_at: "2026-06-30T10:00:00Z",
            from_user: { type: "SELLER", external_id: "seller-1" },
          },
        },
      ],
      total: 1,
    } as any);
    const sync = vi
      .spyOn(QuestionRepository, "syncMagaluConversation")
      .mockResolvedValue({ synced: 1, created: 1 } as any);

    await MessagesUseCase.syncMagaluMessagesForAccount({
      id: "acc-1",
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: FUTURE,
    });

    const arg = sync.mock.calls[0][1] as any;
    expect(arg.customerExternalId).toBe("cust-9");
    expect(arg.customerName).toBe("Ana");
    expect(arg.pending).toBe(false); // última msg é do SELLER
  });

  it("token ausente ⇒ não chama API e reporta erro", async () => {
    const list = vi.spyOn(MagaluChatApiService, "listConversations");
    const r = await MessagesUseCase.syncMagaluMessagesForAccount({
      id: "acc-1",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    expect(r).toEqual({ conversations: 0, errors: 1 });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("MessagesUseCase.sendMagaluMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const magaluAccount = {
    id: "acc-1",
    userId: "user-1",
    platform: "MAGALU",
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: FUTURE,
  };

  it("monta owner com o cliente e chama replyMessage; re-sincroniza", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      magaluAccount as any,
    );
    vi.spyOn(QuestionRepository, "getConversationCustomer").mockResolvedValue({
      externalBuyerId: "cust-1",
      buyerNickname: "Maria",
    });
    const reply = vi
      .spyOn(MagaluChatApiService, "replyMessage")
      .mockResolvedValue({ id: "m9" } as any);
    // pullMagaluConversation → listMessages vazio (no-op de re-sync)
    vi.spyOn(MagaluChatApiService, "listMessages").mockResolvedValue({
      messages: [],
      total: 0,
    } as any);
    // Enviar mensagem marca a conversa como lida no servidor (é impossível
    // responder sem ter lido). Spy também mantém o teste sem tocar no banco.
    const marcarLida = vi
      .spyOn(QuestionRepository, "markConversationRead")
      .mockResolvedValue(1);

    const r = await MessagesUseCase.sendMagaluMessage(
      "user-1",
      "acc-1",
      "conv-1",
      "Bom dia!",
    );

    expect(r).toEqual({ success: true });
    const [token, convId, body] = reply.mock.calls[0];
    expect(token).toBe("tok");
    expect(convId).toBe("conv-1");
    expect(body.content).toBe("Bom dia!");
    expect(body.owner).toEqual({ external_id: "cust-1", name: "Maria" });
    expect(marcarLida).toHaveBeenCalledWith("acc-1", "conv-1", "user-1");
  });

  it("cliente desconhecido ⇒ 409 e NÃO chama a API", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      magaluAccount as any,
    );
    vi.spyOn(QuestionRepository, "getConversationCustomer").mockResolvedValue(
      null,
    );
    const reply = vi.spyOn(MagaluChatApiService, "replyMessage");

    await expect(
      MessagesUseCase.sendMagaluMessage("user-1", "acc-1", "conv-1", "oi"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(reply).not.toHaveBeenCalled();
  });

  it("texto acima de 2200 ⇒ 400", async () => {
    await expect(
      MessagesUseCase.sendMagaluMessage(
        "user-1",
        "acc-1",
        "conv-1",
        "x".repeat(2201),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("MessagesUseCase.answerQuestion — guarda de plataforma", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("conta não-ML (Magalu) ⇒ 400 (use o fluxo de chat)", async () => {
    vi.spyOn(QuestionRepository, "findById").mockResolvedValue({
      id: "q1",
      marketplaceAccountId: "acc-1",
      externalQuestionId: "m1",
      status: "UNANSWERED",
      marketplaceAccount: { userId: "user-1", platform: "MAGALU" },
    } as any);

    await expect(
      MessagesUseCase.answerQuestion("user-1", "acc-1", "q1", "resposta"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ===========================================================================
// Rotas — /messages/accounts (multi-plataforma) e /messages/answers (dispatch)
// ===========================================================================
const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(messagesRoutes, { prefix: "/messages" });
  return app;
};

describe("rotas /messages — multi-plataforma", () => {
  beforeEach(() => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "u@x.com",
    } as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /accounts devolve ML + Shopee + Magalu com platform (nessa ordem)", async () => {
    vi.spyOn(
      MarketplaceRepository,
      "findAllByUserIdAndPlatform",
    ).mockImplementation(async (_userId: string, platform: any) => {
      const byPlatform: Record<string, any[]> = {
        MERCADO_LIVRE: [
          { id: "ml-1", accountName: "Loja ML", status: "ACTIVE", platform },
        ],
        SHOPEE: [
          { id: "sh-1", accountName: "Loja Shopee", status: "ACTIVE", platform },
        ],
        MAGALU: [
          { id: "mg-1", accountName: "Loja Magalu", status: "ACTIVE", platform },
        ],
      };
      return byPlatform[platform] ?? [];
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/accounts",
      headers: { email: "u@x.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accounts).toEqual([
      { id: "ml-1", accountName: "Loja ML", status: "ACTIVE", platform: "MERCADO_LIVRE" },
      { id: "sh-1", accountName: "Loja Shopee", status: "ACTIVE", platform: "SHOPEE" },
      { id: "mg-1", accountName: "Loja Magalu", status: "ACTIVE", platform: "MAGALU" },
    ]);
    await app.close();
  });

  it("POST /answers conta Magalu + itemId ⇒ sendMagaluMessage", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue({
      id: "mg-1",
      userId: "user-1",
      platform: "MAGALU",
    } as any);
    const send = vi
      .spyOn(MessagesUseCase, "sendMagaluMessage")
      .mockResolvedValue({ success: true } as any);
    const answer = vi.spyOn(MessagesUseCase, "answerQuestion");

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/messages/answers",
      headers: { email: "u@x.com" },
      payload: { accountId: "mg-1", itemId: "conv-1", text: "Bom dia!" },
    });

    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith("user-1", "mg-1", "conv-1", "Bom dia!");
    expect(answer).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /answers conta Magalu SEM itemId ⇒ 400", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue({
      id: "mg-1",
      userId: "user-1",
      platform: "MAGALU",
    } as any);
    const send = vi.spyOn(MessagesUseCase, "sendMagaluMessage");

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/messages/answers",
      headers: { email: "u@x.com" },
      payload: { accountId: "mg-1", text: "Bom dia!" },
    });

    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
    await app.close();
  });

  it("POST /answers conta ML + questionId ⇒ answerQuestion", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue({
      id: "ml-1",
      userId: "user-1",
      platform: "MERCADO_LIVRE",
    } as any);
    const answer = vi
      .spyOn(MessagesUseCase, "answerQuestion")
      .mockResolvedValue({ id: "q1" } as any);
    const send = vi.spyOn(MessagesUseCase, "sendMagaluMessage");

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/messages/answers",
      headers: { email: "u@x.com" },
      payload: { accountId: "ml-1", questionId: "q1", text: "resposta" },
    });

    expect(res.statusCode).toBe(200);
    expect(answer).toHaveBeenCalledWith("user-1", "ml-1", "q1", "resposta");
    expect(send).not.toHaveBeenCalled();
    await app.close();
  });
});
