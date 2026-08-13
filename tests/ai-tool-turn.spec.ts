import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { MAX_TOOL_ROUNDS, runTurn } from "../app/ai/agent/orchestrator";
import { scopeFromRequest } from "../app/ai/core/scope";
import {
  __lastMockChatInput,
  __pendingMockCompletions,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";
import { toGeminiContents } from "../app/ai/core/gemini.provider";
import { getToolRegistry } from "../app/ai/tools";
import { READ_TOOLS, getReadToolRegistry } from "../app/ai/tools/read";
import { MAX_TOOLS_PER_TURN, selectTools } from "../app/ai/tools/select";

// ===========================================================================
// O turno COM tools, ponta a ponta pelo orquestrador real.
//
// Cobre o que nenhum teste de unidade cobre sozinho: quantas rodadas o modelo
// tem, o que acontece quando ele esgota, se o pedido de tool volta ao histórico
// no formato que o provedor entende, e se o colaborador sem permissão é barrado
// DENTRO da conversa (e não com um 403 que encerraria o chat).
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };
const SEM_FINANCEIRO = {
  id: "c",
  dataOwnerId: "TENANT-A",
  parentUserId: "a",
  pagePermissions: { financeiro: false },
};

interface Espiao {
  db: any;
  mensagens: any[];
}

function montarDb(): Espiao {
  const conversas: any[] = [];
  const mensagens: any[] = [];
  return {
    mensagens,
    db: {
      // O RAG não é o assunto aqui: sem $queryRaw o retriever sai quieto.
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

const turno = (message: string, espiao: Espiao, user: unknown = ADMIN) =>
  runTurn({
    dataOwnerId: "TENANT-A",
    actorUserId: (user as any).id,
    message,
    db: espiao.db,
    scope: scopeFromRequest(req(user)) ?? undefined,
  });

/**
 * Uma tool falsa registrada por cima do registry real, para o teste controlar o
 * handler.
 *
 * Tem de ser o registry COMPLETO (`getToolRegistry`), que é o que o
 * orquestrador consulta desde a Fase 6 — trocar no registry de leitura
 * devolveria o handler original e o teste passaria a medir outra coisa.
 */
function trocarTool(
  nome: string,
  handler: (args: any, scope: any) => Promise<any>,
) {
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

describe("oferta de tools ao modelo", () => {
  it("turno de dados recebe um cardápio de tools", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await turno("quanto eu vendi em julho?", espiao);

    const tools = __lastMockChatInput()?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
  });

  it("cumprimento NÃO recebe tool nenhuma", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "oi" });
    await turno("bom dia", espiao);
    expect(__lastMockChatInput()?.tools).toBeUndefined();
  });

  it("⭐ sem scope, o turno roda SEM tools — nunca com tenant adivinhado", async () => {
    const espiao = montarDb();
    __pushMockCompletion({ content: "resposta" });
    await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "quanto vendi em julho?",
      db: espiao.db,
      // scope ausente de propósito
    });
    expect(__lastMockChatInput()?.tools).toBeUndefined();
  });
});

