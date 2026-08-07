import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { runTurn } from "../app/ai/agent/orchestrator";
import { REGRAS_DE_RECOMENDACAO } from "../app/ai/agent/system-prompt";
import { scopeFromRequest } from "../app/ai/core/scope";
import {
  __lastMockChatInput,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";
import { getToolRegistry } from "../app/ai/tools";
import { selectTools } from "../app/ai/tools/select";

// ===========================================================================
// ⭐ A explicabilidade, ponta a ponta.
//
// O card de fontes é a promessa desta fase: o usuário vê de onde saiu a
// resposta. A promessa só vale se o campo for do SERVIDOR — e é isso que este
// arquivo prova, nos dois sentidos:
//
//   1. o que a tool declarou chega intacto ao resultado do turno;
//   2. quando a tool declara `fontes: []` (não houve base), o orquestrador NÃO
//      inventa a fonte genérica no lugar. Um card dizendo "Referência de preço"
//      embaixo de "não tenho como sugerir" seria pior do que card nenhum.
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

const turno = (message: string, espiao: ReturnType<typeof montarDb>) =>
  runTurn({
    dataOwnerId: "TENANT-A",
    actorUserId: "a",
    message,
    db: espiao.db,
    scope: scopeFromRequest(req(ADMIN)) ?? undefined,
  });

function trocarTool(nome: string, handler: (a: any, s: any) => Promise<any>) {
  const registry = getToolRegistry();
  const original = registry.get(nome)!;
  registry.set(nome, { ...original, handler });
  return () => registry.set(nome, original);
}

/** Encadeia: o modelo pede a tool, recebe o resultado e responde em texto. */
function pedirEResponder(nome: string, args: any, resposta: string) {
  __pushMockCompletion({
    content: "",
    toolCalls: [{ id: "1", name: nome, args }],
  });
  __pushMockCompletion({ content: resposta });
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

describe("⭐ as fontes declaradas pela tool chegam ao turno", () => {
  it("a procedência rica substitui a fonte genérica de leitura", async () => {
    const restaurar = trocarTool("sugerir_preco", async () => ({
      temSugestao: true,
      precoSugerido: 300,
      fontes: [
        {
          kind: "plataforma",
          sampleSize: 12,
          confidence: "alta",
          matchKey: "farol|fiat|palio|*",
        },
      ],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder(
        "sugerir_preco",
        { titulo: "farol palio" },
        "Sugiro R$ 300,00.",
      );

      const r = await turno("por quanto vender um farol de palio?", espiao);

      expect(r.sources).toEqual([
        {
          kind: "plataforma",
          sampleSize: 12,
          confidence: "alta",
          matchKey: "farol|fiat|palio|*",
        },
      ]);
      // E fica gravado junto da resposta: reabrir a conversa mostra o mesmo.
      const assistente = espiao.mensagens.find((m) => m.role === "assistant");
      expect(assistente.sources).toEqual(r.sources);
    } finally {
      restaurar();
    }
  });

  it("⭐ `fontes: []` NÃO vira a fonte genérica — sem base, sem card", async () => {
    const restaurar = trocarTool("sugerir_preco", async () => ({
      temSugestao: false,
      motivo: "sem base",
      fontes: [],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder(
        "sugerir_preco",
        { titulo: "xpto" },
        "Não tenho base para sugerir um preço.",
      );

      const r = await turno("por quanto vender um xpto?", espiao);
      expect(r.sources).toEqual([]);
    } finally {
      restaurar();
    }
  });

  it("tool de leitura, que não declara fontes, continua com a fonte genérica", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({
      total: 3,
      itens: [1, 2, 3],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder(
        "buscar_produto",
        { consulta: "farol" },
        "Você tem 3 faróis.",
      );

      const r = await turno("me acha o farol", espiao);
      expect(r.sources).toEqual([
        { kind: "proprio", label: "Peças do seu catálogo", count: 3 },
      ]);
    } finally {
      restaurar();
    }
  });

  it("entrada torta em `fontes` é descartada, não desenhada torta", async () => {
    const restaurar = trocarTool("sugerir_preco", async () => ({
      fontes: [
        { kind: "inventado", oQueSeja: 1 },
        { kind: "plataforma", sampleSize: "muitas", confidence: "alta" },
        { kind: "externa", provider: "outro-fornecedor" },
        { kind: "proprio" },
        { kind: "regra", rule: "vale" },
      ],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder("sugerir_preco", { titulo: "farol" }, "ok");
      const r = await turno("por quanto vender um farol?", espiao);
      // Só a regra sobrevive: as outras quatro estão malformadas.
      expect(r.sources).toEqual([{ kind: "regra", rule: "vale" }]);
    } finally {
      restaurar();
    }
  });

  it("fonte externa só é aceita para o provedor que existe", async () => {
    const restaurar = trocarTool("sugerir_preco", async () => ({
      fontes: [{ kind: "externa", provider: "mercado-livre", ref: "MLB1" }],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder("sugerir_preco", { titulo: "farol" }, "ok");
      const r = await turno("por quanto vender um farol?", espiao);
      expect(r.sources).toEqual([
        { kind: "externa", provider: "mercado-livre", ref: "MLB1" },
      ]);
    } finally {
      restaurar();
    }
  });

  it("a mesma regra citada duas vezes vira UMA linha", async () => {
    const regra = { kind: "regra", rule: "Título do ML: 60 caracteres" };
    const restaurar = trocarTool("sugerir_titulo", async () => ({
      fontes: [
        { kind: "proprio", label: "Títulos do seu catálogo", count: 2 },
        regra,
        regra,
      ],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder(
        "sugerir_titulo",
        { descricao: "farol", canal: "mercado_livre" },
        "Sugestão de título.",
      );
      const r = await turno("me ajuda com o titulo do anuncio", espiao);
      expect(r.sources).toHaveLength(2);
      expect(r.sources.filter((f: any) => f.kind === "regra")).toHaveLength(1);
    } finally {
      restaurar();
    }
  });

  it("texto gigante numa fonte é cortado antes de virar linha de card", async () => {
    const restaurar = trocarTool("sugerir_preco", async () => ({
      fontes: [{ kind: "estimativa", note: "x".repeat(500) }],
    }));
    try {
      const espiao = montarDb();
      pedirEResponder("sugerir_preco", { titulo: "farol" }, "ok");
      const r = await turno("por quanto vender um farol?", espiao);
      expect((r.sources[0] as any).note.length).toBeLessThanOrEqual(160);
    } finally {
      restaurar();
    }
  });
});

describe("as regras de recomendação entram só quando cabem", () => {
  it("pergunta de preço traz o bloco de recomendação no system prompt", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "ok" });
    await turno("por quanto devo cobrar um farol de palio?", espiao);

    const system = __lastMockChatInput()?.messages?.[0]?.content ?? "";
    expect(system).toContain("COMO APRESENTAR UMA RECOMENDAÇÃO");
    expect(system).toContain("COMO USAR AS CONSULTAS");
  });

  it("pergunta de relatório NÃO paga os tokens do bloco de recomendação", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "ok" });
    await turno("quanto eu vendi em julho?", espiao);

    const system = __lastMockChatInput()?.messages?.[0]?.content ?? "";
    expect(system).toContain("COMO USAR AS CONSULTAS");
    expect(system).not.toContain("COMO APRESENTAR UMA RECOMENDAÇÃO");
  });

  it("cumprimento não traz bloco nenhum", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "oi" });
    await turno("bom dia", espiao);

    const system = __lastMockChatInput()?.messages?.[0]?.content ?? "";
    expect(system).not.toContain("COMO APRESENTAR UMA RECOMENDAÇÃO");
    expect(system).not.toContain("COMO USAR AS CONSULTAS");
  });

  it("o bloco proíbe as duas formas de estragar uma recomendação", () => {
    // Apresentar sugestão como fato, e preencher quando não houve base.
    expect(REGRAS_DE_RECOMENDACAO).toMatch(/temSugestao/);
    expect(REGRAS_DE_RECOMENDACAO).toMatch(/em torno de/);
    expect(REGRAS_DE_RECOMENDACAO).toMatch(/comoLer/);
    expect(REGRAS_DE_RECOMENDACAO).toMatch(/estimativa/);
    // E lembra que o Bitz não escreve nada no sistema nesta versão.
    expect(REGRAS_DE_RECOMENDACAO).toMatch(/não publica|não altera/);
  });
});

describe("seleção: a pergunta certa chama a tool consultiva certa", () => {
  const registry = getToolRegistry();
  const nomes = (m: string) => selectTools(m, registry).map((t) => t.name);

  it.each([
    ["por quanto devo cobrar esse farol?", "sugerir_preco"],
    ["qual o peso e a medida de um parachoque?", "sugerir_medidas"],
    ["em quais carros esse farol serve?", "sugerir_compatibilidades"],
    ["qual categoria uso pra anunciar isso?", "sugerir_categoria"],
    ["me ajuda com o titulo do anuncio", "sugerir_titulo"],
    ["o que escrever na descricao?", "sugerir_descricao"],
    [
      "qual o nome oficial dessa peca no catalogo do ml?",
      "consultar_catalogo_ml",
    ],
  ])("%s → %s", (mensagem, esperada) => {
    expect(nomes(mensagem)).toContain(esperada);
  });

  it("pergunta de leitura NÃO puxa tool consultiva à toa", () => {
    const escolhidas = selectTools("quanto eu tenho a receber?", registry);
    expect(escolhidas.map((t) => t.name)).toContain("contas_a_receber");
    expect(escolhidas.every((t) => t.kind === "read")).toBe(true);
  });
});
