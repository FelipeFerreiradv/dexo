import { describe, it, expect } from "vitest";
import {
  busyMessage,
  isReusableMlPlaceholder,
  placeholderDecision,
} from "../app/marketplaces/lib/ml-placeholder-busy.logic";

/**
 * Quem pode publicar no pendente do ML agora (revisão de 23/09/2026, 4ª
 * rodada). A regra fecha a corrida com o cron SEM jogar fora as escolhas do
 * lote quando a linha está só agendada (re-arme da edição, backoff).
 */

const AGORA = new Date("2026-09-23T12:00:00.000Z").getTime();
const FUTURO = new Date(AGORA + 5 * 60_000);
const PASSADO = new Date(AGORA - 5 * 60_000);
const linha = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  externalListingId: "PENDING_1",
  retryEnabled: false,
  nextRetryAt: null as Date | null,
  status: "error",
  lastError: null as string | null,
  ...over,
});

describe("placeholderDecision", () => {
  it("retry desligado, sem reserva (ou reserva vencida) ⇒ livre", () => {
    expect(placeholderDecision(linha(), null, AGORA)).toBe("free");
    expect(placeholderDecision(linha({ nextRetryAt: PASSADO }), null, AGORA)).toBe("free");
  });

  it("retry desligado com reserva vigente de OUTRO ⇒ ocupada", () => {
    expect(placeholderDecision(linha({ nextRetryAt: FUTURO }), null, AGORA)).toBe("busy");
    expect(
      placeholderDecision(
        linha({ nextRetryAt: FUTURO }),
        { listingId: "outra", at: FUTURO },
        AGORA,
      ),
    ).toBe("busy");
  });

  it("a reserva é de QUEM CHAMA (mesma linha, mesmo horário) ⇒ é dele", () => {
    expect(
      placeholderDecision(
        linha({ nextRetryAt: FUTURO }),
        { listingId: "l1", at: new Date(FUTURO.getTime()) },
        AGORA,
      ),
    ).toBe("owned");
    expect(
      placeholderDecision(
        linha({ retryEnabled: true, status: "pending", nextRetryAt: FUTURO }),
        { listingId: "l1", at: FUTURO },
        AGORA,
      ),
    ).toBe("owned");
  });

  it("retry ligado e o CRON publicando (status pending) ⇒ ocupada", () => {
    expect(
      placeholderDecision(
        linha({ retryEnabled: true, status: "pending", nextRetryAt: FUTURO }),
        null,
        AGORA,
      ),
    ).toBe("busy");
  });

  it("retry ligado com [VERIFICAR] ⇒ ocupada (só o cron confere pelo SKU)", () => {
    expect(
      placeholderDecision(
        linha({ retryEnabled: true, lastError: "[VERIFICAR] timeout", nextRetryAt: FUTURO }),
        null,
        AGORA,
      ),
    ).toBe("busy");
  });

  it("retry ligado só AGENDADO (re-arme, backoff, vencido ou não) ⇒ pode ser assumida", () => {
    for (const nextRetryAt of [FUTURO, PASSADO, null]) {
      expect(
        placeholderDecision(
          linha({
            retryEnabled: true,
            status: "error",
            lastError: "[TERMINAL][CORRIGIVEL] GTIN inválido",
            nextRetryAt,
          }),
          null,
          AGORA,
        ),
      ).toBe("takeover");
    }
  });
});

describe("isReusableMlPlaceholder / busyMessage", () => {
  it("republicação é do sync; placeholder comum participa", () => {
    expect(isReusableMlPlaceholder({ externalListingId: "PENDING_1" })).toBe(true);
    expect(isReusableMlPlaceholder({ externalListingId: "PENDING_REPUBLISH_MLB1_1" })).toBe(false);
    expect(isReusableMlPlaceholder({ externalListingId: "MLB1" })).toBe(false);
  });

  it("mensagem diz 'agendada' quando é o cron e 'em andamento' quando é uma publicação", () => {
    expect(busyMessage({ id: "l", retryEnabled: true })).toMatch(/agendada/);
    expect(busyMessage({ id: "l", retryEnabled: false })).toMatch(/em andamento/);
  });
});

describe("rodada 5 da revisão (23/09)", () => {
  it("linha com id REAL agendada pelo cron NÃO é assumida (o claim não a marca)", () => {
    expect(
      placeholderDecision(
        {
          id: "l1",
          externalListingId: "MLB_ENCERRADO",
          retryEnabled: true,
          status: "error",
          nextRetryAt: new Date(Date.now() + 60_000),
        },
        null,
      ),
    ).toBe("busy");
  });
});
