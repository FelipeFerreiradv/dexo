import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRembgBreakers,
  getBreakerSnapshots,
  localRembgBreaker,
} from "../app/marketplaces/services/rembg-breaker";

describe("rembg-breaker (máquina de estados)", () => {
  beforeEach(() => {
    delete process.env.REMBG_BREAKER_DISABLED;
    __resetRembgBreakers();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("CLOSED: permite sempre e 4 falhas seguidas ainda não abrem", () => {
    for (let i = 0; i < 4; i++) {
      expect(localRembgBreaker.beginAttempt()).toBe(true);
      localRembgBreaker.recordFailure(`falha ${i}`);
    }
    expect(localRembgBreaker.peekAllowed()).toBe(true);
    expect(getBreakerSnapshots().local.state).toBe("CLOSED");
  });

  it("5ª falha consecutiva ABRE; OPEN bloqueia peek e begin por 60s", () => {
    for (let i = 0; i < 5; i++) {
      localRembgBreaker.beginAttempt();
      localRembgBreaker.recordFailure("ECONNREFUSED");
    }
    expect(getBreakerSnapshots().local.state).toBe("OPEN");
    expect(localRembgBreaker.peekAllowed()).toBe(false);
    expect(localRembgBreaker.beginAttempt()).toBe(false);

    vi.advanceTimersByTime(59_000);
    expect(localRembgBreaker.peekAllowed()).toBe(false);
  });

  it("sucesso no meio ZERA a contagem (falhas precisam ser consecutivas)", () => {
    for (let i = 0; i < 4; i++) {
      localRembgBreaker.beginAttempt();
      localRembgBreaker.recordFailure("timeout");
    }
    localRembgBreaker.beginAttempt();
    localRembgBreaker.recordSuccess();
    localRembgBreaker.beginAttempt();
    localRembgBreaker.recordFailure("timeout");
    expect(getBreakerSnapshots().local.state).toBe("CLOSED");
    expect(getBreakerSnapshots().local.consecutiveFailures).toBe(1);
  });

  it("após 60s vira HALF_OPEN com UMA sonda; sonda ok fecha, sonda ruim reabre", () => {
    for (let i = 0; i < 5; i++) {
      localRembgBreaker.beginAttempt();
      localRembgBreaker.recordFailure("socket hang up");
    }
    vi.advanceTimersByTime(60_001);

    // Primeira chamada ganha a sonda; a segunda espera o veredito.
    expect(localRembgBreaker.beginAttempt()).toBe(true);
    expect(getBreakerSnapshots().local.state).toBe("HALF_OPEN");
    expect(localRembgBreaker.beginAttempt()).toBe(false);
    expect(localRembgBreaker.peekAllowed()).toBe(false);

    // Sonda falhou => reabre imediatamente (sem esperar 5 falhas).
    localRembgBreaker.recordFailure("ainda morto");
    expect(getBreakerSnapshots().local.state).toBe("OPEN");

    // Novo ciclo: sonda com sucesso fecha de vez.
    vi.advanceTimersByTime(60_001);
    expect(localRembgBreaker.beginAttempt()).toBe(true);
    localRembgBreaker.recordSuccess();
    expect(getBreakerSnapshots().local.state).toBe("CLOSED");
    expect(localRembgBreaker.beginAttempt()).toBe(true);
  });

  it("abortAttempt devolve a sonda sem punir (desistiu antes de despachar)", () => {
    for (let i = 0; i < 5; i++) {
      localRembgBreaker.beginAttempt();
      localRembgBreaker.recordFailure("x");
    }
    vi.advanceTimersByTime(60_001);
    expect(localRembgBreaker.beginAttempt()).toBe(true); // sonda reivindicada
    localRembgBreaker.abortAttempt(); // gate cheio/orçamento curto — devolve
    // A sonda volta a estar disponível para a próxima requisição.
    expect(localRembgBreaker.beginAttempt()).toBe(true);
    expect(getBreakerSnapshots().local.state).toBe("HALF_OPEN");
  });

  it("killswitch REMBG_BREAKER_DISABLED: sempre permite e NADA avança", () => {
    process.env.REMBG_BREAKER_DISABLED = "1";
    for (let i = 0; i < 10; i++) {
      expect(localRembgBreaker.beginAttempt()).toBe(true);
      localRembgBreaker.recordFailure("erro");
    }
    expect(localRembgBreaker.peekAllowed()).toBe(true);
    expect(getBreakerSnapshots().disabled).toBe(true);
    // Estado congelado durante o killswitch: re-habilitar NÃO pode acordar
    // com falhas velhas acumuladas (o breaker parte de CLOSED limpo).
    delete process.env.REMBG_BREAKER_DISABLED;
    expect(localRembgBreaker.peekAllowed()).toBe(true);
    expect(getBreakerSnapshots().local.state).toBe("CLOSED");
    expect(getBreakerSnapshots().local.consecutiveFailures).toBe(0);
  });

  it("snapshot expõe estado/contagem/última falha dos DOIS breakers", () => {
    localRembgBreaker.beginAttempt();
    localRembgBreaker.recordFailure("ECONNRESET no sidecar");
    const snap = getBreakerSnapshots();
    expect(snap.local.consecutiveFailures).toBe(1);
    expect(snap.local.lastFailure).toContain("ECONNRESET");
    expect(snap.external.state).toBe("CLOSED");
  });
});
