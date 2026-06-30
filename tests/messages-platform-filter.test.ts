import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { Platform } from "@prisma/client";

import { messagesRoutes } from "@/app/routes/messages.routes";
import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import { MarketplaceRepository } from "@/app/marketplaces/repositories/marketplace.repository";
import { UserRepositoryPrisma } from "@/app/repositories/user.repository";
import prisma from "@/app/lib/prisma";

// ===========================================================================
// QuestionRepository.listConversations — filtro de plataforma (where)
// ===========================================================================
describe("QuestionRepository.listConversations — filtro de plataforma", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("todas as contas + plataforma: relação tem userId + platform", async () => {
    const spy: any = vi.spyOn(prisma.marketplaceQuestion, "groupBy");
    spy.mockResolvedValue([]);

    await QuestionRepository.listConversations({
      userId: "user-1",
      platform: Platform.SHOPEE,
      status: "all",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.marketplaceAccount).toEqual({
      userId: "user-1",
      platform: "SHOPEE",
    });
    expect(where.marketplaceAccountId).toBeUndefined();
  });

  it("conta específica + plataforma: marketplaceAccountId + relação platform", async () => {
    const spy: any = vi.spyOn(prisma.marketplaceQuestion, "groupBy");
    spy.mockResolvedValue([]);

    await QuestionRepository.listConversations({
      userId: "user-1",
      marketplaceAccountId: "acc-9",
      platform: Platform.MAGALU,
      status: "all",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.marketplaceAccountId).toBe("acc-9");
    // userId NÃO entra na relação quando a conta é específica (já validada na rota)
    expect(where.marketplaceAccount).toEqual({ platform: "MAGALU" });
  });

  it("sem plataforma: relação só com userId (comportamento legado)", async () => {
    const spy: any = vi.spyOn(prisma.marketplaceQuestion, "groupBy");
    spy.mockResolvedValue([]);

    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "all",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.marketplaceAccount).toEqual({ userId: "user-1" });
  });
});

// ===========================================================================
// Rota /messages/conversations — querystring platform
// ===========================================================================
const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(messagesRoutes, { prefix: "/messages" });
  return app;
};

describe("GET /messages/conversations — platform", () => {
  beforeEach(() => {
    vi.spyOn(UserRepositoryPrisma.prototype, "findByEmail").mockResolvedValue({
      id: "user-1",
      email: "u@x.com",
    } as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("platform=SHOPEE: repassa a plataforma ao repositório", async () => {
    const spy = vi
      .spyOn(QuestionRepository, "listConversations")
      .mockResolvedValue({ items: [], total: 0 } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=all&platform=SHOPEE",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ platform: Platform.SHOPEE }),
    );
    await app.close();
  });

  it("platform=all: não filtra (platform undefined)", async () => {
    const spy = vi
      .spyOn(QuestionRepository, "listConversations")
      .mockResolvedValue({ items: [], total: 0 } as any);

    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=all&platform=all",
      headers: { email: "u@x.com" },
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ platform: undefined }),
    );
    await app.close();
  });

  it("platform inválido: 400", async () => {
    const spy = vi.spyOn(QuestionRepository, "listConversations");
    vi.spyOn(MarketplaceRepository, "findByIdAndUser");

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages/conversations?accountId=all&platform=BANANA",
      headers: { email: "u@x.com" },
    });

    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });
});
