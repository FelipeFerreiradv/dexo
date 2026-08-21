import { describe, it, expect } from "vitest";

import { initialReadAt } from "@/app/marketplaces/repositories/question.repository";

/**
 * `initialReadAt` decide se a pergunta NASCE lida ou não lida — e só é usada no
 * ramo `create` dos upserts de ML/Shopee.
 *
 * A regra que este arquivo trava: nasce NÃO lida apenas a pergunta que pede
 * ação do vendedor. Antes disto tudo nascia não lido, e o contador de "não
 * lidas" de produção carregava 4.173 de 7.551 linhas já respondidas (55%).
 */
describe("initialReadAt", () => {
  const CRIADA_EM = new Date("2026-08-01T10:00:00.000Z");
  const RESPONDIDA_EM = new Date("2026-08-01T11:30:00.000Z");

  it("UNANSWERED sem resposta: nasce NÃO lida (comportamento preservado)", () => {
    expect(
      initialReadAt({ status: "UNANSWERED", dateCreated: CRIADA_EM }),
    ).toBeNull();
  });

  it("UNDER_REVIEW: nasce NÃO lida — o ML pode devolvê-la para UNANSWERED", () => {
    // Se nascesse lida, o ramo `update` (que nunca reabre readAt) faria a
    // pergunta virar UNANSWERED sem NUNCA aparecer para o vendedor.
    expect(
      initialReadAt({ status: "UNDER_REVIEW", dateCreated: CRIADA_EM }),
    ).toBeNull();
  });

  it("ANSWERED com resposta: nasce lida na data da RESPOSTA", () => {
    expect(
      initialReadAt({
        status: "ANSWERED",
        dateCreated: CRIADA_EM,
        answeredAt: RESPONDIDA_EM,
      }),
    ).toBe(RESPONDIDA_EM);
  });

  it("ANSWERED sem objeto de resposta: nasce lida na data da PERGUNTA", () => {
    expect(initialReadAt({ status: "ANSWERED", dateCreated: CRIADA_EM })).toBe(
      CRIADA_EM,
    );
  });

  it.each(["CLOSED_UNANSWERED", "BANNED", "DELETED"])(
    "%s: estado terminal nasce lido (nunca poderá ser respondido)",
    (status) => {
      expect(initialReadAt({ status, dateCreated: CRIADA_EM })).toBe(CRIADA_EM);
    },
  );

  it("resposta presente vence o status: UNANSWERED com resposta nasce lida", () => {
    expect(
      initialReadAt({
        status: "UNANSWERED",
        dateCreated: CRIADA_EM,
        answeredAt: RESPONDIDA_EM,
      }),
    ).toBe(RESPONDIDA_EM);
  });

  it("resposta com data inválida não grava Invalid Date", () => {
    const r = initialReadAt({
      status: "ANSWERED",
      dateCreated: CRIADA_EM,
      answeredAt: new Date("nao-e-data"),
    });
    expect(r).toBe(CRIADA_EM);
    expect(Number.isNaN(r!.getTime())).toBe(false);
  });

  it("answeredAt null é ignorado (cai na regra de status)", () => {
    expect(
      initialReadAt({
        status: "UNANSWERED",
        dateCreated: CRIADA_EM,
        answeredAt: null,
      }),
    ).toBeNull();
  });
});
