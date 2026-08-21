import { describe, it, expect, vi, afterEach } from "vitest";

import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { MessagesUseCase } from "@/app/marketplaces/usecases/messages.usecase";
import { MlQuestionsApiService } from "@/app/marketplaces/services/ml-questions-api.service";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import { MagaluChatApiService } from "@/app/marketplaces/services/magalu-chat-api.service";

/**
 * Responder implica ter lido — e isso precisa acontecer no SERVIDOR.
 *
 * Antes disto, `answerQuestion` e `sendMagaluMessage` não tocavam em `readAt`:
 * a conversa só ficava lida se o painel tivesse sido aberto E o POST /read
 * tivesse dado certo. Em produção sobraram 73 perguntas não lidas COM resposta
 * anexada, em conversas que o vendedor sabia ter respondido.
 *
 * A segunda invariante, igualmente importante: a marcação é BEST-EFFORT. A
 * resposta já saiu para o marketplace; uma falha aqui não pode derrubar o
 * request, senão a UI mostra erro num envio que deu certo e o vendedor reenvia
 * — duplicando a resposta no anúncio.
 */

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

const CONTA_ML = {
  id: "acc-ml",
  userId: "user-1",
  platform: "MERCADO_LIVRE",
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: FUTURE,
};

const CONTA_SHOPEE = {
  id: "acc-sh",
  userId: "user-1",
  platform: "SHOPEE",
  shopId: 123,
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: FUTURE,
};

function mockarPergunta(accountId: string, platform: string) {
  vi.spyOn(QuestionRepository, "findById")
    .mockResolvedValueOnce({
      id: "q1",
      marketplaceAccountId: accountId,
      externalQuestionId: "555",
      externalItemId: "MLB999",
      status: "UNANSWERED",
      marketplaceAccount: { userId: "user-1", platform },
    } as any)
    .mockResolvedValueOnce({ id: "q1", status: "ANSWERED" } as any);
}

describe("MessagesUseCase.answerQuestion — responder marca a conversa como lida", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Mercado Livre: marca (accountId, externalItemId) após postar a resposta", async () => {
    mockarPergunta("acc-ml", "MERCADO_LIVRE");
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      CONTA_ML as any,
    );
    vi.spyOn(MlQuestionsApiService, "postAnswer").mockResolvedValue({
      id: 555,
      text: "pergunta",
      status: "ANSWERED",
      date_created: "2026-08-01T10:00:00.000Z",
      item_id: "MLB999",
      seller_id: 1,
    } as any);
    vi.spyOn(QuestionRepository, "upsertFromMl").mockResolvedValue({
      id: "q1",
      isNew: false,
    });
    const marcarLida = vi
      .spyOn(QuestionRepository, "markConversationRead")
      .mockResolvedValue(1);

    await MessagesUseCase.answerQuestion("user-1", "acc-ml", "q1", "serve sim");

    expect(marcarLida).toHaveBeenCalledWith("acc-ml", "MLB999", "user-1");
  });

  it("Shopee: marca (accountId, externalItemId) após o reply_comment", async () => {
    mockarPergunta("acc-sh", "SHOPEE");
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      CONTA_SHOPEE as any,
    );
    vi.spyOn(ShopeeApiService, "replyComment").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(QuestionRepository, "attachAnswer").mockResolvedValue(
      undefined as any,
    );
    const marcarLida = vi
      .spyOn(QuestionRepository, "markConversationRead")
      .mockResolvedValue(1);

    await MessagesUseCase.answerQuestion("user-1", "acc-sh", "q1", "temos sim");

    expect(marcarLida).toHaveBeenCalledWith("acc-sh", "MLB999", "user-1");
  });

  it("falha ao marcar NÃO derruba a resposta já enviada ao marketplace", async () => {
    mockarPergunta("acc-sh", "SHOPEE");
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      CONTA_SHOPEE as any,
    );
    const reply = vi
      .spyOn(ShopeeApiService, "replyComment")
      .mockResolvedValue(undefined as any);
    vi.spyOn(QuestionRepository, "attachAnswer").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(QuestionRepository, "markConversationRead").mockRejectedValue(
      new Error("pool esgotado"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Não pode rejeitar: o vendedor reenviaria e duplicaria a resposta.
    await expect(
      MessagesUseCase.answerQuestion("user-1", "acc-sh", "q1", "temos sim"),
    ).resolves.toBeDefined();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("marcação acontece DEPOIS do envio: falha no marketplace não marca nada", async () => {
    mockarPergunta("acc-sh", "SHOPEE");
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      CONTA_SHOPEE as any,
    );
    vi.spyOn(ShopeeApiService, "replyComment").mockRejectedValue(
      new Error("Shopee fora do ar"),
    );
    const marcarLida = vi
      .spyOn(QuestionRepository, "markConversationRead")
      .mockResolvedValue(1);

    await expect(
      MessagesUseCase.answerQuestion("user-1", "acc-sh", "q1", "temos sim"),
    ).rejects.toThrow();
    expect(marcarLida).not.toHaveBeenCalled();
  });
});

describe("MessagesUseCase.sendMagaluMessage — enviar marca a conversa como lida", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CONTA_MAGALU = {
    id: "acc-mg",
    userId: "user-1",
    platform: "MAGALU",
    accessToken: "tok",
    refreshToken: "ref",
    expiresAt: FUTURE,
  };

  it("marca (accountId, conversationId) após o re-sync da conversa", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      CONTA_MAGALU as any,
    );
    vi.spyOn(QuestionRepository, "getConversationCustomer").mockResolvedValue({
      externalBuyerId: "cust-1",
      buyerNickname: "Maria",
    });
    vi.spyOn(MagaluChatApiService, "replyMessage").mockResolvedValue({
      id: "m9",
    } as any);
    vi.spyOn(MagaluChatApiService, "listMessages").mockResolvedValue({
      messages: [],
      total: 0,
    } as any);
    const marcarLida = vi
      .spyOn(QuestionRepository, "markConversationRead")
      .mockResolvedValue(2);

    await MessagesUseCase.sendMagaluMessage(
      "user-1",
      "acc-mg",
      "conv-1",
      "Bom dia!",
    );

    expect(marcarLida).toHaveBeenCalledWith("acc-mg", "conv-1", "user-1");
  });

  it("falha ao marcar NÃO derruba o envio", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      CONTA_MAGALU as any,
    );
    vi.spyOn(QuestionRepository, "getConversationCustomer").mockResolvedValue({
      externalBuyerId: "cust-1",
      buyerNickname: "Maria",
    });
    vi.spyOn(MagaluChatApiService, "replyMessage").mockResolvedValue({
      id: "m9",
    } as any);
    vi.spyOn(MagaluChatApiService, "listMessages").mockResolvedValue({
      messages: [],
      total: 0,
    } as any);
    vi.spyOn(QuestionRepository, "markConversationRead").mockRejectedValue(
      new Error("pool esgotado"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      MessagesUseCase.sendMagaluMessage("user-1", "acc-mg", "conv-1", "Bom dia!"),
    ).resolves.toEqual({ success: true });
  });
});
