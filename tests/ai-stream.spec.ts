import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { runTurn, type AiTurnEvent } from "../app/ai/agent/orchestrator";
import { scopeFromRequest } from "../app/ai/core/scope";
import {
  MockAiProvider,
  __pushMockCompletion,
  __resetMockProvider,
  chunksDeTeste,
} from "../app/ai/core/mock.provider";
import { iterarSse } from "../app/ai/core/gemini.provider";
import { linhaNdjson, querNdjson } from "../app/ai/stream/ndjson";
import { criarLeitorNdjson } from "../lib/ndjson-stream";
import { getToolRegistry } from "../app/ai/tools";

// ===========================================================================
// Streaming NDJSON.
//
// ⭐ A INVARIANTE QUE VALE MAIS QUE TODAS AS OUTRAS JUNTAS:
//
//     o texto transmitido é PRÉVIA; o quadro `fim` é a resposta.
//
// É ela que torna impossível o usuário ler uma coisa na tela e outra ficar
// gravada no banco. Todos os outros testes daqui existem para proteger casos em
// que essa diferença apareceria: conexão que cai no meio, modelo que narra
// antes de consultar, provedor que não sabe transmitir.
//
// O outro grupo é sobre o QUADRO: um pedaço de rede não é uma linha, e a
// primeira resposta em markdown já tem `\n` dentro. Quase toda implementação
// ingênua de NDJSON quebra num desses dois.
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };

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
    },
  };
}

/** Roda um turno coletando os eventos, como a rota faria. */
async function turnoComEventos(mensagem: string, espiao = montarDb()) {
  const eventos: AiTurnEvent[] = [];
  const r = await runTurn({
    dataOwnerId: "TENANT-A",
    actorUserId: "a",
    message: mensagem,
    db: espiao.db,
    scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    onEvent: (e) => eventos.push(e),
  });
  return { eventos, resultado: r, espiao };
}

const textosDe = (eventos: AiTurnEvent[]) =>
  eventos
    .filter(
      (e): e is Extract<AiTurnEvent, { type: "texto" }> => e.type === "texto",
    )
    .map((e) => e.delta)
    .join("");

function trocarTool(nome: string, handler: (a: any, s: any) => Promise<any>) {
  const registry = getToolRegistry();
  const original = registry.get(nome)!;
  registry.set(nome, { ...original, handler });
  return () => registry.set(nome, original);
}

beforeEach(() => {
  __resetMockProvider();
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "mock");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("⭐ o texto transmitido nunca diverge da resposta gravada", () => {
  it("os deltas remontam exatamente o conteúdo final", async () => {
    __pushMockCompletion({
      content: "Você tem 3 faróis de Palio em estoque, todos na prateleira A2.",
    });

    const { eventos, resultado } = await turnoComEventos("tem farol de palio?");

    expect(textosDe(eventos)).toBe(resultado.content);
  });

  it("o que foi gravado no banco é o mesmo que o resultado devolveu", async () => {
    __pushMockCompletion({ content: "Tem 3 em estoque." });

    const { resultado, espiao } = await turnoComEventos("tem farol?");

    const assistente = espiao.mensagens.find(
      (m: any) => m.role === "assistant",
    );
    expect(assistente.content).toBe(resultado.content);
  });

  it("espaço entre palavras sobrevive à quebra em pedaços", async () => {
    // O jeito clássico de errar: quebrar por `split(" ")` e concatenar sem
    // devolver o espaço. "Você tem 3" viraria "Vocêtem3".
    const texto = "Você  tem 3 faróis\ne 2 lanternas.";
    expect(chunksDeTeste(texto).join("")).toBe(texto);
  });
});

describe("⭐ o preâmbulo antes de uma consulta é descartado", () => {
  it("texto de uma rodada de tool vira `reinicio`", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({
      total: 3,
      itens: [1, 2, 3],
    }));
    try {
      // O modelo narra e pede a tool no MESMO turno...
      __pushMockCompletion({
        content: "Deixa eu verificar seu estoque.",
        toolCalls: [
          { id: "1", name: "buscar_produto", args: { consulta: "farol" } },
        ],
      });
      // ...e só depois responde de verdade.
      __pushMockCompletion({ content: "Você tem 3 faróis." });

      const { eventos, resultado } = await turnoComEventos("tem farol?");

      const tipos = eventos.map((e) => e.type);
      expect(tipos).toContain("reinicio");
      // O `reinicio` vem DEPOIS do preâmbulo e ANTES da resposta: é isso que
      // faz a tela limpar no momento certo.
      const iReinicio = tipos.indexOf("reinicio");
      const iConsulta = tipos.indexOf("consultando");
      expect(iReinicio).toBeLessThan(iConsulta);

      // E o texto que sobra depois do reinício é a resposta.
      const depois = eventos
        .slice(iReinicio + 1)
        .filter((e) => e.type === "texto")
        .map((e: any) => e.delta)
        .join("");
      expect(depois).toBe(resultado.content);
    } finally {
      restaurar();
    }
  });

  it("sem preâmbulo, não há reinício para dar", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({ total: 0 }));
    try {
      __pushMockCompletion({
        content: "",
        toolCalls: [
          { id: "1", name: "buscar_produto", args: { consulta: "x" } },
        ],
      });
      __pushMockCompletion({ content: "Não achei." });

      const { eventos } = await turnoComEventos("tem farol?");
      expect(eventos.map((e) => e.type)).not.toContain("reinicio");
    } finally {
      restaurar();
    }
  });
});

