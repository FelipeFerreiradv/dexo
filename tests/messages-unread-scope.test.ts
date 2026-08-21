import { describe, it, expect, vi, afterEach } from "vitest";

import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import prisma from "@/app/lib/prisma";

/**
 * Escopo do contador de não lidas (Bloco C do diagnóstico de 21/08/2026).
 *
 * Dois defeitos, um sintoma:
 *   H3 — `markConversationRead` marcava por (conta, item), mas o `unreadCount`
 *        somava TODAS as contas do usuário para aquele `externalItemId`. Com o
 *        mesmo item em duas contas (8 pares em produção), o clique zerava uma e
 *        a outra voltava no poll seguinte.
 *   H6 — o badge somava contas em ERROR/INACTIVE (792 linhas) e estados
 *        terminais (121), números que NENHUMA sequência de cliques derruba.
 *
 * Tudo atrás de `MESSAGES_UNREAD_SCOPE_LEGACY=1`, que restaura a semântica
 * antiga sem deploy.
 */

const TERMINAIS = ["CLOSED_UNANSWERED", "BANNED", "DELETED"];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MESSAGES_UNREAD_SCOPE_LEGACY;
});

describe("markConversationRead — escopo da marcação", () => {
  it("com userId: marca o item em TODAS as contas do usuário (escopo do groupBy)", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "updateMany")
      .mockResolvedValue({ count: 3 } as any);

    const n = await QuestionRepository.markConversationRead(
      "acc-1",
      "MLB999",
      "user-1",
    );

    expect(n).toBe(3);
    const arg = spy.mock.calls[0][0] as any;
    expect(arg.where).toEqual({
      externalItemId: "MLB999",
      readAt: null,
      marketplaceAccount: { userId: "user-1" },
    });
    // Isolamento entre tenants: o filtro por usuário é obrigatório, senão um
    // externalItemId compartilhado entre usuários seria marcado junto.
    expect(arg.where.marketplaceAccount.userId).toBe("user-1");
  });

  it("sem userId: where legado, byte-idêntico ao de antes", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "updateMany")
      .mockResolvedValue({ count: 1 } as any);

    await QuestionRepository.markConversationRead("acc-1", "MLB999");

    const arg = spy.mock.calls[0][0] as any;
    expect(arg.where).toEqual({
      marketplaceAccountId: "acc-1",
      externalItemId: "MLB999",
      readAt: null,
    });
  });

  it("sempre grava readAt e nada mais", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "updateMany")
      .mockResolvedValue({ count: 1 } as any);

    await QuestionRepository.markConversationRead("acc-1", "MLB999", "user-1");

    const arg = spy.mock.calls[0][0] as any;
    expect(Object.keys(arg.data)).toEqual(["readAt"]);
    expect(arg.data.readAt).toBeInstanceOf(Date);
  });
});

describe("countUnreadForUser — escopo do badge da sidebar", () => {
  it("conta só contas ATIVAS e perguntas que ainda admitem resposta", async () => {
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "count")
      .mockResolvedValue(7 as any);

    const n = await QuestionRepository.countUnreadForUser("user-1");

    expect(n).toBe(7);
    const arg = spy.mock.calls[0][0] as any;
    expect(arg.where).toEqual({
      readAt: null,
      status: { notIn: TERMINAIS },
      marketplaceAccount: { userId: "user-1", status: "ACTIVE" },
    });
  });

  it("kill-switch ligado: volta ao where legado (todas as contas, sem exclusões)", async () => {
    process.env.MESSAGES_UNREAD_SCOPE_LEGACY = "1";
    const spy = vi
      .spyOn(prisma.marketplaceQuestion, "count")
      .mockResolvedValue(1383 as any);

    await QuestionRepository.countUnreadForUser("user-1");

    const arg = spy.mock.calls[0][0] as any;
    expect(arg.where).toEqual({
      readAt: null,
      marketplaceAccount: { userId: "user-1" },
    });
  });
});

describe("listConversations — o filtro Não lidas conta o MESMO que o badge", () => {
  /**
   * Corta a função cedo: o primeiro groupBy vazio faz ela retornar.
   *
   * O `any` é necessário — as sobrecargas do `groupBy` do Prisma fazem o TS
   * inferir `never` para o método espionado (mesmo motivo dos 4 erros que
   * `tests/question-repository-conversations.test.ts` já carrega no baseline).
   */
  function espiarGroupBy(): any {
    const spy: any = vi.spyOn(prisma.marketplaceQuestion, "groupBy");
    spy.mockResolvedValue([]);
    return spy;
  }

  it('"todas as contas": restringe a contas ATIVAS, igual ao badge', async () => {
    const spy = espiarGroupBy();

    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "all",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.marketplaceAccount).toEqual({
      userId: "user-1",
      status: "ACTIVE",
    });
  });

  it("conta ESPECÍFICA: comportamento legado intacto (conta em ERROR ainda abre)", async () => {
    const spy = espiarGroupBy();

    await QuestionRepository.listConversations({
      userId: "user-1",
      marketplaceAccountId: "acc-em-erro",
      status: "all",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.marketplaceAccountId).toBe("acc-em-erro");
    // Sem restrição de status da conta: escolher a conta a dedo continua
    // mostrando tudo dela, que é o que permite diagnosticar.
    expect(where.marketplaceAccount).toBeUndefined();
  });

  it('filtro "Não lidas" exclui os estados terminais', async () => {
    const spy = espiarGroupBy();

    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "unread",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.readAt).toBeNull();
    expect(where.status).toEqual({ notIn: TERMINAIS });
  });

  it("kill-switch ligado: sem restrição de conta ativa nem de terminais", async () => {
    process.env.MESSAGES_UNREAD_SCOPE_LEGACY = "1";
    const spy = espiarGroupBy();

    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "unread",
    });

    const where = (spy.mock.calls[0][0] as any).where;
    expect(where.marketplaceAccount).toEqual({ userId: "user-1" });
    expect(where.readAt).toBeNull();
    expect(where.status).toBeUndefined();
  });

  it('filtros "Sem resposta"/"Respondidas" seguem inalterados', async () => {
    const spy = espiarGroupBy();

    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "unanswered",
    });
    expect((spy.mock.calls[0][0] as any).where.status).toBe("UNANSWERED");

    spy.mockClear();
    await QuestionRepository.listConversations({
      userId: "user-1",
      status: "answered",
    });
    expect((spy.mock.calls[0][0] as any).where.status).toBe("ANSWERED");
  });
});
