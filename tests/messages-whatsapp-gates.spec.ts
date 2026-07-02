import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

import prisma from "@/app/lib/prisma";
import { messagesRoutes } from "@/app/routes/messages.routes";
import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { WhatsAppRepository } from "@/app/marketplaces/repositories/whatsapp.repository";
import { WhatsAppInboxRepository } from "@/app/marketplaces/repositories/whatsapp-inbox.repository";
import { WhatsAppMessagesUseCase } from "@/app/marketplaces/usecases/whatsapp-messages.usecase";
import { clearWhatsappEntitlementCache } from "@/app/marketplaces/whatsapp/whatsapp-entitlement.service";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";

/**
 * Matriz de gates do canal WhatsApp nas rotas /messages/* existentes:
 *   - flag global OFF  ⇒ respostas byte-idênticas ao legado (zero traço);
 *   - flag ON + tenant SEM plano ⇒ idem (400/404; nenhum dado do canal);
 *   - flag ON + tenant COM plano ⇒ branches aditivos funcionam.
 * É a prova executável da regra "zero regressão" da inbox unificada.
 */

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(messagesRoutes, { prefix: "/messages" });
  return app;
};

const waAccount = {
  id: "wa-acc-1",
  wabaId: "waba-1",
  phoneNumberId: "555000111",
  displayPhoneNumber: "5511999990000",
  verifiedName: "Loja",
  status: "ACTIVE",
  createdAt: new Date(),
} as any;

const waSummary = (over: Partial<Record<string, unknown>> = {}) => ({
  externalItemId: "conv-1",
  marketplaceAccountId: "wa:wa-acc-1",
  accountName: "5511999990000",
  accountPlatform: "WHATSAPP",
  productListingId: null,
  listingTitle: null,
  listingThumbnail: null,
  listingPermalink: null,
  productSku: null,
  buyerNickname: "João",
  lastQuestionText: "olá",
  lastQuestionAt: new Date("2026-07-01T12:00:00Z"),
  lastAnswerText: null,
  lastAnswerAt: null,
  unreadCount: 1,
  hasUnanswered: true,
  ...over,
});

const setEntitled = (enabled: boolean) => {
  vi.spyOn(prisma.user, "findUnique").mockResolvedValue({
    whatsappEnabledAt: enabled ? new Date() : null,
  } as any);
};

