import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("axios", () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: vi.fn(async () => ({})) } },
}));

import axios from "axios";

import { runTurn } from "../app/ai/agent/orchestrator";
import { GeminiProvider } from "../app/ai/core/gemini.provider";
import { scopeFromRequest } from "../app/ai/core/scope";
import {
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";
import prisma from "../app/lib/prisma";

// ===========================================================================
// ⭐ A chave da IA não sai daqui.
//
// Ela vive em UM lugar (env do servidor) e tem quatro rotas conhecidas para
// escapar, todas testadas abaixo:
//
//   1. o ERRO do provedor — o axios põe a URL inteira no erro, e uma chave em
//      query string iria junto para o log e para o `detail`;
//   2. o CORPO da resposta de erro do provedor, que ecoa o prompt;
//   3. o LOG de auditoria, que é gravado em SystemLog e visível ao suporte;
//   4. o BUNDLE do navegador, se alguém um dia ler a chave de um `NEXT_PUBLIC_`.
//
// A quarta é a mais perigosa das quatro porque é irreversível: chave que foi
// para o bundle já vazou para todo mundo que abriu a página, e trocar a chave é
// a única correção.
// ===========================================================================

const CHAVE = "AIzaSyCHAVE-SUPER-SECRETA-DO-CLIENTE-123";
const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };

beforeEach(() => {
  __resetMockProvider();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("⭐ 1 e 2. a falha do provedor não carrega a chave nem o prompt", () => {
  const provider = () =>
    new GeminiProvider({
      apiKey: CHAVE,
      model: "gemini-x",
      baseUrl: "https://provedor.exemplo",
    });

  it("a chave vai em HEADER — a URL não a contém", async () => {
    (axios.post as any).mockResolvedValue({
      data: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    });

    await provider().chat({ messages: [{ role: "user", content: "oi" }] });

    const [url, , config] = (axios.post as any).mock.calls[0];
    expect(url).not.toContain(CHAVE);
    expect(config.headers["x-goog-api-key"]).toBe(CHAVE);
  });

  it("erro HTTP: o `detail` tem só o status, sem URL, sem corpo, sem chave", async () => {
    (axios.post as any).mockRejectedValue({
      // O que o axios entrega de verdade: URL completa e corpo ecoado.
      config: { url: `https://provedor.exemplo/v1beta?key=${CHAVE}` },
      response: {
        status: 400,
        data: {
          error: {
            message: `API key not valid: ${CHAVE}. Prompt: "quanto vendi em julho"`,
          },
        },
      },
    });

    const r = await provider().chat({
      messages: [{ role: "user", content: "quanto vendi em julho" }],
    });

    expect(r.ok).toBe(false);
    const tudo = JSON.stringify(r);
    expect(tudo).not.toContain(CHAVE);
    expect(tudo).not.toContain("quanto vendi em julho");
    expect((r as any).detail).toBe("HTTP 400");
  });

  it("erro de rede: só o código, e nada mais", async () => {
    (axios.post as any).mockRejectedValue({
      code: "ECONNREFUSED",
      config: { url: `https://provedor.exemplo?key=${CHAVE}` },
    });

    const r = await provider().chat({ messages: [] });
    expect(JSON.stringify(r)).not.toContain(CHAVE);
  });

  it("o mesmo vale no caminho de streaming", async () => {
    (axios.post as any).mockRejectedValue({
      response: {
        status: 403,
        data: { error: { message: `bad key ${CHAVE}` } },
      },
      config: { url: `https://provedor.exemplo?key=${CHAVE}` },
    });

    const r = await provider().chatStream({ messages: [] }, () => {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CHAVE);
  });

  it("a resposta do modelo não é ecoada crua quando tem shape inesperado", async () => {
    (axios.post as any).mockResolvedValue({
      data: { lixo: `contendo ${CHAVE} por acidente` },
    });

    const r = await provider().chat({ messages: [] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CHAVE);
  });
});

describe("⭐ 3. nem a resposta ao usuário nem o log de auditoria levam a chave", () => {
  function montarDb() {
    const conversas: any[] = [];
    const mensagens: any[] = [];
    return {
      mensagens,
      db: {
        aiConversation: {
          create: async ({ data }: any) => {
            const row = {
              id: `c${conversas.length + 1}`,
              summary: null,
              ...data,
            };
            conversas.push(row);
            return row;
          },
          findFirst: async () => null,
          update: async () => ({}),
        },
        aiMessage: {
          create: async ({ data }: any) => {
            mensagens.push(data);
            return data;
          },
          findMany: async () => [],
        },
        providerDailyUsage: {
          findUnique: async () => null,
          create: async () => ({ count: 1 }),
          updateMany: async () => ({ count: 1 }),
          upsert: async () => ({ count: 1 }),
        },
      },
    };
  }

  it("provedor fora do ar: a mensagem degradada é legível e muda", async () => {
    vi.stubEnv("AI_PROVIDER", "mock");
    vi.stubEnv("AI_API_KEY", CHAVE);
    const espiao = montarDb();
    __pushMockCompletion({
      ok: false,
      reason: "erro_provedor",
      detail: `HTTP 400 key=${CHAVE}`,
    });

    const r = await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "quanto vendi?",
      db: espiao.db,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    });

    expect(r.degraded).toBe(true);
    // A mensagem que o lojista lê é escrita por nós, não pelo provedor.
    expect(r.content).not.toContain(CHAVE);
    expect(JSON.stringify(espiao.mensagens)).not.toContain(CHAVE);
  });

  it("nada gravado em SystemLog contém a chave", async () => {
    vi.stubEnv("AI_PROVIDER", "mock");
    vi.stubEnv("AI_API_KEY", CHAVE);
    const espiao = montarDb();
    __pushMockCompletion({ content: "ok" });

    await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "oi",
      db: espiao.db,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    });

    // A auditoria é fire-and-forget; o que importa é o conteúdo do que foi
    // (ou seria) gravado.
    const gravado = JSON.stringify(
      (prisma as any).systemLog.create.mock.calls ?? [],
    );
    expect(gravado).not.toContain(CHAVE);
  });
});