describe("seleção do subconjunto", () => {
  const registry = getReadToolRegistry();

  it("pergunta de peça puxa as tools de produto", () => {
    const nomes = selectTools("me acha o farol do gol", registry).map(
      (t) => t.name,
    );
    expect(nomes).toContain("buscar_produto");
  });

  it("pergunta de dinheiro puxa as tools financeiras", () => {
    const nomes = selectTools("quanto eu tenho a receber?", registry).map(
      (t) => t.name,
    );
    expect(nomes).toContain("contas_a_receber");
  });

  it("pergunta de erro puxa o diagnóstico", () => {
    const nomes = selectTools(
      "o pedido não apareceu, deu erro na sincronização",
      registry,
    ).map((t) => t.name);
    expect(nomes).toContain("diagnostico_operacional");
  });

  it("pergunta sem palavra-chave cai no conjunto padrão", () => {
    const nomes = selectTools("e aí, como estão as coisas", registry).map(
      (t) => t.name,
    );
    expect(nomes).toContain("buscar_produto");
    expect(nomes.length).toBeGreaterThan(0);
  });

  it("nunca passa do teto", () => {
    const nomes = selectTools(
      "peça produto pedido cliente sucata orçamento localização estoque financeiro anúncio relatório erro",
      registry,
    );
    expect(nomes.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
  });

  it("é determinístico: a mesma pergunta oferece o mesmo cardápio", () => {
    const a = selectTools("quanto vendi em julho", registry).map((t) => t.name);
    const b = selectTools("quanto vendi em julho", registry).map((t) => t.name);
    expect(b).toEqual(a);
  });
});

describe("o laço de tools", () => {
  it("executa a tool e devolve o resultado ao modelo", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({
      total: 1,
      itens: [{ sku: "001", nome: "Farol" }],
    }));
    try {
      const espiao = montarDb();
      __pushMockCompletion({
        content: "",
        toolCalls: [
          { id: "1", name: "buscar_produto", args: { consulta: "farol" } },
        ],
      });
      __pushMockCompletion({ content: "Você tem 1 farol." });

      const r = await turno("me acha o farol", espiao);

      expect(r.content).toBe("Você tem 1 farol.");
      expect(__pendingMockCompletions()).toBe(0);
      // O resultado da tool chegou ao modelo na segunda chamada.
      const mensagens = __lastMockChatInput()?.messages ?? [];
      const daTool = mensagens.find((m) => m.role === "tool");
      expect(daTool?.toolName).toBe("buscar_produto");
      expect(daTool?.content).toContain("Farol");
    } finally {
      restaurar();
    }
  });

  it("⭐ o pedido de tool volta ao histórico junto do turno do modelo", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({ total: 0 }));
    try {
      const espiao = montarDb();
      __pushMockCompletion({
        content: "",
        toolCalls: [
          { id: "1", name: "buscar_produto", args: { consulta: "x" } },
        ],
      });
      __pushMockCompletion({ content: "Não achei." });
      await turno("me acha a peça x", espiao);

      const mensagens = __lastMockChatInput()?.messages ?? [];
      const doModelo = mensagens.find(
        (m) => m.role === "assistant" && m.toolCalls?.length,
      );
      expect(doModelo?.toolCalls?.[0]?.name).toBe("buscar_produto");

      // E o provedor traduz isso para o par functionCall/functionResponse: sem
      // o pedido de volta, a conversa fica sem par e a API recusa.
      const { contents } = toGeminiContents(mensagens);
      const comChamada = contents.find((c) =>
        c.parts.some((p: any) => p.functionCall),
      );
      const comResposta = contents.find((c) =>
        c.parts.some((p: any) => p.functionResponse),
      );
      expect(comChamada?.role).toBe("model");
      expect(comResposta?.role).toBe("user");
    } finally {
      restaurar();
    }
  });

  it("a trilha de tools é persistida — sem os argumentos", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({ total: 0 }));
    try {
      const espiao = montarDb();
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
      await turno("me acha a peça", espiao);

      const assistente = espiao.mensagens.find((m) => m.role === "assistant");
      expect(assistente.toolCalls).toEqual([
        { name: "buscar_produto", ok: true, ms: expect.any(Number) },
      ]);
      expect(JSON.stringify(assistente.toolCalls)).not.toContain(
        "TERMO-DO-USUARIO",
      );
    } finally {
      restaurar();
    }
  });

  it("a fonte da tool entra em sources[]", async () => {
    const restaurar = trocarTool("buscar_produto", async () => ({
      total: 3,
      itens: [1, 2, 3],
    }));
    try {
      const espiao = montarDb();
      __pushMockCompletion({
        content: "",
        toolCalls: [
          { id: "1", name: "buscar_produto", args: { consulta: "x" } },
        ],
      });
      __pushMockCompletion({ content: "Achei 3." });
      const r = await turno("me acha a peça x", espiao);

      expect(r.sources).toEqual([
        { kind: "proprio", label: "Peças do seu catálogo", count: 3 },
      ]);
    } finally {
      restaurar();
    }
  });

  it("⭐ trava em 2 rodadas e força uma resposta em texto", async () => {
    let execucoes = 0;
    const restaurar = trocarTool("buscar_produto", async () => {
      execucoes++;
      return { total: 0 };
    });
    try {
      const espiao = montarDb();
      const pedirDeNovo = () =>
        __pushMockCompletion({
          content: "",
          toolCalls: [
            { id: "x", name: "buscar_produto", args: { consulta: "x" } },
          ],
        });
      // O modelo insiste indefinidamente...
      pedirDeNovo();
      pedirDeNovo();
      pedirDeNovo();
      // ...e a última chamada, já SEM cardápio, produz texto.
      __pushMockCompletion({ content: "Não consegui concluir a busca." });

      const r = await turno("me acha a peça x", espiao);

      expect(execucoes).toBe(MAX_TOOL_ROUNDS);
      expect(r.degraded).toBe(false);
      expect(r.content).toBe("Não consegui concluir a busca.");
      // Sem tools na última chamada, o modelo não tem como pedir de novo.
      expect(__lastMockChatInput()?.tools).toBeUndefined();
    } finally {
      restaurar();
    }
  });

  it("tool que falha não derruba o turno", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const restaurar = trocarTool("buscar_produto", async () => {
      throw new Error("banco fora");
    });
    try {
      const espiao = montarDb();
      __pushMockCompletion({
        content: "",
        toolCalls: [
          { id: "1", name: "buscar_produto", args: { consulta: "x" } },
        ],
      });
      __pushMockCompletion({ content: "Não consegui buscar agora." });

      const r = await turno("me acha a peça x", espiao);
      expect(r.degraded).toBe(false);
      expect(r.content).toBe("Não consegui buscar agora.");
      // Falha não vira fonte.
      expect(r.sources).toEqual([]);
    } finally {
      restaurar();
    }
  });
});