describe("Gates WhatsApp nas rotas /messages/*", () => {
  beforeEach(() => {
    clearWhatsappEntitlementCache();
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "u@x.com",
    } as any);
    // Contas de marketplace vazias por padrão (foco nos gates do canal).
    vi.spyOn(
      MarketplaceRepository,
      "findAllByUserIdAndPlatform",
    ).mockResolvedValue([] as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // FLAG GLOBAL OFF — app idêntico ao legado
  // =========================================================================
  describe("flag global OFF", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "");
    });

    it("GET /accounts: resposta SEM o campo whatsappEnabled (shape legado)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/accounts",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ accounts: [] });
      expect("whatsappEnabled" in body).toBe(false);
      await app.close();
    });

    it("GET /conversations?platform=WHATSAPP: 400 igual a qualquer platform inválido", async () => {
      const waSpy = vi.spyOn(WhatsAppInboxRepository, "listConversations");

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=all&platform=WHATSAPP",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("platform inválido");
      expect(waSpy).not.toHaveBeenCalled();
      await app.close();
    });

    it("GET /conversations all/all: NÃO consulta o canal (sem merge)", async () => {
      const mktSpy = vi
        .spyOn(QuestionRepository, "listConversations")
        .mockResolvedValue({ items: [], total: 0 } as any);
      const waSpy = vi.spyOn(WhatsAppInboxRepository, "listConversations");

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=all",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(200);
      expect(mktSpy).toHaveBeenCalledTimes(1);
      expect(waSpy).not.toHaveBeenCalled();
      await app.close();
    });

    it("GET /unread-count: só a contagem de marketplace", async () => {
      vi.spyOn(QuestionRepository, "countUnreadForUser").mockResolvedValue(5);
      const waSpy = vi.spyOn(WhatsAppInboxRepository, "countUnreadForUser");

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/unread-count",
        headers: { email: "u@x.com" },
      });

      expect(res.json()).toEqual({ count: 5 });
      expect(waSpy).not.toHaveBeenCalled();
      await app.close();
    });
  });

  // =========================================================================
  // FLAG ON + tenant SEM plano — zero traço do canal
  // =========================================================================
  describe("flag ON + tenant sem plano", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
      setEntitled(false);
    });

    it("GET /accounts: whatsappEnabled=false e NENHUMA conta wa:", async () => {
      const waSpy = vi.spyOn(WhatsAppRepository, "findActiveByUserId");

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/accounts",
        headers: { email: "u@x.com" },
      });

      expect(res.json()).toEqual({ accounts: [], whatsappEnabled: false });
      expect(waSpy).not.toHaveBeenCalled();
      await app.close();
    });

    it("GET /conversations?platform=WHATSAPP: 400 (valor não existe p/ este tenant)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=all&platform=WHATSAPP",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("POST /answers com accountId wa:: 404 (conta não existe p/ este tenant)", async () => {
      const sendSpy = vi.spyOn(WhatsAppMessagesUseCase, "sendText");

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/messages/answers",
        headers: { email: "u@x.com", "content-type": "application/json" },
        payload: { accountId: "wa:wa-acc-1", itemId: "conv-1", text: "oi" },
      });

      expect(res.statusCode).toBe(404);
      expect(sendSpy).not.toHaveBeenCalled();
      await app.close();
    });
  });

  // =========================================================================
  // FLAG ON + tenant COM plano — canal funcionando
  // =========================================================================
  describe("flag ON + tenant com plano", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED", "true");
      setEntitled(true);
    });

    it("GET /accounts: inclui números com id prefixado wa: e platform WHATSAPP", async () => {
      vi.spyOn(WhatsAppRepository, "findActiveByUserId").mockResolvedValue([
        waAccount,
      ]);

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/accounts",
        headers: { email: "u@x.com" },
      });

      const body = res.json();
      expect(body.whatsappEnabled).toBe(true);
      expect(body.accounts).toEqual([
        {
          id: "wa:wa-acc-1",
          accountName: "5511999990000",
          status: "ACTIVE",
          platform: "WHATSAPP",
        },
      ]);
      await app.close();
    });

    it("GET /conversations?platform=WHATSAPP: consulta SÓ o canal", async () => {
      const waSpy = vi
        .spyOn(WhatsAppInboxRepository, "listConversations")
        .mockResolvedValue({ items: [waSummary() as any], total: 1 });
      const mktSpy = vi.spyOn(QuestionRepository, "listConversations");

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=all&platform=WHATSAPP",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(1);
      expect(waSpy).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", status: "all" }),
      );
      expect(mktSpy).not.toHaveBeenCalled();
      await app.close();
    });

    it("GET /conversations com accountId wa:: valida posse e filtra pela conta", async () => {
      vi.spyOn(WhatsAppRepository, "findByIdAndUser").mockResolvedValue(
        waAccount,
      );
      const waSpy = vi
        .spyOn(WhatsAppInboxRepository, "listConversations")
        .mockResolvedValue({ items: [], total: 0 });

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=wa%3Awa-acc-1",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(200);
      expect(WhatsAppRepository.findByIdAndUser).toHaveBeenCalledWith(
        "wa-acc-1",
        "user-1",
      );
      expect(waSpy).toHaveBeenCalledWith(
        expect.objectContaining({ whatsAppAccountId: "wa-acc-1" }),
      );
      await app.close();
    });

    it("GET /conversations com conta wa: de OUTRO tenant: 404 (multi-tenant)", async () => {
      vi.spyOn(WhatsAppRepository, "findByIdAndUser").mockResolvedValue(null);
      const waSpy = vi.spyOn(WhatsAppInboxRepository, "listConversations");

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=wa%3Aalheia",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(404);
      expect(waSpy).not.toHaveBeenCalled();
      await app.close();
    });

    it("GET /conversations all/all: merge marketplace+WhatsApp ordenado por recência", async () => {
      vi.spyOn(QuestionRepository, "listConversations").mockResolvedValue({
        items: [
          waSummary({
            externalItemId: "MLB1",
            marketplaceAccountId: "acc-ml",
            accountPlatform: "MERCADO_LIVRE",
            lastQuestionAt: new Date("2026-07-01T10:00:00Z"),
          }),
        ],
        total: 1,
      } as any);
      vi.spyOn(WhatsAppInboxRepository, "listConversations").mockResolvedValue({
        items: [
          waSummary({ lastQuestionAt: new Date("2026-07-01T12:00:00Z") }) as any,
        ],
        total: 1,
      });

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations?accountId=all",
        headers: { email: "u@x.com" },
      });

      const body = res.json();
      expect(body.total).toBe(2);
      // WhatsApp (12:00) vem antes do ML (10:00)
      expect(body.items.map((i: any) => i.externalItemId)).toEqual([
        "conv-1",
        "MLB1",
      ]);
      await app.close();
    });

    it("GET /conversations/:itemId com wa:: shape legado + campo aditivo whatsapp", async () => {
      vi.spyOn(WhatsAppRepository, "findByIdAndUser").mockResolvedValue(
        waAccount,
      );
      vi.spyOn(WhatsAppInboxRepository, "listMessages").mockResolvedValue({
        conversation: {
          id: "conv-1",
          contactWaId: "5547988887777",
          contactName: "João",
          serviceWindowExpiresAt: new Date("2026-07-02T12:00:00Z"),
          unreadCount: 0,
        },
        messages: [
          {
            id: "m1",
            externalQuestionId: "wamid.1",
            text: "olá",
            status: "ANSWERED",
            dateCreated: new Date("2026-07-01T12:00:00Z"),
            buyerNickname: "João",
            readAt: null,
            authorType: "CUSTOMER",
            answer: null,
            deliveryStatus: null,
            errorCode: null,
            mediaType: null,
            mediaMimeType: null,
            mediaUrl: null,
          },
        ],
      });

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/conversations/conv-1?accountId=wa%3Awa-acc-1",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.listing).toBeNull();
      expect(body.questions).toHaveLength(1);
      expect(body.questions[0].authorType).toBe("CUSTOMER");
      expect(body.whatsapp.windowExpiresAt).toBe("2026-07-02T12:00:00.000Z");
      await app.close();
    });

    it("POST /answers wa:: despacha p/ o usecase do canal e propaga 409 da janela", async () => {
      const err: any = new Error(
        "A janela de atendimento de 24h fechou — aguarde o cliente enviar uma nova mensagem",
      );
      err.statusCode = 409;
      const sendSpy = vi
        .spyOn(WhatsAppMessagesUseCase, "sendText")
        .mockRejectedValue(err);

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/messages/answers",
        headers: { email: "u@x.com", "content-type": "application/json" },
        payload: { accountId: "wa:wa-acc-1", itemId: "conv-1", text: "oi" },
      });

      expect(res.statusCode).toBe(409);
      expect(sendSpy).toHaveBeenCalledWith("user-1", "wa-acc-1", "conv-1", "oi");
      await app.close();
    });

    it("POST /answers wa: sem itemId: 400", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/messages/answers",
        headers: { email: "u@x.com", "content-type": "application/json" },
        payload: { accountId: "wa:wa-acc-1", text: "oi" },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("GET /unread-count: soma marketplace + canal", async () => {
      vi.spyOn(QuestionRepository, "countUnreadForUser").mockResolvedValue(5);
      vi.spyOn(WhatsAppInboxRepository, "countUnreadForUser").mockResolvedValue(
        3,
      );

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/messages/unread-count",
        headers: { email: "u@x.com" },
      });

      expect(res.json()).toEqual({ count: 8 });
      await app.close();
    });

    it("POST /conversations/:itemId/sync com wa: (conta do tenant): no-op de sucesso (sem pull)", async () => {
      vi.spyOn(WhatsAppRepository, "findByIdAndUser").mockResolvedValue(
        waAccount,
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/messages/conversations/conv-1/sync?accountId=wa%3Awa-acc-1",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ synced: 0, total: 0 });
      await app.close();
    });

    it("POST /conversations/:itemId/sync com wa: de OUTRO tenant: 404 (posse)", async () => {
      vi.spyOn(WhatsAppRepository, "findByIdAndUser").mockResolvedValue(null);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/messages/conversations/conv-1/sync?accountId=wa%3Aalheia",
        headers: { email: "u@x.com" },
      });

      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
