import { describe, it, expect, vi, afterEach } from "vitest";

import { QuestionRepository } from "@/app/marketplaces/repositories/question.repository";
import prisma from "@/app/lib/prisma";
import type { MLQuestion } from "@/app/marketplaces/types/ml-questions.types";

/**
 * `upsertFromMl` é o caminho de escrita do marketplace principal e, até este
 * arquivo, não tinha NENHUM teste (auditoria de 21/08/2026).
 *
 * O que fica travado aqui:
 *   1. pergunta sem resposta continua nascendo NÃO lida;
 *   2. pergunta que chega ao Dexo JÁ respondida nasce lida, na data da resposta;
 *   3. o ramo `update` (re-sync) NUNCA toca `readAt` — em nenhum dos casos.
 *
 * Estratégia (padrão do repo): spy no delegate do Prisma e inspeção do
 * argumento do upsert. Sem banco.
 */

const PERGUNTA_BASE: MLQuestion = {
  id: 123456789,
  text: "esse farol serve no Gol G5?",
  status: "UNANSWERED",
  date_created: "2026-08-01T10:00:00.000Z",
  item_id: "MLB1234567890",
  seller_id: 999,
  from: { id: 555, nickname: "COMPRADOR123" },
};

/** Mocka o trio que `upsertFromMl` toca e devolve o spy do upsert. */
function mockarUpsert(existente: { id: string } | null = null) {
  vi.spyOn(prisma.marketplaceQuestion, "findUnique").mockResolvedValue(
    existente as any,
  );
  vi.spyOn(QuestionRepository, "resolveListingId").mockResolvedValue(null);
  vi.spyOn(QuestionRepository, "attachAnswer").mockResolvedValue(
    undefined as any,
  );
  return vi
    .spyOn(prisma.marketplaceQuestion, "upsert")
    .mockResolvedValue({ id: existente?.id ?? "q1" } as any);
}

describe("QuestionRepository.upsertFromMl — readAt inicial", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sem resposta: create.readAt null (nasce NÃO lida, como antes)", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromMl("acc-1", PERGUNTA_BASE);

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toBeNull();
    expect(arg.create.status).toBe("UNANSWERED");
    expect(arg.update.readAt).toBeUndefined();
  });

  it("já respondida: create.readAt = data da RESPOSTA", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromMl("acc-1", {
      ...PERGUNTA_BASE,
      status: "ANSWERED",
      answer: {
        text: "serve sim",
        status: "ACTIVE",
        date_created: "2026-08-01T11:30:00.000Z",
      },
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toEqual(new Date("2026-08-01T11:30:00.000Z"));
    expect(arg.update.readAt).toBeUndefined();
  });

  it("CLOSED_UNANSWERED: nasce lida (nunca poderá ser respondida)", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromMl("acc-1", {
      ...PERGUNTA_BASE,
      status: "CLOSED_UNANSWERED",
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toEqual(new Date("2026-08-01T10:00:00.000Z"));
  });

  it("resposta com texto vazio NÃO conta como respondida", async () => {
    const upsert = mockarUpsert();

    await QuestionRepository.upsertFromMl("acc-1", {
      ...PERGUNTA_BASE,
      answer: {
        text: "",
        status: "ACTIVE",
        date_created: "2026-08-01T11:30:00.000Z",
      },
    });

    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.create.readAt).toBeNull();
  });

  it("re-sync de linha existente: update segue com os MESMOS 5 campos de sempre", async () => {
    const upsert = mockarUpsert({ id: "q-existente" });

    const r = await QuestionRepository.upsertFromMl("acc-1", {
      ...PERGUNTA_BASE,
      status: "ANSWERED",
      answer: {
        text: "serve",
        status: "ACTIVE",
        date_created: "2026-08-01T11:30:00.000Z",
      },
    });

    expect(r).toEqual({ id: "q-existente", isNew: false });
    const arg = upsert.mock.calls[0][0] as any;
    // Exaustivo de propósito: qualquer campo novo vazando para o `update`
    // (readAt inclusive) quebra aqui, e não em produção.
    expect(Object.keys(arg.update).sort()).toEqual([
      "buyerNickname",
      "lastSyncedAt",
      "productListingId",
      "status",
      "text",
    ]);
  });
});
