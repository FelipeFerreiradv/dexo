import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HANDLER_BUDGET_DEFAULT_MS,
  REMBG_DEFAULT_TIMEOUT_MS,
  SIDECAR_MIN_USEFUL_MS,
  SIDECAR_RESERVE_MS,
  computeSidecarTimeoutMs,
  isWorthCallingSidecar,
  readHandlerBudgetMs,
  readRembgTimeoutMs,
} from "../app/marketplaces/services/rembg-budget";

const ENV_KEYS = ["REMBG_TIMEOUT_MS", "UPLOAD_HANDLER_BUDGET_MS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("readRembgTimeoutMs / readHandlerBudgetMs", () => {
  it("usa os defaults quando o env não está setado", () => {
    expect(readRembgTimeoutMs()).toBe(REMBG_DEFAULT_TIMEOUT_MS);
    expect(readHandlerBudgetMs()).toBe(HANDLER_BUDGET_DEFAULT_MS);
  });

  it("ignora valores inválidos em vez de propagar NaN", () => {
    // NaN no timeout viraria `timeout: NaN` no axios — sem timeout nenhum.
    expect(readRembgTimeoutMs({ REMBG_TIMEOUT_MS: "abc" } as any)).toBe(
      REMBG_DEFAULT_TIMEOUT_MS,
    );
    expect(readRembgTimeoutMs({ REMBG_TIMEOUT_MS: "0" } as any)).toBe(
      REMBG_DEFAULT_TIMEOUT_MS,
    );
    expect(readRembgTimeoutMs({ REMBG_TIMEOUT_MS: "-5000" } as any)).toBe(
      REMBG_DEFAULT_TIMEOUT_MS,
    );
    expect(
      readHandlerBudgetMs({ UPLOAD_HANDLER_BUDGET_MS: "" } as any),
    ).toBe(HANDLER_BUDGET_DEFAULT_MS);
  });

  it("respeita um valor válido do env", () => {
    expect(readRembgTimeoutMs({ REMBG_TIMEOUT_MS: "15000" } as any)).toBe(15000);
    expect(
      readHandlerBudgetMs({ UPLOAD_HANDLER_BUDGET_MS: "30000" } as any),
    ).toBe(30000);
  });
});

describe("computeSidecarTimeoutMs", () => {
  it("sem deadline devolve o timeout do env — comportamento anterior intacto", () => {
    // Todo caller que não passa `deadlineAt` (inclusive as specs antigas) tem
    // que continuar vendo exatamente o mesmo número de antes.
    expect(computeSidecarTimeoutMs({ rembgTimeoutMs: 60000 })).toBe(60000);
    expect(computeSidecarTimeoutMs({ rembgTimeoutMs: 15000 })).toBe(15000);
    expect(
      computeSidecarTimeoutMs({ deadlineAt: Number.NaN, rembgTimeoutMs: 60000 }),
    ).toBe(60000);
  });

  it("CLAMPA um REMBG_TIMEOUT_MS=60000 herdado do .env de produção", () => {
    // ESTE é o coração do bug: 60000 é IGUAL ao proxy_read_timeout default do
    // nginx, então a degradação graceful nunca chegava a rodar. Mudar só o
    // default do código não adiantaria — o .env de prod sobrescreve. O clamp
    // resolve independentemente do que estiver no .env.
    const now = 1_000_000;
    const deadlineAt = now + HANDLER_BUDGET_DEFAULT_MS; // 45s de orçamento

    const timeout = computeSidecarTimeoutMs({
      deadlineAt,
      now,
      rembgTimeoutMs: 60000,
    });

    expect(timeout).toBe(HANDLER_BUDGET_DEFAULT_MS - SIDECAR_RESERVE_MS); // 42000
    expect(timeout).toBeLessThan(60000);
  });

  it("NÃO mexe num REMBG_TIMEOUT_MS já menor que o orçamento (env só reduz)", () => {
    const now = 1_000_000;
    const deadlineAt = now + HANDLER_BUDGET_DEFAULT_MS;

    // Se a VPS estiver com 15000, o comportamento é idêntico ao de hoje.
    expect(
      computeSidecarTimeoutMs({ deadlineAt, now, rembgTimeoutMs: 15000 }),
    ).toBe(15000);
  });

  it("encolhe conforme o tempo já gasto no handler", () => {
    const now = 1_000_000;
    const deadlineAt = now + 10_000; // só 10s restantes

    expect(
      computeSidecarTimeoutMs({ deadlineAt, now, rembgTimeoutMs: 60000 }),
    ).toBe(10_000 - SIDECAR_RESERVE_MS);
  });

  it("devolve valor não-positivo quando o orçamento acabou", () => {
    const now = 1_000_000;
    const deadlineAt = now - 5_000; // deadline já passou

    const timeout = computeSidecarTimeoutMs({
      deadlineAt,
      now,
      rembgTimeoutMs: 60000,
    });

    expect(timeout).toBeLessThanOrEqual(0);
    expect(isWorthCallingSidecar(timeout)).toBe(false);
  });
});

describe("isWorthCallingSidecar", () => {
  it("recusa sobras que não dariam nem uma inferência", () => {
    expect(isWorthCallingSidecar(SIDECAR_MIN_USEFUL_MS - 1)).toBe(false);
    expect(isWorthCallingSidecar(0)).toBe(false);
    expect(isWorthCallingSidecar(-1)).toBe(false);
  });

  it("aceita a partir do mínimo útil", () => {
    expect(isWorthCallingSidecar(SIDECAR_MIN_USEFUL_MS)).toBe(true);
    expect(isWorthCallingSidecar(42_000)).toBe(true);
  });
});