describe("os eventos de progresso", () => {
  it("o id da conversa é o PRIMEIRO evento, antes de qualquer texto", async () => {
    __pushMockCompletion({ content: "oi" });
    const { eventos, resultado } = await turnoComEventos("bom dia");

    expect(eventos[0]).toEqual({
      type: "conversa",
      conversationId: resultado.conversationId,
    });
  });

  it("o id da conversa chega mesmo quando o turno degrada", async () => {
    // Provedor fora: o usuário perde a resposta, mas não perde a conversa.
    __pushMockCompletion({ ok: false, reason: "erro_provedor" });
    const { eventos, resultado } = await turnoComEventos("bom dia");

    expect(resultado.degraded).toBe(true);
    expect(eventos[0]).toEqual({
      type: "conversa",
      conversationId: resultado.conversationId,
    });
  });

  it("⭐ `consultando` leva o NOME da tool, nunca os argumentos", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({ total: 0 }));
    try {
      __pushMockCompletion({
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "buscar_produto",
            args: { consulta: "TERMO-DO-USUARIO" },
          },
        ],
      });
      __pushMockCompletion({ content: "Não achei." });

      const { eventos } = await turnoComEventos("me acha a peça");

      const consulta = eventos.find((e) => e.type === "consultando") as any;
      expect(consulta.tools).toEqual(["buscar_produto"]);
      expect(JSON.stringify(eventos)).not.toContain("TERMO-DO-USUARIO");
    } finally {
      restaurar();
    }
  });

  it("ouvinte que lança NÃO derruba o turno (o navegador fechou o painel)", async () => {
    __pushMockCompletion({ content: "resposta completa" });
    const espiao = montarDb();

    const r = await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "tem farol?",
      db: espiao.db,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
      onEvent: () => {
        throw new Error("socket fechado");
      },
    });

    expect(r.degraded).toBe(false);
    expect(r.content).toBe("resposta completa");
    // E a conversa foi gravada: o cliente pagou pela chamada, ela não se perde.
    expect(
      espiao.mensagens.find((m: any) => m.role === "assistant").content,
    ).toBe("resposta completa");
  });
});

describe("sem ouvinte, o turno é o de antes do streaming existir", () => {
  it("não usa chatStream e devolve o mesmo resultado", async () => {
    __pushMockCompletion({ content: "resposta" });
    const espiao = montarDb();

    const r = await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "tem farol?",
      db: espiao.db,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    });

    expect(r.content).toBe("resposta");
    expect(r.degraded).toBe(false);
  });

  it("⭐ provedor SEM chatStream entrega a resposta inteira, só sem prévia", async () => {
    // O caso de um provedor futuro que não implemente streaming. `chatStream` é
    // opcional no contrato justamente para isto — e o que não pode acontecer é
    // o turno degradar por causa da ausência de uma otimização.
    const original = (MockAiProvider.prototype as any).chatStream;
    delete (MockAiProvider.prototype as any).chatStream;
    try {
      __pushMockCompletion({ content: "resposta sem prévia" });
      const { eventos, resultado } = await turnoComEventos("tem farol?");

      expect(resultado.content).toBe("resposta sem prévia");
      expect(resultado.degraded).toBe(false);
      // Nenhum delta: o `fim` da rota é que leva o texto.
      expect(eventos.filter((e) => e.type === "texto")).toHaveLength(0);
      // O progresso que não depende do provedor continua chegando.
      expect(eventos[0].type).toBe("conversa");
    } finally {
      (MockAiProvider.prototype as any).chatStream = original;
    }
  });

  it("o chatStream do mock devolve o MESMO que o chat devolveria", async () => {
    const provider = new MockAiProvider();

    __pushMockCompletion({ content: "abc def" });
    const semStream = await provider.chat({ messages: [] });

    __pushMockCompletion({ content: "abc def" });
    const deltas: string[] = [];
    const comStream = await provider.chatStream({ messages: [] }, (d) =>
      deltas.push(d),
    );

    expect(comStream).toEqual(semStream);
    expect(deltas.join("")).toBe("abc def");
  });
});

