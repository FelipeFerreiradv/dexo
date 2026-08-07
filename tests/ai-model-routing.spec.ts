import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));

import {
  describeAiConfigProblem,
  getAiApiKeyFor,
  getAiRoute,
  type AiCapability,
} from "../app/ai/core/ai-constants";
import { resolveAiProvider } from "../app/ai/core/provider";

// ===========================================================================
// ⭐ TROCA DINÂMICA DE MODELO POR CAPACIDADE.
//
// O objetivo é dinheiro: texto é ~95% do volume e o modelo barato dá conta;
// imagem e áudio são raros e exigem modelo que os entenda. Sem roteamento,
// toda pergunta de texto paga preço de multimodal.
//
// Este spec protege três propriedades, nesta ordem de importância:
//
//   1. SEGURANÇA — a chave de um provedor nunca é usada por outro. Sem essa
//      regra, uma linha de configuração manda a chave do Google para o
//      servidor do DeepSeek, sem nenhum sinal de erro.
//   2. ZERO REGRESSÃO — um `.env` que não conhece rota nenhuma se comporta
//      exatamente como antes, nas três capacidades.
//   3. FALHA FECHADA — modelo ausente degrada; nunca vira um default
//      inventado, que chamaria um modelo que o cliente não escolheu.
//
// ⚠️ TODO TESTE AQUI LIMPA O AMBIENTE PRIMEIRO. O vitest carrega o `.env` do
// projeto, e o `.env` de desenvolvimento tem `AI_PROVIDER=gemini` e
// `AI_API_KEY` de verdade. Sem `limparAmbiente()` os testes leriam a
// configuração da máquina e provariam outra coisa — foi exatamente esse o
// engano que custou uma rodada de investigação em 07/08/2026.
// ===========================================================================

const ENVS = [
  "NEXT_PUBLIC_AI_MODULE_ENABLED",
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_API_KEY",
  "AI_GEMINI_API_KEY",
  "AI_DEEPSEEK_API_KEY",
  "AI_ROUTE_TEXTO",
  "AI_ROUTE_IMAGEM",
  "AI_ROUTE_AUDIO",
] as const;

/** Zera tudo e liga o módulo. Todo teste parte deste estado. */
function limparAmbiente() {
  for (const e of ENVS) vi.stubEnv(e, "");
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
}

const CAPACIDADES: AiCapability[] = ["texto", "imagem", "audio"];

beforeEach(limparAmbiente);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("compatibilidade com o .env legado", () => {
  it("⭐ sem nenhuma rota, as TRÊS capacidades caem no par legado", () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_MODEL", "gemini-x");

    for (const cap of CAPACIDADES) {
      expect(getAiRoute(cap), cap).toEqual({
        provider: "gemini",
        model: "gemini-x",
      });
    }
  });

  it("sem AI_PROVIDER, tudo cai no mock — que não toca rede", () => {
    for (const cap of CAPACIDADES) {
      expect(getAiRoute(cap).provider, cap).toBe("mock");
    }
  });

  it("provedor desconhecido vira mock, não erro de chamada", () => {
    // Um typo em `AI_PROVIDER` deixa o Bitz sem graça; nunca chamando um
    // endpoint errado com a chave do cliente.
    vi.stubEnv("AI_PROVIDER", "gemni");
    expect(getAiRoute("texto").provider).toBe("mock");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepsek:modelo");
    expect(getAiRoute("texto").provider).toBe("mock");
  });

  it("resolveAiProvider() sem argumento continua sendo o caminho de TEXTO", () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "k");
    vi.stubEnv("AI_MODEL", "gemini-x");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds-x");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k2");

    // Se o default não fosse "texto", este seria o gemini do par legado.
    expect(resolveAiProvider()?.name).toBe("deepseek");
    expect(resolveAiProvider()?.name).toBe(resolveAiProvider("texto")?.name);
  });
});

