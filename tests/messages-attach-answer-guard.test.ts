import { describe, it, expect, vi, afterEach } from "vitest";

import {
  QuestionRepository,
  respostaJaGravada,
} from "@/app/marketplaces/repositories/question.repository";
import prisma from "@/app/lib/prisma";
import type { MLQuestion } from "@/app/marketplaces/types/ml-questions.types";

/**
 * Guarda de novidade do `attachAnswer`.
 *
 * O problema medido em produção (37 dias, pg_stat_statements): 28.709 execuções
 * do `attachAnswer` para 5.988 respostas distintas. A varredura shop-wide da
 * Shopee revê os MESMOS comentários a cada ciclo — 1.330 de 3.553 já
 * respondidos — e cada um refazia BEGIN + upsert da resposta + update da
 * pergunta + COMMIT sem NADA ter mudado.
 *
 * O que fica travado aqui:
 *   1. resposta idêntica ⇒ o attachAnswer NÃO roda;
 *   2. qualquer divergência ⇒ ele roda inteiro, exatamente como antes;
 *   3. a leitura da guarda só acontece quando há resposta — pergunta sem
 *      resposta (a maioria) não paga query nenhuma a mais.
 */

// ===========================================================================
// Função pura
// ===========================================================================
describe("respostaJaGravada", () => {
  const DATA = new Date("2026-08-01T11:30:00.000Z");
  const GRAVADA = { text: "serve sim", status: "ACTIVE", dateCreated: DATA };
  const A_GRAVAR = { text: "serve sim", status: "ACTIVE", dateCreated: DATA };

  it("tudo igual e pergunta já em ANSWERED: pula a escrita", () => {
    expect(respostaJaGravada(GRAVADA, A_GRAVAR, "ANSWERED")).toBe(true);
  });

  it("compara por VALOR: instâncias diferentes de Date com o mesmo instante", () => {
    expect(
      respostaJaGravada(
        { ...GRAVADA, dateCreated: new Date(DATA.getTime()) },
        A_GRAVAR,
        "ANSWERED",
      ),
    ).toBe(true);
  });

  it("pergunta NÃO vai ficar em ANSWERED: escreve (o carimbo de status importa)", () => {
    // O attachAnswer também faz `update status = ANSWERED`. Pular aqui deixaria
    // a pergunta com resposta anexada e status divergente.
    expect(respostaJaGravada(GRAVADA, A_GRAVAR, "UNANSWERED")).toBe(false);
    expect(respostaJaGravada(GRAVADA, A_GRAVAR, "UNDER_REVIEW")).toBe(false);
  });

  it("sem resposta gravada (null/undefined): escreve", () => {
    expect(respostaJaGravada(null, A_GRAVAR, "ANSWERED")).toBe(false);
    expect(respostaJaGravada(undefined, A_GRAVAR, "ANSWERED")).toBe(false);
  });

  it("texto mudou (vendedor editou a resposta): escreve", () => {
    expect(
      respostaJaGravada(
        GRAVADA,
        { ...A_GRAVAR, text: "serve sim, com adaptador" },
        "ANSWERED",
      ),
    ).toBe(false);
  });

  it("status da resposta mudou (ACTIVE -> DELETED): escreve", () => {
    expect(
      respostaJaGravada(GRAVADA, { ...A_GRAVAR, status: "DELETED" }, "ANSWERED"),
    ).toBe(false);
  });

  it("data mudou, mesmo que por 1 ms: escreve", () => {
    expect(
      respostaJaGravada(
        GRAVADA,
        { ...A_GRAVAR, dateCreated: new Date(DATA.getTime() + 1) },
        "ANSWERED",
      ),
    ).toBe(false);
  });

  it("data inválida (NaN) dos DOIS lados: escreve, nunca se considera igual", () => {
    const invalida = new Date("nao-e-data");
    expect(
      respostaJaGravada(
        GRAVADA,
        { ...A_GRAVAR, dateCreated: invalida },
        "ANSWERED",
      ),
    ).toBe(false);
    expect(
      respostaJaGravada(
        { ...GRAVADA, dateCreated: invalida },
        { ...A_GRAVAR, dateCreated: invalida },
        "ANSWERED",
      ),
    ).toBe(false);
  });
});

