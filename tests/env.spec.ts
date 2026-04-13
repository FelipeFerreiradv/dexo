import { describe, it, expect } from "vitest";

import { loadEnv, EnvValidationError } from "../app/lib/env";

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@host/db",
  DIRECT_URL: "postgresql://user:pass@host/db",
  NEXTAUTH_SECRET: "a".repeat(32),
  NEXTAUTH_URL: "http://localhost:3000",
  ML_CLIENT_ID: "ml-client",
  ML_CLIENT_SECRET: "ml-secret",
  ML_AUTH_URL: "https://auth.mercadolibre.com.br",
  ML_API_URL: "https://api.mercadolibre.com",
  SHOPEE_PARTNER_ID: "shp-id",
  SHOPEE_PARTNER_KEY: "shp-key",
  APP_BACKEND_URL: "http://localhost:3333",
  NEXT_PUBLIC_API_URL: "http://localhost:3333",
  CORS_ORIGIN: "http://localhost:3000",
};

describe("env.loadEnv", () => {
  it("aceita um env completo e retorna valores tipados", () => {
    const env = loadEnv(validEnv as any);
    expect(env.PORT).toBe(3333);
    expect(env.SHOPEE_SANDBOX).toBe("false");
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it("converte PORT de string para número", () => {
    const env = loadEnv({ ...validEnv, PORT: "4000" } as any);
    expect(env.PORT).toBe(4000);
  });

  it("falha quando DATABASE_URL está ausente", () => {
    const { DATABASE_URL: _, ...rest } = validEnv as any;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
    try {
      loadEnv(rest);
    } catch (err) {
      expect((err as Error).message).toMatch(/DATABASE_URL/);
    }
  });

  it("falha quando NEXTAUTH_SECRET é curto", () => {
    expect(() =>
      loadEnv({ ...validEnv, NEXTAUTH_SECRET: "curto" } as any),
    ).toThrow(/NEXTAUTH_SECRET/);
  });

  it("falha quando PORT é inválido", () => {
    expect(() => loadEnv({ ...validEnv, PORT: "xyz" } as any)).toThrow(/PORT/);
    expect(() => loadEnv({ ...validEnv, PORT: "0" } as any)).toThrow(/PORT/);
    expect(() => loadEnv({ ...validEnv, PORT: "70000" } as any)).toThrow(
      /PORT/,
    );
  });

  it("falha quando uma URL obrigatória não começa com http", () => {
    expect(() =>
      loadEnv({ ...validEnv, APP_BACKEND_URL: "localhost:3333" } as any),
    ).toThrow(/APP_BACKEND_URL/);
  });

  it("aceita NEXTAUTH_URL e CORS_ORIGIN ausentes (tem fallback no código)", () => {
    const { NEXTAUTH_URL: _a, CORS_ORIGIN: _b, ...rest } = validEnv as any;
    const env = loadEnv(rest);
    expect(env.NEXTAUTH_URL).toBeUndefined();
    expect(env.CORS_ORIGIN).toBeUndefined();
  });

  it("valida formato de NEXTAUTH_URL quando presente", () => {
    expect(() =>
      loadEnv({ ...validEnv, NEXTAUTH_URL: "localhost:3000" } as any),
    ).toThrow(/NEXTAUTH_URL/);
  });

  it("aceita ML_MAX_DIM_CM e ML_MAX_WEIGHT_KG opcionais", () => {
    const env = loadEnv({
      ...validEnv,
      ML_MAX_DIM_CM: "150",
      ML_MAX_WEIGHT_KG: "30",
    } as any);
    expect(env.ML_MAX_DIM_CM).toBe(150);
    expect(env.ML_MAX_WEIGHT_KG).toBe(30);
  });

  it("rejeita ML_MAX_DIM_CM não numérico", () => {
    expect(() => loadEnv({ ...validEnv, ML_MAX_DIM_CM: "abc" } as any)).toThrow(
      /ML_MAX_DIM_CM/,
    );
  });

  it("rejeita SHOPEE_SANDBOX com valor fora de true|false", () => {
    expect(() =>
      loadEnv({ ...validEnv, SHOPEE_SANDBOX: "maybe" } as any),
    ).toThrow(/SHOPEE_SANDBOX/);
  });
});
