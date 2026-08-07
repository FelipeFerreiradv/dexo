import { describe, it, expect } from "vitest";

import { loadEnv, EnvValidationError } from "../app/lib/env";
import {
  describeAiConfigProblem,
  getAiProviderName,
  getAiMaxDailyPerTenant,
  getAiTimeoutMs,
  getAiTemperature,
  isAiModuleEnabled,
  isAiExternalLookupEnabled,
  AI_CONSTANTS,
} from "../app/ai/core/ai-constants";

// ===========================================================================
// REGRA 1 do plano: o boot da API NÃO pode passar a depender de IA.
//
// Sem AI_API_KEY, sem provedor configurado, com a flag global desligada:
// app/api/api.ts sobe NORMALMENTE e todo o resto do sistema funciona igual.
// Chave ausente ⇒ só o Bitz fica indisponível.
//
// Este spec é o guarda dessa promessa. Ele cresce nas fases seguintes (Fase 3
// acrescenta a prova de que o MainLayout renderiza árvore idêntica com a flag
// desligada e que nenhum JS do Bitz é baixado).
// ===========================================================================

// Exatamente o mesmo fixture de tests/env.spec.ts: só as 13 obrigatórias.
// Nenhuma AI_* aqui — é esse o ponto.
const envSemIa = {
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

describe("Bitz — impacto zero no boot", () => {
  it("env SEM nenhuma variável AI_* é válido (a API sobe normalmente)", () => {
    expect(() => loadEnv(envSemIa as any)).not.toThrow();
  });

  it("env com AI_* preenchidas continua válido (nada vira obrigatório)", () => {
    expect(() =>
      loadEnv({
        ...envSemIa,
        AI_PROVIDER: "gemini",
        AI_MODEL: "algum-modelo",
        AI_API_KEY: "chave-secreta",
        AI_TIMEOUT_MS: "15000",
        AI_MAX_TOKENS: "1024",
        AI_TEMPERATURE: "0.7",
        AI_MAX_DAILY_PER_TENANT: "500",
        AI_MAX_DAILY_GLOBAL: "9000",
        AI_EXTERNAL_LOOKUP_ENABLED: "true",
      } as any),
    ).not.toThrow();
  });

  it("AI_PROVIDER desconhecido é barrado no boot (typo não vira mock silencioso)", () => {
    expect(() =>
      loadEnv({ ...envSemIa, AI_PROVIDER: "openai" } as any),
    ).toThrow(EnvValidationError);
  });

  it("AI_TIMEOUT_MS não-numérico é barrado no boot", () => {
    expect(() => loadEnv({ ...envSemIa, AI_TIMEOUT_MS: "abc" } as any)).toThrow(
      EnvValidationError,
    );
  });

  it("AI_TEMPERATURE fora de [0,2] é barrada no boot", () => {
    expect(() => loadEnv({ ...envSemIa, AI_TEMPERATURE: "5" } as any)).toThrow(
      EnvValidationError,
    );
  });
});

describe("Bitz — defaults sem nenhuma configuração", () => {
  // Sem stub de env: é o estado real de produção hoje (nada configurado).
  it("módulo desligado por padrão", () => {
    expect(isAiModuleEnabled()).toBe(false);
  });

  it("provedor default é mock — sem config, nada chama rede", () => {
    expect(getAiProviderName()).toBe("mock");
  });

  it("pesquisa externa nasce desligada", () => {
    expect(isAiExternalLookupEnabled()).toBe(false);
  });

  it("describeAiConfigProblem reporta o motivo em vez de lançar", () => {
    // Devolver o motivo (em vez de throw) é o que permite ao chat DEGRADAR:
    // nenhum erro de IA pode derrubar uma requisição de negócio.
    expect(describeAiConfigProblem()).toBe("modulo_desligado");
  });

  it("valores numéricos caem nos defaults documentados", () => {
    expect(getAiTimeoutMs()).toBe(AI_CONSTANTS.DEFAULT_TIMEOUT_MS);
    expect(getAiTemperature()).toBe(AI_CONSTANTS.DEFAULT_TEMPERATURE);
    expect(getAiMaxDailyPerTenant()).toBe(
      AI_CONSTANTS.DEFAULT_MAX_DAILY_PER_TENANT,
    );
  });
});
