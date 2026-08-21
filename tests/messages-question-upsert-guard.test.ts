import { describe, it, expect, vi, afterEach } from "vitest";

import {
  CAMPOS_REESCRITOS_NA_PERGUNTA,
  QuestionRepository,
  perguntaJaGravada,
} from "@/app/marketplaces/repositories/question.repository";
import prisma from "@/app/lib/prisma";
import type { MLQuestion } from "@/app/marketplaces/types/ml-questions.types";

/**
 * Guarda de novidade do upsert de PERGUNTA (ML e Shopee).
 *
 * O problema medido em produção (pg_stat_statements, 28,6 dias): o
 * `INSERT … ON CONFLICT` da pergunta acumulou 185.088 execuções para 9.556
 * perguntas. A varredura de catálogo revê os mesmos anúncios/comentários a cada
 * ciclo — uma passada da Shopee sozinha responde por ~3.553 — e reescrevia a
 * linha inteira mesmo sem nada ter mudado.
 *
 * O que fica travado aqui:
 *   1. conteúdo idêntico ⇒ o upsert NÃO roda;
 *   2. qualquer um dos 4 campos divergindo ⇒ ele roda inteiro, como antes;
 *   3. o caminho crítico de responder (UNANSWERED → ANSWERED) SEMPRE grava;
 *   4. a lista comparada e o objeto `update` não podem divergir (teste
 *      estrutural — é o erro que passaria despercebido);
 *   5. pular o upsert não interfere na guarda da RESPOSTA (PR anterior).
 */

const GRAVADA = {
  status: "ANSWERED",
  text: "esse farol serve no Gol G5?",
  productListingId: "listing-1",
  buyerNickname: "COMPRADOR123",
};

// ===========================================================================
// Função pura
// ===========================================================================
describe("perguntaJaGravada", () => {
  it("os 4 campos iguais: pula a escrita", () => {
    expect(perguntaJaGravada(GRAVADA, { ...GRAVADA })).toBe(true);
  });

  it("campos a mais no lado a gravar (baseData) não atrapalham", () => {
    // `baseData` carrega externalItemId, dateCreated etc. Nenhum deles entra no
    // ramo `update`, então nenhum pode influenciar a decisão.
    const baseData = {
      ...GRAVADA,
      marketplaceAccountId: "acc-1",
      externalQuestionId: "1",
      externalItemId: "MLB1",
      externalBuyerId: "555",
      dateCreated: new Date(),
    };
    expect(perguntaJaGravada(GRAVADA, baseData)).toBe(true);
  });

  it("sem linha gravada (null/undefined): escreve — é create", () => {
    expect(perguntaJaGravada(null, GRAVADA)).toBe(false);
    expect(perguntaJaGravada(undefined, GRAVADA)).toBe(false);
  });

  it("status mudou: escreve", () => {
    expect(
      perguntaJaGravada(GRAVADA, { ...GRAVADA, status: "UNANSWERED" }),
    ).toBe(false);
  });

  it("texto mudou: escreve", () => {
    expect(perguntaJaGravada(GRAVADA, { ...GRAVADA, text: "outro" })).toBe(
      false,
    );
  });

  it("anúncio local apareceu (null -> id): escreve", () => {
    expect(
      perguntaJaGravada(
        { ...GRAVADA, productListingId: null },
        { ...GRAVADA, productListingId: "listing-1" },
      ),
    ).toBe(false);
  });

  it("anúncio local sumiu (id -> null): escreve", () => {
    expect(
      perguntaJaGravada(GRAVADA, { ...GRAVADA, productListingId: null }),
    ).toBe(false);
  });

  it("nulo e string vazia NÃO são a mesma coisa", () => {
    // Comparação estrita: `null == ""` é falso em JS, e tem de continuar sendo.
    expect(
      perguntaJaGravada(
        { ...GRAVADA, buyerNickname: null },
        { ...GRAVADA, buyerNickname: "" },
      ),
    ).toBe(false);
  });

  it("apelido do comprador mudou: escreve", () => {
    expect(
      perguntaJaGravada(GRAVADA, { ...GRAVADA, buyerNickname: "OUTRO" }),
    ).toBe(false);
  });

  it("cada um dos 4 campos, sozinho, basta para escrever", () => {
    // Varre a própria lista: se um campo entrar nela sem ser comparado de
    // verdade, este teste denuncia.
    for (const campo of CAMPOS_REESCRITOS_NA_PERGUNTA) {
      const diferente = { ...GRAVADA, [campo]: "valor-diferente-de-proposito" };
      expect(perguntaJaGravada(GRAVADA, diferente)).toBe(false);
    }
  });
});