describe("rota por capacidade", () => {
  it("⭐ texto no DeepSeek, imagem e áudio no Gemini — a config que economiza", () => {
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:deepseek-v4");
    vi.stubEnv("AI_ROUTE_IMAGEM", "gemini:gemini-2.5-flash");
    vi.stubEnv("AI_ROUTE_AUDIO", "gemini:gemini-2.5-flash");

    expect(getAiRoute("texto")).toEqual({
      provider: "deepseek",
      model: "deepseek-v4",
    });
    expect(getAiRoute("imagem")).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(getAiRoute("audio")).toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
  });

  it("uma rota não contamina as outras", () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_MODEL", "gemini-x");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds");

    expect(getAiRoute("texto").provider).toBe("deepseek");
    expect(getAiRoute("imagem").provider).toBe("gemini");
    expect(getAiRoute("audio").provider).toBe("gemini");
  });

  it("modelo com dois-pontos no nome sobrevive (só o PRIMEIRO separa)", () => {
    // Nome de modelo com `:` existe (versões, tags). Cortar no último `:`
    // decapitaria o nome e o provedor receberia um modelo que não existe.
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:familia:v4:latest");
    expect(getAiRoute("texto")).toEqual({
      provider: "deepseek",
      model: "familia:v4:latest",
    });
  });

  it("⭐ rota SEM modelo degrada com sem_modelo, não inventa um default", () => {
    // Inventar nome de modelo é o começo de uma conta surpresa: nomes mudam
    // (o `deepseek-chat` foi descontinuado em 24/07/2026) e um default
    // silencioso chamaria um modelo que o cliente não escolheu.
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k");

    expect(getAiRoute("texto").model).toBeUndefined();
    expect(describeAiConfigProblem("texto")).toBe("sem_modelo");
    expect(resolveAiProvider("texto")).toBeNull();
  });

  it("espaço em branco em volta do modelo não vira modelo", () => {
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:   ");
    expect(getAiRoute("texto").model).toBeUndefined();
  });
});

describe("⭐ chaves — um provedor NUNCA usa a chave de outro", () => {
  it("a chave legada só vale para o provedor legado", () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "chave-do-google");

    expect(getAiApiKeyFor("gemini")).toBe("chave-do-google");
    expect(getAiApiKeyFor("deepseek")).toBeUndefined();
  });

  it("⭐ rota para provedor sem chave própria NÃO sobe — e não vaza a alheia", () => {
    // O cenário exato: alguém liga a rota do DeepSeek e esquece a chave dele.
    // Sem esta regra, o primeiro `Authorization: Bearer` levaria a chave do
    // Google para o servidor do DeepSeek.
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "chave-do-google");
    vi.stubEnv("AI_MODEL", "gemini-x");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds-x");

    expect(getAiApiKeyFor("deepseek")).toBeUndefined();
    expect(describeAiConfigProblem("texto")).toBe("sem_api_key");
    expect(resolveAiProvider("texto")).toBeNull();

    // E o Gemini segue com a dele, nas capacidades que continuam com ele.
    expect(getAiApiKeyFor("gemini")).toBe("chave-do-google");
    expect(describeAiConfigProblem("imagem")).toBeNull();
  });

  it("a chave por provedor vence a legada", () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "legada");
    vi.stubEnv("AI_GEMINI_API_KEY", "propria");
    expect(getAiApiKeyFor("gemini")).toBe("propria");
  });

  it("os dois provedores convivem, cada um com a sua chave", () => {
    vi.stubEnv("AI_GEMINI_API_KEY", "k-gemini");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k-deepseek");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds-x");
    vi.stubEnv("AI_ROUTE_IMAGEM", "gemini:gm-x");

    expect(resolveAiProvider("texto")?.name).toBe("deepseek");
    expect(resolveAiProvider("texto")?.model).toBe("ds-x");
    expect(resolveAiProvider("imagem")?.name).toBe("gemini");
    expect(resolveAiProvider("imagem")?.model).toBe("gm-x");
  });

  it("o mock não precisa de chave nenhuma", () => {
    expect(getAiApiKeyFor("mock")).toBeUndefined();
    expect(describeAiConfigProblem("texto")).toBeNull();
    expect(resolveAiProvider("texto")?.name).toBe("mock");
  });
});

describe("o kill-switch vence o roteamento", () => {
  it("módulo desligado: nenhuma capacidade resolve", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k");

    for (const cap of CAPACIDADES) {
      expect(describeAiConfigProblem(cap), cap).toBe("modulo_desligado");
      expect(resolveAiProvider(cap), cap).toBeNull();
    }
  });
});

describe("o código não fixa nome de modelo em lugar nenhum", () => {
  it("⭐ nenhum nome de modelo aparece hardcoded no módulo de IA", async () => {
    // A promessa "trocar de modelo é mexer no .env" só é verdade enquanto
    // nenhum arquivo tiver um nome de modelo dentro. Um default esquecido no
    // código é o que faz a troca no .env não surtir efeito.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raiz = join(__dirname, "..", "app", "ai");

    const arquivos: string[] = [];
    const andar = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) andar(p);
        else if (p.endsWith(".ts")) arquivos.push(p);
      }
    };
    andar(raiz);
    expect(arquivos.length).toBeGreaterThan(20);

    const proibidos = /["'`](gemini-[\d.]|deepseek-(chat|reasoner|v\d))/i;
    for (const arquivo of arquivos) {
      const src = readFileSync(arquivo, "utf8")
        // Comentários citam nomes de propósito (ex.: avisar que o
        // `deepseek-chat` foi descontinuado). O que não pode é CÓDIGO.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, arquivo).not.toMatch(proibidos);
    }
  });
});