// ---------------------------------------------------------------------------

describe("o quadro NDJSON", () => {
  it("uma linha = um objeto, mesmo com quebra de linha no texto", async () => {
    // O caso que quebra a implementação ingênua na PRIMEIRA resposta em
    // markdown: `JSON.stringify` escapa o `\n` como `\\n`, então a linha
    // continua sendo uma linha.
    const linha = linhaNdjson({
      type: "fim",
      message: { content: "Passo 1:\nPasso 2:\n\n- item" },
    });
    expect(linha.split("\n")).toHaveLength(2);
    expect(JSON.parse(linha).message.content).toContain("\n");
  });

  it("reconhece o Accept com e sem parâmetros", () => {
    expect(querNdjson("application/x-ndjson")).toBe(true);
    expect(querNdjson("application/x-ndjson, */*;q=0.1")).toBe(true);
    expect(querNdjson("APPLICATION/X-NDJSON")).toBe(true);
    expect(querNdjson("application/json")).toBe(false);
    expect(querNdjson(undefined)).toBe(false);
    expect(querNdjson(null)).toBe(false);
  });
});

describe("⭐ o leitor do front aguenta a rede de verdade", () => {
  it("JSON partido entre dois chunks é remontado", () => {
    const leitor = criarLeitorNdjson();
    // Um quadro cortado exatamente no meio de uma chave.
    expect(leitor.push('{"type":"tex')).toEqual([]);
    expect(leitor.push('to","delta":"oi"}\n')).toEqual([
      { type: "texto", delta: "oi" },
    ]);
  });

  it("vários quadros num chunk só saem todos, na ordem", () => {
    const leitor = criarLeitorNdjson();
    const saida = leitor.push(
      '{"type":"inicio"}\n{"type":"texto","delta":"a"}\n{"type":"texto","delta":"b"}\n',
    );
    expect(saida).toEqual([
      { type: "inicio" },
      { type: "texto", delta: "a" },
      { type: "texto", delta: "b" },
    ]);
  });

  it("o último quadro sem `\\n` final não se perde", () => {
    const leitor = criarLeitorNdjson();
    expect(leitor.push('{"type":"fim"}')).toEqual([]);
    expect(leitor.fim()).toEqual([{ type: "fim" }]);
  });

  it("quadro corrompido é descartado sem levar os outros junto", () => {
    const leitor = criarLeitorNdjson();
    expect(leitor.push('{quebrado\n{"type":"texto","delta":"ok"}\n')).toEqual([
      { type: "texto", delta: "ok" },
    ]);
  });

  it("linha em branco não vira quadro", () => {
    const leitor = criarLeitorNdjson();
    expect(leitor.push('\n\n{"type":"inicio"}\n\n')).toEqual([
      { type: "inicio" },
    ]);
  });
});

describe("o leitor SSE do provedor Gemini", () => {
  async function* pedacos(...partes: string[]) {
    for (const p of partes) yield p;
  }

  it("junta um evento partido entre chunks", async () => {
    const saida: unknown[] = [];
    for await (const e of iterarSse(pedacos('data: {"a', '":1}\n\n'))) {
      saida.push(e);
    }
    expect(saida).toEqual([{ a: 1 }]);
  });

  it("ignora comentário, linha vazia e [DONE]", async () => {
    const saida: unknown[] = [];
    for await (const e of iterarSse(
      pedacos(': ping\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'),
    )) {
      saida.push(e);
    }
    expect(saida).toEqual([{ a: 1 }]);
  });

  it("evento sem `\\n` no fim ainda sai", async () => {
    const saida: unknown[] = [];
    for await (const e of iterarSse(pedacos('data: {"a":1}'))) saida.push(e);
    expect(saida).toEqual([{ a: 1 }]);
  });

  it("payload ilegível é descartado, não derruba o laço", async () => {
    const saida: unknown[] = [];
    for await (const e of iterarSse(
      pedacos('data: {quebrado\n\ndata: {"a":2}\n\n'),
    )) {
      saida.push(e);
    }
    expect(saida).toEqual([{ a: 2 }]);
  });
});