// ===========================================================================
// Teste ESTRUTURAL — o erro que passaria despercebido
// ===========================================================================
describe("a lista comparada cobre o objeto `update` inteiro", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Se alguém acrescentar um campo ao `update` e esquecer de acrescentá-lo à
   * CAMPOS_REESCRITOS_NA_PERGUNTA, a guarda passaria a pular uma escrita
   * necessária — sem quebrar nenhum outro teste. Este aqui quebra.
   */
  const esperado = [...CAMPOS_REESCRITOS_NA_PERGUNTA, "lastSyncedAt"].sort();

  function mockarComDivergencia() {
    // `existing` divergente força o upsert a rodar, que é o que queremos medir.
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue({
      id: "q1",
      status: "DIVERGENTE",
      text: "divergente",
      productListingId: null,
      buyerNickname: null,
    } as any);
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      null as any,
    );
    vi.spyOn(QuestionRepository, "attachAnswer").mockResolvedValue(
      undefined as any,
    );
    return vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q1" } as any);
  }

  it("Shopee", async () => {
    const upsert = mockarComDivergencia();

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      comment_id: 1,
      comment: "oi",
      buyer_username: "ana",
      item_id: 9,
      create_time: 1_750_000_000,
      comment_reply: null,
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(Object.keys(arg.update).sort()).toEqual(esperado);
  });

  it("Mercado Livre", async () => {
    const upsert = mockarComDivergencia();

    await QuestionRepository.upsertFromMl("acc-1", {
      id: 1,
      text: "oi",
      status: "UNANSWERED",
      date_created: "2026-08-01T10:00:00.000Z",
      item_id: "MLB1",
      seller_id: 9,
      from: { id: 5, nickname: "ana" },
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(Object.keys(arg.update).sort()).toEqual(esperado);
  });
});

