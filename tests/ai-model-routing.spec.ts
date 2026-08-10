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

  it("AI_PROVIDER desconhecido vira mock — e é barrado no boot", () => {
    // Comportamento de sempre do par legado. O typo não chega a produção
    // porque `app/lib/env.ts` recusa o valor no boot; este ramo só é
    // alcançável fora do processo da API.
    vi.stubEnv("AI_PROVIDER", "gemni");
    expect(getAiRoute("texto").provider).toBe("mock");
  });

  it("⭐ ROTA com provedor desconhecido NÃO vira mock — degrada visível", () => {
    // ⚠️ Achado de auditoria, e o defeito era grave: `AI_ROUTE_TEXTO` com typo
    // caía no mock. Em produção o cliente pagante receberia
    // `Bitz (mock): recebi "..."` como se fosse resposta de verdade, com
    // `ok:true`, cota do dia debitada e NADA no log. Falha aberta e silenciosa.
    //
    // Hoje: o boot recusa (app/lib/env.ts) e, como segunda camada, o runtime
    // devolve `provedor_desconhecido` e o Bitz se declara indisponível.
    vi.stubEnv("AI_ROUTE_TEXTO", "deepsek:modelo");

    expect(getAiRoute("texto").provider).toBe("desconhecido");
    expect(describeAiConfigProblem("texto")).toBe("provedor_desconhecido");
    expect(resolveAiProvider("texto")).toBeNull();
  });

  it("⭐ AI_PROVIDER=mock VENCE a rota — é o interruptor de ficar offline", () => {
    // ⚠️ REGRESSÃO REAL, pega pela suíte completa e não pelos testes de
    // roteamento: com `AI_ROUTE_TEXTO` no `.env` de desenvolvimento, o
    // `AI_PROVIDER=mock` que dezenas de specs de turno fixam deixou de valer, e
    // eles passaram a chamar o provedor REAL, com chave real, saindo pela rede.
    //
    // O sintoma foi enganoso: "nenhuma tool foi selecionada", não "erro de
    // rede". Levaria muito tempo para alguém ligar uma coisa à outra.
    //
    // `mock` não é preferência de provedor — é "não fale com ninguém lá fora".
    vi.stubEnv("AI_PROVIDER", "mock");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds-x");
    vi.stubEnv("AI_ROUTE_IMAGEM", "gemini:gm-x");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k");
    vi.stubEnv("AI_GEMINI_API_KEY", "k2");

    for (const cap of CAPACIDADES) {
      expect(getAiRoute(cap).provider, cap).toBe("mock");
      expect(resolveAiProvider(cap)?.name, cap).toBe("mock");
    }
  });

  it("AI_PROVIDER AUSENTE não desliga rota nenhuma", () => {
    // Só o valor explícito manda. Sem `AI_PROVIDER`, a rota vale — senão
    // configurar só rotas (que é o caminho recomendado) não funcionaria.
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds-x");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "k");
    expect(getAiRoute("texto").provider).toBe("deepseek");
  });

  it("rota pedindo mock explicitamente continua sendo permitida", () => {
    // "mock" escrito à mão é intenção, não typo — é como se testa em ambiente
    // de homologação sem gastar com provedor.
    vi.stubEnv("AI_ROUTE_TEXTO", "mock:qualquer");
    expect(getAiRoute("texto").provider).toBe("mock");
    expect(resolveAiProvider("texto")?.name).toBe("mock");
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

  it("⭐ a chave que CHEGA a cada provedor é a dele — não a do outro", () => {
    // ⚠️ Achado de auditoria: os testes acima provam `getAiApiKeyFor` e o
    // guard, mas nenhum olhava o objeto CONSTRUÍDO. Uma mutação em
    // `provider.ts` que trocasse a chave passaria a suíte inteira.
    //
    // `apiKey` é `private` só em tempo de compilação; em runtime é propriedade
    // comum, e é exatamente por isso que dá para afirmar sobre ela aqui.
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_API_KEY", "chave-do-google");
    vi.stubEnv("AI_DEEPSEEK_API_KEY", "chave-do-deepseek");
    vi.stubEnv("AI_ROUTE_TEXTO", "deepseek:ds-x");
    vi.stubEnv("AI_ROUTE_IMAGEM", "gemini:gm-x");

    const texto = resolveAiProvider("texto") as any;
    const imagem = resolveAiProvider("imagem") as any;

    expect(texto.name).toBe("deepseek");
    expect(texto.apiKey).toBe("chave-do-deepseek");
    expect(texto.apiKey).not.toBe("chave-do-google");

    expect(imagem.name).toBe("gemini");
    expect(imagem.apiKey).toBe("chave-do-google");
    expect(imagem.apiKey).not.toBe("chave-do-deepseek");
  });

  it("⭐ o construtor do Gemini NÃO cai mais em AI_API_KEY sozinho", async () => {
    // Antes do roteamento, `AI_API_KEY` só podia ser do Google. Hoje
    // `AI_PROVIDER=deepseek` + `AI_API_KEY=sk-...` é config suportada, e um
    // `new GeminiProvider({ model })` com o fallback antigo mandaria a chave do
    // DeepSeek no `x-goog-api-key` para o Google.
    vi.stubEnv("AI_PROVIDER", "deepseek");
    vi.stubEnv("AI_API_KEY", "sk-chave-do-deepseek");

    const { GeminiProvider } = await import("../app/ai/core/gemini.provider");
    expect((new GeminiProvider({ model: "gm" }) as any).apiKey).toBe("");
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

// ===========================================================================
// ⚠️ O BOOT DA API TEM QUE ACEITAR A CONFIGURAÇÃO QUE A DOCUMENTAÇÃO MANDA.
//
// Achado de auditoria, e era o mais grave desta rodada: `app/lib/env.ts` tinha
// `AI_PROVIDER: z.enum(["gemini","mock"])`, e `loadEnvOrExit` faz
// `process.exit(1)`. Ou seja, `AI_PROVIDER="deepseek"` — valor que o
// `.env.example` entregue junto com o código diz ser válido — não deixaria a
// API Fastify subir. Não é o Bitz degradando: é pedido, NF-e, PDV, estoque e
// marketplace fora do ar por uma linha de `.env`.
//
// E é o cenário provável, não o exótico: como a chave legada só vale para o
// provedor nomeado em `AI_PROVIDER`, quem for só de DeepSeek é naturalmente
// empurrado a escrever exatamente isso.
// ===========================================================================
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

describe("boot da API com a configuração de roteamento", () => {
  it("⭐ AI_PROVIDER=deepseek NÃO derruba o boot", async () => {
    const { loadEnv } = await import("../app/lib/env");
    expect(() =>
      loadEnv({ ...envSemIa, AI_PROVIDER: "deepseek" } as any),
    ).not.toThrow();
  });

  it("a configuração completa do doc sobe inteira", async () => {
    const { loadEnv } = await import("../app/lib/env");
    expect(() =>
      loadEnv({
        ...envSemIa,
        AI_PROVIDER: "deepseek",
        AI_GEMINI_API_KEY: "k1",
        AI_DEEPSEEK_API_KEY: "k2",
        AI_ROUTE_TEXTO: "deepseek:um-modelo",
        AI_ROUTE_IMAGEM: "gemini:outro-modelo",
        AI_ROUTE_AUDIO: "gemini:outro-modelo",
        AI_DEEPSEEK_BASE_URL: "https://api.exemplo.com",
      } as any),
    ).not.toThrow();
  });

  it("⭐ typo na ROTA é barrado no boot — não vira mock silencioso", async () => {
    // Mesma regra que a casa já aplica a `AI_PROVIDER`. Sem ela, a API sobe,
    // o cliente pergunta e recebe eco do mock com a cota debitada.
    const { loadEnv, EnvValidationError } = await import("../app/lib/env");
    expect(() =>
      loadEnv({ ...envSemIa, AI_ROUTE_TEXTO: "deepsek:v4" } as any),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({ ...envSemIa, AI_ROUTE_AUDIO: "openai:whisper" } as any),
    ).toThrow(EnvValidationError);
  });

  it("rota vazia ou ausente continua válida", async () => {
    const { loadEnv } = await import("../app/lib/env");
    expect(() =>
      loadEnv({ ...envSemIa, AI_ROUTE_TEXTO: "" } as any),
    ).not.toThrow();
    expect(() => loadEnv({ ...envSemIa } as any)).not.toThrow();
  });

  it("rota sem modelo passa no boot — quem recusa é o runtime", async () => {
    // O boot valida o PROVEDOR; o modelo é string livre e muda com frequência.
    // Modelo ausente já degrada em runtime com `sem_modelo`.
    const { loadEnv } = await import("../app/lib/env");
    expect(() =>
      loadEnv({ ...envSemIa, AI_ROUTE_TEXTO: "deepseek" } as any),
    ).not.toThrow();
  });
});

describe("as chaves NOVAS também ficam fora do bundle", () => {
  it("⭐ nenhum arquivo de cliente cita as envs de chave por provedor", async () => {
    // `tests/ai-secret-leak.spec.ts` já faz essa varredura, mas com a lista de
    // nomes que existia quando foi escrito (`AI_API_KEY`, `getAiApiKey`,
    // `x-goog-api-key`). O roteamento criou DOIS nomes novos, e um guarda que
    // não conhece o que precisa proteger não protege. Achado de auditoria.
    //
    // Está aqui, e não lá, porque teste pré-existente não se mexe.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raiz = join(__dirname, "..");

    const listar = (dir: string): string[] => {
      const saida: string[] = [];
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) saida.push(...listar(p));
        else if (/\.(ts|tsx)$/.test(p)) saida.push(p);
      }
      return saida;
    };

    const doCliente = [
      ...listar(join(raiz, "components", "bitz")),
      ...listar(join(raiz, "hooks")),
    ];
    expect(doCliente.length).toBeGreaterThan(5);

    const proibido =
      /AI_GEMINI_API_KEY|AI_DEEPSEEK_API_KEY|getAiApiKeyFor|authorization:\s*`Bearer/i;
    for (const arquivo of doCliente) {
      expect(readFileSync(arquivo, "utf8"), arquivo).not.toMatch(proibido);
    }
  });

  it("as rotas de capacidade não viram NEXT_PUBLIC_", async () => {
    // Rota carrega o nome do provedor e do modelo — informação de servidor. E
    // `NEXT_PUBLIC_` é inlinado no build: o que entra ali é público para sempre.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const env = readFileSync(join(__dirname, "..", ".env.example"), "utf8");
    expect(env).not.toMatch(/NEXT_PUBLIC_AI_ROUTE|NEXT_PUBLIC_AI_.*_API_KEY/);
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

    // ⚠️ SEM EXIGIR ASPA COLADA. A primeira versão deste regex pedia que o
    // nome viesse logo depois de uma aspa, e com isso não enxergava o lugar
    // mais natural de hardcode neste código: dentro de um template literal,
    // como na URL do Gemini (`.../models/${this.model}:generateContent`).
    // Achado de auditoria.
    const proibidos = /\b(gemini|deepseek)-[a-z0-9][a-z0-9._-]*/i;
    for (const arquivo of arquivos) {
      const src = readFileSync(arquivo, "utf8")
        // Comentários citam nomes de propósito (ex.: avisar que o
        // `deepseek-chat` foi descontinuado). O que não pode é CÓDIGO.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, arquivo).not.toMatch(proibidos);
    }
  });

  it("a varredura acima enxergaria um hardcode de verdade", () => {
    // Guarda do guarda: um regex que não casa nada passaria em silêncio para
    // sempre. Os dois formatos abaixo são os que a versão anterior deixava
    // escapar.
    const proibidos = /\b(gemini|deepseek)-[a-z0-9][a-z0-9._-]*/i;
    expect('const m = "gemini-2.5-flash";').toMatch(proibidos);
    expect("`/models/gemini-2.5-flash:generateContent`").toMatch(proibidos);
    expect('body.model = "deepseek-v4";').toMatch(proibidos);
    // E não pode incomodar o que é legítimo.
    expect('"https://api.deepseek.com"').not.toMatch(proibidos);
    expect('const DEEPSEEK_PROVIDER_NAME = "deepseek";').not.toMatch(proibidos);
  });
});
