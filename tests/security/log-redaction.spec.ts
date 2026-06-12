import { describe, it, expect } from "vitest";
import { sanitizeDeep } from "../../app/middlewares/logging.middleware";

/**
 * PR-A7 — Redação de PII/segredos nos logs (SystemLog).
 */
describe("PR-A7: sanitizeDeep", () => {
  it("redige segredos e PII em qualquer profundidade", () => {
    const input = {
      name: "Loja X",
      password: "hunter2",
      nested: {
        accessToken: "abc",
        customer: { cpf: "123.456.789-00", email: "a@b.c", phone: "9999" },
      },
      items: [{ certificadoSenha: "p4ss", sku: "OK-1" }],
    };
    const out = sanitizeDeep(input);

    expect(out.name).toBe("Loja X"); // campo não sensível preservado
    expect(out.password).toBe("[REDACTED]");
    expect(out.nested.accessToken).toBe("[REDACTED]");
    expect(out.nested.customer.cpf).toBe("[REDACTED]");
    expect(out.nested.customer.email).toBe("[REDACTED]");
    expect(out.nested.customer.phone).toBe("[REDACTED]");
    expect(out.items[0].certificadoSenha).toBe("[REDACTED]");
    expect(out.items[0].sku).toBe("OK-1"); // não sensível preservado
  });

  it("lida com null/primitivos/arrays sem quebrar", () => {
    expect(sanitizeDeep(null)).toBeNull();
    expect(sanitizeDeep("x")).toBe("x");
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep([{ token: "t", ok: 1 }])).toEqual([
      { token: "[REDACTED]", ok: 1 },
    ]);
  });

  it("trunca estruturas muito profundas (proteção)", () => {
    let deep: any = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    const out = sanitizeDeep(deep);
    // Em algum nível profundo vira "[TRUNCATED]".
    expect(JSON.stringify(out)).toContain("[TRUNCATED]");
  });
});
