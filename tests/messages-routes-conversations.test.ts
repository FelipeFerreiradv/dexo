import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

import { messagesRoutes } from "@/app/routes/messages.routes";
import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(messagesRoutes, { prefix: "/messages" });
  return app;
};

const FAKE_USER = { id: "user-1", email: "u@x.com" };
const EMPTY = { items: [], total: 0 };

describe("GET /messages/conversations — filtro Todas as contas", () => {
  beforeEach(() => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue(
      FAKE_USER as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("conta específica: valida ownership e passa marketplaceAccountId (legado)", async () => {
    const spyFind = vi
      .spyOn(MarketplaceRepository, "findByIdAndUser")
      .mockResolvedValue({ id: "acc-1", userId: "user-1" } as any);
    const spyList = vi
      .spyOn(QuestionRepository, "listConversations")
      .mockResolvedValue(EMPTY as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=acc-1&status=all",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(spyFind).toHaveBeenCalledWith("acc-1", "user-1");
    expect(spyList).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        marketplaceAccountId: "acc-1",
      }),
    );
    await app.close();
  });

  it("accountId=all: NÃO valida conta e passa marketplaceAccountId undefined + userId", async () => {
    const spyFind = vi.spyOn(MarketplaceRepository, "findByIdAndUser");
    const spyList = vi
      .spyOn(QuestionRepository, "listConversations")
      .mockResolvedValue(EMPTY as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=all&status=all",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(spyFind).not.toHaveBeenCalled();
    expect(spyList).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        marketplaceAccountId: undefined,
      }),
    );
    await app.close();
  });

  it("accountId ausente: trata como 'todas' (não retorna mais 400)", async () => {
    const spyFind = vi.spyOn(MarketplaceRepository, "findByIdAndUser");
    const spyList = vi
      .spyOn(QuestionRepository, "listConversations")
      .mockResolvedValue(EMPTY as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?status=all",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(spyFind).not.toHaveBeenCalled();
    expect(spyList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", marketplaceAccountId: undefined }),
    );
    await app.close();
  });

  it("conta de outro usuário: 404 (autorização inalterada)", async () => {
    vi.spyOn(MarketplaceRepository, "findByIdAndUser").mockResolvedValue(
      null as any,
    );
    const spyList = vi.spyOn(QuestionRepository, "listConversations");

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=acc-de-outro&status=all",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(404);
    expect(spyList).not.toHaveBeenCalled();
    await app.close();
  });

  it("status inválido: 400", async () => {
    vi.spyOn(QuestionRepository, "listConversations").mockResolvedValue(
      EMPTY as any,
    );

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=all&status=foo",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("não autenticado (sem email): 401", async () => {
    const spyList = vi.spyOn(QuestionRepository, "listConversations");

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=all",
    });

    expect(res.statusCode).toBe(401);
    expect(spyList).not.toHaveBeenCalled();
    await app.close();
  });
});