describe("⭐ permissão por página, dentro da conversa", () => {
  it("colaborador sem `financeiro` não obtém dado financeiro pelo Bitz", async () => {
    let executou = false;
    const restaurar = trocarTool("contas_a_receber", async () => {
      executou = true;
      return { segredo: 12345 };
    });
    try {
      const espiao = montarDb();
      __pushMockCompletion({
        content: "",
        toolCalls: [{ id: "1", name: "contas_a_receber", args: {} }],
      });
      __pushMockCompletion({
        content: "Você não tem acesso ao Financeiro. Fale com o administrador.",
      });

      const r = await turno("quanto tenho a receber?", espiao, SEM_FINANCEIRO);

      expect(executou).toBe(false);
      // O chat CONTINUA — a recusa é de uma consulta, não da conversa.
      expect(r.degraded).toBe(false);
      expect(r.content).toContain("não tem acesso");
      expect(r.sources).toEqual([]);

      const mensagens = __lastMockChatInput()?.messages ?? [];
      const daTool = mensagens.find((m) => m.role === "tool");
      expect(daTool?.content).toContain("SEM PERMISSÃO");
    } finally {
      restaurar();
    }
  });

  it("o mesmo pedido funciona para o admin", async () => {
    let executou = false;
    const restaurar = trocarTool("contas_a_receber", async () => {
      executou = true;
      return { emAberto: 100 };
    });
    try {
      const espiao = montarDb();
      __pushMockCompletion({
        content: "",
        toolCalls: [{ id: "1", name: "contas_a_receber", args: {} }],
      });
      __pushMockCompletion({ content: "R$ 100 em aberto." });

      await turno("quanto tenho a receber?", espiao, ADMIN);
      expect(executou).toBe(true);
    } finally {
      restaurar();
    }
  });

  it("toda tool declara uma página que o gate consegue avaliar", () => {
    // Uma tool com página errada seria autorizada para quem não deveria.
    const esperado: Record<string, string> = {
      buscar_produto: "produtos",
      detalhe_produto: "produtos",
      buscar_pedido: "pedidos",
      contas_a_receber: "financeiro",
      contas_a_pagar: "financeiro",
      buscar_orcamento: "financeiro",
      relatorio_vendas: "dashboard",
      relatorio_estoque: "dashboard",
      buscar_sucata: "sucatas",
      detalhe_sucata: "sucatas",
      buscar_cliente: "clientes",
      buscar_localizacao: "localizacoes",
      diagnostico_operacional: "logs",
      // ⭐ "produtos", e NÃO "logs" como o diagnóstico: peça sem anúncio e peça
      // sem localização são dado de CATÁLOGO. Atrás de `logs`, quem libera
      // Produtos para o balconista e esconde Logs perderia a pergunta mais
      // banal que ele faz — e quem tem só Logs veria o catálogo inteiro.
      pendencias_do_catalogo: "produtos",
    };
    for (const tool of READ_TOOLS) {
      expect(tool.page, tool.name).toBe(esperado[tool.name]);
    }
  });
});