describe("⭐ 4. a chave não tem caminho para o navegador", () => {
  const raiz = join(__dirname, "..");

  const listar = (dir: string): string[] => {
    const saida: string[] = [];
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) saida.push(...listar(caminho));
      else if (/\.(ts|tsx)$/.test(caminho)) saida.push(caminho);
    }
    return saida;
  };

  it("nenhuma env do Bitz com credencial é NEXT_PUBLIC_", () => {
    const constantes = readFileSync(
      join(raiz, "app", "ai", "core", "ai-constants.ts"),
      "utf8",
    );
    // A única NEXT_PUBLIC_ do módulo é o kill-switch booleano.
    const publicas = constantes.match(/NEXT_PUBLIC_[A-Z_]+/g) ?? [];
    expect([...new Set(publicas)]).toEqual(["NEXT_PUBLIC_AI_MODULE_ENABLED"]);
  });

  it("⭐ nenhum arquivo de CLIENTE lê a chave", () => {
    // `components/` e `hooks/` viram bundle. Um import de `getAiApiKey` ali
    // colocaria a chave no JavaScript que o navegador baixa.
    const doCliente = [
      ...listar(join(raiz, "components", "bitz")),
      ...listar(join(raiz, "hooks")),
      join(raiz, "lib", "ndjson-stream.ts"),
    ];
    for (const arquivo of doCliente) {
      const src = readFileSync(arquivo, "utf8");
      expect(src, arquivo).not.toMatch(/getAiApiKey|AI_API_KEY|x-goog-api-key/);
      expect(src, arquivo).not.toContain("ai/core/ai-constants");
    }
  });

  it("o front nem sabe qual provedor roda por trás", () => {
    // `GET /ai/entitlement` devolve `{enabled}` e nada mais — contrato mínimo
    // de propósito (ai.routes.ts). Modelo e provedor são detalhe do servidor.
    const hook = readFileSync(
      join(raiz, "hooks", "use-bitz-entitlement.ts"),
      "utf8",
    );
    expect(hook).not.toMatch(/gemini|AI_MODEL|provider/i);
  });
});
