import { describe, it, expect, vi, afterEach } from "vitest";

import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import prisma from "@/app/lib/prisma";

/**
 * Testa a montagem do escopo de conta em listConversations:
 *   - com marketplaceAccountId  -> where.marketplaceAccountId (legado)
 *   - sem marketplaceAccountId  -> where.marketplaceAccount.userId (todas)
 *
 * Estratégia: mockar o primeiro groupBy retornando [] faz a função
 * retornar cedo ({ items: [], total: 0 }) — suficiente para inspecionar
 * o `where` que foi passado, sem tocar no banco.
 */
describe("QuestionRepository.listConversations — escopo de conta", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("conta específica: filtra por marketplaceAccountId (comportamento legado)", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "groupBy")
      .mockResolvedValue([] as any);

    const res = await QuestionRepository.listConversations({
      userId: "user-1",
      marketplaceAccountId: "acc-123",
      status: "all",
    });

    expect(res).toEqual({ items: [], total: 0 });
    const firstCallWhere = (spy.mock.calls[0][0] as any).where;
    expect(firstCallWhere).toEqual({ marketplaceAccountId: "acc-123" });
    expect(firstCallWhere.marketplaceAccount).toBeUndefined();
  });

  it("todas as contas: filtra por marketplaceAccount.userId (sem accountId)", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "groupBy")
      .mockResolvedValue([] as any);

    await QuestionRepository.listConversations({
      userId: "user-1",
      marketplaceAccountId: undefined,
      status: "all",
    });

    const firstCallWhere = (spy.mock.calls[0][0] as any).where;
    expect(firstCallWhere).toEqual({
      marketplaceAccount: { userId: "user-1" },
    });
    expect(firstCallWhere.marketplaceAccountId).toBeUndefined();
  });

  it("preserva filtro de status junto do escopo (todas)", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "groupBy")
      .mockResolvedValue([] as any);

    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "unanswered",
    });

    const firstCallWhere = (spy.mock.calls[0][0] as any).where;
    expect(firstCallWhere.marketplaceAccount).toEqual({ userId: "user-1" });
    expect(firstCallWhere.status).toBe("UNANSWERED");
  });

  it("preserva filtro de search junto do escopo (conta específica)", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "groupBy")
      .mockResolvedValue([] as any);

    await QuestionRepository.listConversations({
      userId: "user-1",
      marketplaceAccountId: "acc-9",
      status: "all",
      search: "parafuso",
    });

    const firstCallWhere = (spy.mock.calls[0][0] as any).where;
    expect(firstCallWhere.marketplaceAccountId).toBe("acc-9");
    expect(firstCallWhere.OR).toEqual([
      { text: { contains: "parafuso", mode: "insensitive" } },
      { externalItemId: { contains: "parafuso", mode: "insensitive" } },
      { buyerNickname: { contains: "parafuso", mode: "insensitive" } },
    ]);
  });
});
