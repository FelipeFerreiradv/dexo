import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O prisma de MÓDULO só é usado aqui pela auditoria (SystemLog), que é
// best-effort. O banco do turno chega injetado em `runTurn({ db })`.
vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { runTurn } from "../app/ai/agent/orchestrator";
import {
  DATA_ENVELOPE_CLOSE,
  DATA_ENVELOPE_OPEN,
} from "../app/ai/agent/system-prompt";
import {
  __lastMockChatInput,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";

// ===========================================================================
// O turno COM base de conhecimento, ponta a ponta pelo orquestrador real.
//
// O que estes testes fixam:
//  1. dúvida busca a base; pedido de número não paga RAG;
//  2. o conteúdo recuperado entra ENVELOPADO — é dado, nunca instrução;
//  3. `sources[]` é preenchido pelo servidor e persiste junto da resposta;
//  4. base indisponível degrada para "responde sem base", nunca para erro.
// ===========================================================================

const LINHA = {
  docId: "etiquetas-e-scan",
  heading: "Gerar etiquetas de peças",
  content: "As etiquetas saem na ordem em que você marcou.",
  hits: 3,
};

interface Espiao {
  db: any;
  consultasSql: number;
  mensagens: any[];
}

function montarDb(opts?: { queryRaw?: () => Promise<any[]> }): Espiao {
  const conversas: any[] = [];
  const mensagens: any[] = [];
  const espiao: Espiao = { db: null, consultasSql: 0, mensagens };

  espiao.db = {
    $queryRaw: async () => {
      espiao.consultasSql++;
      return opts?.queryRaw ? await opts.queryRaw() : [LINHA];
    },
    aiConversation: {
      create: async ({ data }: any) => {
        const row = { id: `c${conversas.length + 1}`, summary: null, ...data };
        conversas.push(row);
        return row;
      },
      findFirst: async ({ where }: any) =>
        conversas.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const c = conversas.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
      },
    },
    aiMessage: {
      create: async ({ data }: any) => {
        mensagens.push(data);
        return data;
      },
      findMany: async () =>
        mensagens
          .filter((m) => m.role !== "tool")
          .map((m) => ({ role: m.role, content: m.content }))
          .reverse(),
    },
    providerDailyUsage: {
      findUnique: async () => null,
      create: async () => ({ count: 1 }),
      updateMany: async () => ({ count: 1 }),
      upsert: async () => ({ count: 1 }),
    },
  };

  return espiao;
}

const turno = (message: string, espiao: Espiao) =>
  runTurn({
    dataOwnerId: "tenant-1",
    actorUserId: "user-1",
    message,
    db: espiao.db,
  });

beforeEach(() => {
  __resetMockProvider();
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "mock");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("quando a base é consultada", () => {
  it("dúvida sobre o sistema consulta a base", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("Como eu gero etiquetas das peças?", espiao);
    expect(espiao.consultasSql).toBe(1);
  });

  it("pedido de número NÃO paga RAG", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("quanto eu vendi em julho?", espiao);
    expect(espiao.consultasSql).toBe(0);
  });

  it("cumprimento NÃO paga RAG", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "oi" });
    await turno("bom dia", espiao);
    expect(espiao.consultasSql).toBe(0);
  });
});

/** System prompt que chegou de fato ao provedor no último turno. */
function ultimoSystemPrompt(): string {
  const input = __lastMockChatInput();
  return input?.messages.find((m) => m.role === "system")?.content ?? "";
}

/**
 * Quantos envelopes o prompt abre.
 *
 * A persona MENCIONA `<dados_do_sistema>` ao explicar a regra ao modelo, então
 * o prompt sempre tem UMA ocorrência mesmo sem RAG nenhum. Contar (em vez de
 * procurar) é o que separa "a regra está escrita" de "há dado envelopado".
 */
function envelopesAbertos(prompt: string): number {
  return prompt.split(DATA_ENVELOPE_OPEN).length - 1;
}

describe("⭐ o conteúdo recuperado entra como DADO, nunca como instrução", () => {
  it("vem dentro do envelope de dados do sistema", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("Como eu gero etiquetas das peças?", espiao);

    const prompt = ultimoSystemPrompt();
    // 1 = a menção na persona; a 2ª é o envelope de verdade.
    expect(envelopesAbertos(prompt)).toBe(2);

    const abre = prompt.lastIndexOf(DATA_ENVELOPE_OPEN);
    const fecha = prompt.lastIndexOf(DATA_ENVELOPE_CLOSE);
    expect(fecha).toBeGreaterThan(abre);
    // O conteúdo recuperado está DENTRO do envelope, não solto no prompt.
    expect(prompt.slice(abre, fecha)).toContain(LINHA.content);
  });

  it("o rótulo diz de onde veio, e a seção é identificada", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("Como eu gero etiquetas das peças?", espiao);

    const prompt = ultimoSystemPrompt();
    expect(prompt).toContain("base de conhecimento do Dexo");
    expect(prompt).toContain(
      "[Etiquetas e Receber por scanner > Gerar etiquetas de peças]",
    );
  });

  it("sem RAG, nenhum envelope de dado é aberto", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("quanto eu vendi em julho?", espiao);
    // Só a menção da persona — nenhum dado envelopado.
    expect(envelopesAbertos(ultimoSystemPrompt())).toBe(1);
  });
});

describe("sources[] é preenchido pelo servidor", () => {
  it("a resposta traz a fonte de conhecimento, com documento e seção", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    const r = await turno("Como eu gero etiquetas das peças?", espiao);

    expect(r.sources).toEqual([
      {
        kind: "conhecimento",
        docId: "etiquetas-e-scan",
        docTitle: "Etiquetas e Receber por scanner",
        heading: "Gerar etiquetas de peças",
      },
    ]);
  });

  it("as fontes são persistidas junto da mensagem do assistente", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("Como eu gero etiquetas das peças?", espiao);

    const assistente = espiao.mensagens.find((m) => m.role === "assistant");
    expect(assistente.sources).toHaveLength(1);
    expect(assistente.sources[0].docId).toBe("etiquetas-e-scan");
  });

  it("turno sem base grava `sources: null`, não um array vazio", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("quanto eu vendi em julho?", espiao);

    const assistente = espiao.mensagens.find((m) => m.role === "assistant");
    expect(assistente.sources).toBeNull();
  });
});

describe("degradação: base indisponível não quebra o chat", () => {
  it("erro no SQL vira resposta normal, sem fontes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const espiao = montarDb({
      queryRaw: async () => {
        throw new Error('relation "AiKnowledgeChunk" does not exist');
      },
    });
    __pushMockCompletion({ content: "resposta mesmo assim" });

    const r = await turno("Como eu gero etiquetas das peças?", espiao);
    expect(r.degraded).toBe(false);
    expect(r.content).toBe("resposta mesmo assim");
    expect(r.sources).toEqual([]);
  });

  it("base vazia (ainda não indexada) responde sem fontes", async () => {
    const espiao = montarDb({ queryRaw: async () => [] });
    __pushMockCompletion({ content: "resposta" });

    const r = await turno("Como eu gero etiquetas das peças?", espiao);
    expect(r.degraded).toBe(false);
    expect(r.sources).toEqual([]);
  });
});