// ===========================================================================
// Shopee — o caminho de maior volume
// ===========================================================================
describe("upsertFromShopeeComment — guarda de novidade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const COMENTARIO = {
    comment_id: 777,
    comment: "chega em quantos dias?",
    buyer_username: "carla",
    item_id: 9002,
    create_time: 1_750_000_000,
    comment_reply: { reply: "3 dias úteis", create_time: 1_750_000_100 },
  };

  const RESPOSTA_GRAVADA = {
    text: "3 dias úteis",
    status: "ACTIVE",
    dateCreated: new Date(1_750_000_100 * 1000),
  };

  function montar(respostaGravada: unknown) {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue({
      id: "q-existente",
    } as any);
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    const findFirst = vi
      .spyOn(prisma.marketplaceAnswer, "findFirst")
      .mockResolvedValue(respostaGravada as any);
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q-existente" } as any);
    const attach = vi
      .spyOn(QuestionRepository, "attachAnswer")
      .mockResolvedValue(undefined as any);
    return { findFirst, upsert, attach };
  }

  it("re-varredura com a MESMA resposta: não reescreve nada", async () => {
    const { attach } = montar(RESPOSTA_GRAVADA);

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(attach).not.toHaveBeenCalled();
  });

  it("pular o attachAnswer NÃO altera o upsert da pergunta", async () => {
    // O contrato do upsert é o mesmo com e sem a guarda: a lista de conversas
    // e o lastSyncedAt continuam se comportando igual.
    const { upsert } = montar(RESPOSTA_GRAVADA);

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.update.status).toBe("ANSWERED");
    expect(Object.keys(arg.update).sort()).toEqual([
      "buyerNickname",
      "lastSyncedAt",
      "productListingId",
      "status",
      "text",
    ]);
  });

  it("vendedor editou a resposta na Shopee: escreve", async () => {
    const { attach } = montar({
      ...RESPOSTA_GRAVADA,
      text: "2 dias úteis",
    });

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][1].text).toBe("3 dias úteis");
  });

  it("primeira vez (nada gravado): escreve, como sempre fez", async () => {
    const { attach } = montar(null);

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("reply sem create_time também converge: 2º ciclo não reescreve", async () => {
    // Sem create_time a data cai na do comentário — dos dois lados. Se as duas
    // pontas não usassem a mesma regra, a guarda nunca fecharia.
    const { attach } = montar({
      text: "3 dias úteis",
      status: "ACTIVE",
      dateCreated: new Date(1_750_000_000 * 1000),
    });

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis" },
    });

    expect(attach).not.toHaveBeenCalled();
  });

  it("comentário SEM resposta não paga a leitura da guarda", async () => {
    const { findFirst, attach } = montar(null);

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: null,
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("a leitura da guarda vai pela chave EXTERNA (roda em paralelo)", async () => {
    // Se dependesse do id interno teria de esperar o findUnique — seria uma ida
    // ao banco a mais no caminho crítico, não zero.
    const { findFirst } = montar(RESPOSTA_GRAVADA);

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0]).toEqual({
      where: {
        question: {
          marketplaceAccountId: "acc-1",
          externalQuestionId: "777",
        },
      },
      select: { text: true, status: true, dateCreated: true },
    });
  });
});

// ===========================================================================
// Mercado Livre
// ===========================================================================
describe("upsertFromMl — guarda de novidade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const RESPONDIDA: MLQuestion = {
    id: 123456789,
    text: "esse farol serve no Gol G5?",
    status: "ANSWERED",
    date_created: "2026-08-01T10:00:00.000Z",
    item_id: "MLB1234567890",
    seller_id: 999,
    from: { id: 555, nickname: "COMPRADOR123" },
    answer: {
      text: "serve sim",
      status: "ACTIVE",
      date_created: "2026-08-01T11:30:00.000Z",
    },
  };

  const RESPOSTA_GRAVADA = {
    text: "serve sim",
    status: "ACTIVE",
    dateCreated: new Date("2026-08-01T11:30:00.000Z"),
  };

  function montar(respostaGravada: unknown) {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue({
      id: "q-existente",
    } as any);
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    const findFirst = vi
      .spyOn(prisma.marketplaceAnswer, "findFirst")
      .mockResolvedValue(respostaGravada as any);
    vi.spyOn(prisma.marketplaceQuestion, "upsert").mockResolvedValue({
      id: "q-existente",
    } as any);
    const attach = vi
      .spyOn(QuestionRepository, "attachAnswer")
      .mockResolvedValue(undefined as any);
    return { findFirst, attach };
  }

  it("pull do histórico do anúncio com a MESMA resposta: não reescreve", async () => {
    const { attach } = montar(RESPOSTA_GRAVADA);

    await QuestionRepository.upsertFromMl("acc-1", RESPONDIDA);

    expect(attach).not.toHaveBeenCalled();
  });

  it("resposta editada no ML: escreve", async () => {
    const { attach } = montar({
      ...RESPOSTA_GRAVADA,
      text: "serve com ressalva",
    });

    await QuestionRepository.upsertFromMl("acc-1", RESPONDIDA);

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("resposta igual mas pergunta em UNDER_REVIEW: escreve (carimba o status)", async () => {
    const { attach } = montar(RESPOSTA_GRAVADA);

    await QuestionRepository.upsertFromMl("acc-1", {
      ...RESPONDIDA,
      status: "UNDER_REVIEW",
    });

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("pergunta SEM resposta não paga a leitura da guarda", async () => {
    const { findFirst, attach } = montar(null);

    await QuestionRepository.upsertFromMl("acc-1", {
      ...RESPONDIDA,
      status: "UNANSWERED",
      answer: null,
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("resposta de texto vazio não paga a leitura da guarda", async () => {
    const { findFirst, attach } = montar(null);

    await QuestionRepository.upsertFromMl("acc-1", {
      ...RESPONDIDA,
      answer: {
        text: "",
        status: "ACTIVE",
        date_created: "2026-08-01T11:30:00.000Z",
      },
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
});
