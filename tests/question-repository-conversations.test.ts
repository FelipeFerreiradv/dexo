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
 *
 * ATUALIZADO em 21/08/2026 (Bloco C do diagnóstico do badge de não lidas): em
 * modo "todas as contas" o escopo passou a excluir contas não-ACTIVE, para que
 * o agregado mostre só o que o usuário consegue abrir — em produção havia 792
 * não lidas em contas ERROR/INACTIVE, impossíveis de zerar. Com uma conta
 * escolhida a dedo, NADA muda. O contrato antigo continua provado abaixo, sob
 * o kill-switch MESSAGES_UNREAD_SCOPE_LEGACY=1.
 */
describe("QuestionRepository.listConversations — escopo de conta", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MESSAGES_UNREAD_SCOPE_LEGACY;
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

  it("todas as contas: filtra por marketplaceAccount.userId + conta ATIVA", async () => {
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
      marketplaceAccount: { userId: "user-1", status: "ACTIVE" },
    });
    expect(firstCallWhere.marketplaceAccountId).toBeUndefined();
  });

  it("kill-switch ligado: volta ao escopo legado, byte-idêntico", async () => {
    process.env.MESSAGES_UNREAD_SCOPE_LEGACY = "1";
    // `any` explícito: as sobrecargas do groupBy do Prisma fazem o TS inferir
    // `never` para o método espionado. Os 4 casos acima carregam esse erro no
    // baseline do tsc; este caso é novo e não deve aumentá-lo.
    const spy: any = vi.spyOn(prisma.marketplaceQuestion, "groupBy");
    spy.mockResolvedValue([]);

    await QuestionRepository.listConversations({
      userId: "user-1",
      marketplaceAccountId: undefined,
      status: "all",
    });

    // Este é o contrato que valia antes de 21/08/2026 — reverter é `.env` +
    // restart da API, sem deploy.
    expect((spy.mock.calls[0][0] as any).where).toEqual({
      marketplaceAccount: { userId: "user-1" },
    });
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
    expect(firstCallWhere.marketplaceAccount).toEqual({
      userId: "user-1",
      status: "ACTIVE",
    });
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