// ===========================================================================
// Shopee — o caminho de maior volume
// ===========================================================================
describe("upsertFromShopeeComment — guarda de novidade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MESSAGES_QUESTION_UPSERT_LEGACY;
  });

  const COMENTARIO = {
    comment_id: 777,
    comment: "chega em quantos dias?",
    buyer_username: "carla",
    item_id: 9002,
    create_time: 1_750_000_000,
    comment_reply: null as { reply?: string; create_time?: number } | null,
  };

  /** O que o banco devolveria depois que este comentário já foi gravado. */
  const IDENTICA = {
    id: "q-existente",
    status: "UNANSWERED",
    text: "chega em quantos dias?",
    productListingId: null,
    buyerNickname: "carla",
  };

  function montar(
    existente: unknown,
    respostaGravada: unknown = null,
    listingId: string | null = null,
  ) {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      existente as any,
    );
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(
      listingId,
    );
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      respostaGravada as any,
    );
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q-do-upsert" } as any);
    const attach = vi
      .spyOn(QuestionRepository, "attachAnswer")
      .mockResolvedValue(undefined as any);
    return { upsert, attach };
  }

  it("re-varredura idêntica: não escreve nada e devolve o id existente", async () => {
    const { upsert } = montar(IDENTICA);

    const r = await QuestionRepository.upsertFromShopeeComment(
      "acc-1",
      COMENTARIO,
    );

    expect(upsert).not.toHaveBeenCalled();
    expect(r).toEqual({ id: "q-existente", isNew: false });
  });

  it("comentário respondido pelo app da Shopee: escreve (status muda)", async () => {
    const { upsert } = montar(IDENTICA);

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis", create_time: 1_750_000_100 },
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.update.status).toBe("ANSWERED");
  });

  it("texto do comentário mudou: escreve", async () => {
    const { upsert } = montar({ ...IDENTICA, text: "texto antigo" });

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("apelido do comprador mudou: escreve", async () => {
    const { upsert } = montar({ ...IDENTICA, buyerNickname: "carla-antiga" });

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("anúncio local apareceu depois: escreve e vincula", async () => {
    const { upsert } = montar(IDENTICA, null, "listing-novo");

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.update.productListingId).toBe("listing-novo");
  });

  it("comentário novo (nada gravado): escreve, como sempre fez", async () => {
    const { upsert } = montar(null);

    const r = await QuestionRepository.upsertFromShopeeComment(
      "acc-1",
      COMENTARIO,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ id: "q-do-upsert", isNew: true });
  });

  it("kill-switch: com MESSAGES_QUESTION_UPSERT_LEGACY=1 escreve sempre", async () => {
    process.env.MESSAGES_QUESTION_UPSERT_LEGACY = "1";
    const { upsert } = montar(IDENTICA);

    await QuestionRepository.upsertFromShopeeComment("acc-1", COMENTARIO);

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Interação com a guarda da RESPOSTA (PR anterior): as duas são independentes
  // -------------------------------------------------------------------------
  it("pergunta inalterada + resposta inalterada: nenhuma das duas escreve", async () => {
    const RESPONDIDA = { ...IDENTICA, status: "ANSWERED" };
    const { upsert, attach } = montar(RESPONDIDA, {
      text: "3 dias úteis",
      status: "ACTIVE",
      dateCreated: new Date(1_750_000_100 * 1000),
    });

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis", create_time: 1_750_000_100 },
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("pergunta inalterada mas resposta EDITADA: só a resposta é gravada", async () => {
    // Prova que pular o upsert da pergunta não engole a atualização da resposta.
    const RESPONDIDA = { ...IDENTICA, status: "ANSWERED" };
    const { upsert, attach } = montar(RESPONDIDA, {
      text: "2 dias úteis",
      status: "ACTIVE",
      dateCreated: new Date(1_750_000_100 * 1000),
    });

    await QuestionRepository.upsertFromShopeeComment("acc-1", {
      ...COMENTARIO,
      comment_reply: { reply: "3 dias úteis", create_time: 1_750_000_100 },
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
    // E o attachAnswer recebe o id certo, o da linha existente.
    expect(attach.mock.calls[0][0]).toBe("q-existente");
  });
});

// ===========================================================================
// Mercado Livre — inclui o caminho crítico de responder
// ===========================================================================
describe("upsertFromMl — guarda de novidade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MESSAGES_QUESTION_UPSERT_LEGACY;
  });

  const PERGUNTA: MLQuestion = {
    id: 123456789,
    text: "esse farol serve no Gol G5?",
    status: "UNANSWERED",
    date_created: "2026-08-01T10:00:00.000Z",
    item_id: "MLB1234567890",
    seller_id: 999,
    from: { id: 555, nickname: "COMPRADOR123" },
  };

  const IDENTICA = {
    id: "q-existente",
    status: "UNANSWERED",
    text: "esse farol serve no Gol G5?",
    productListingId: null,
    buyerNickname: "COMPRADOR123",
  };

  function montar(existente: unknown, respostaGravada: unknown = null) {
    vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
      existente as any,
    );
    vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
    vi.spyOn(prisma.marketplaceAnswer, "findFirst").mockResolvedValue(
      respostaGravada as any,
    );
    const upsert = vi
      .spyOn(prisma.marketplaceQuestion, "upsert")
      .mockResolvedValue({ id: "q-do-upsert" } as any);
    const attach = vi
      .spyOn(QuestionRepository, "attachAnswer")
      .mockResolvedValue(undefined as any);
    return { upsert, attach };
  }

  it("pull do histórico do anúncio, linha idêntica: não escreve", async () => {
    const { upsert } = montar(IDENTICA);

    const r = await QuestionRepository.upsertFromMl("acc-1", PERGUNTA);

    expect(upsert).not.toHaveBeenCalled();
    expect(r).toEqual({ id: "q-existente", isNew: false });
  });

  it("CAMINHO CRÍTICO — responder pelo Dexo SEMPRE grava", async () => {
    // answerQuestion faz postAnswer e reimporta a pergunta já ANSWERED. A linha
    // no banco está UNANSWERED (a rota exige isso), então a guarda não pode
    // pular: se pulasse, a pergunta ficaria eternamente "Pendente" na UI.
    const { upsert } = montar(IDENTICA);

    await QuestionRepository.upsertFromMl("acc-1", {
      ...PERGUNTA,
      status: "ANSWERED",
      answer: {
        text: "serve sim",
        status: "ACTIVE",
        date_created: "2026-08-01T11:30:00.000Z",
      },
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.update.status).toBe("ANSWERED");
  });

  it("webhook de pergunta nova: escreve (create)", async () => {
    const { upsert } = montar(null);

    const r = await QuestionRepository.upsertFromMl("acc-1", PERGUNTA);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ id: "q-do-upsert", isNew: true });
  });

  it("pergunta que virou CLOSED_UNANSWERED: escreve", async () => {
    const { upsert } = montar(IDENTICA);

    await QuestionRepository.upsertFromMl("acc-1", {
      ...PERGUNTA,
      status: "CLOSED_UNANSWERED",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("kill-switch: com MESSAGES_QUESTION_UPSERT_LEGACY=1 escreve sempre", async () => {
    process.env.MESSAGES_QUESTION_UPSERT_LEGACY = "1";
    const { upsert } = montar(IDENTICA);

    await QuestionRepository.upsertFromMl("acc-1", PERGUNTA);

    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
