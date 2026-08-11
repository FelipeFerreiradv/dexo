import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { runTurn } from "../app/ai/agent/orchestrator";
import { scopeFromRequest } from "../app/ai/core/scope";
import { toDeepSeekMessages } from "../app/ai/core/deepseek.provider";
import {
  __lastMockChatInput,
  __pendingMockCompletions,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";

// ===========================================================================
// ⭐ O `toolCallId` NO HISTÓRICO DO TURNO.
//
// É a única mudança de comportamento que o roteamento de modelo fez FORA do
// módulo `app/ai/core` — e ela não tinha teste. Achado de auditoria.
//
// Por que ela existe: o Gemini casa o pedido de tool com a resposta pelo NOME
// e ignora o id; as APIs no formato da OpenAI (DeepSeek inclusive) casam pelo
// ID e recusam com HTTP 400 um `role:"tool"` sem ele. Como o histórico é
// montado UMA vez e servido a qualquer provedor, o id precisa estar lá.
//
// O risco que este arquivo cobre é o silencioso: o carimbo usa o índice para
// parear `resultados` com `completion.toolCalls`. Se o pareamento sair errado,
// nada quebra no Gemini — e no DeepSeek o modelo passa a receber a resposta de
// uma tool casada com o pedido de OUTRA.
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };

function montarDb() {
  return {
    aiConversation: {
      create: async ({ data }: any) => ({ id: "c1", summary: null, ...data }),
      findFirst: async () => null,
      update: async () => ({}),
    },
    aiMessage: { create: async ({ data }: any) => data, findMany: async () => [] },
    providerDailyUsage: {
      findUnique: async () => null,
      create: async () => ({ count: 1 }),
      upsert: async () => ({ count: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
  } as any;
}

const turno = (message: string) =>
  runTurn({
    dataOwnerId: "TENANT-A",
    actorUserId: "a",
    message,
    db: montarDb(),
    scope: scopeFromRequest(req(ADMIN)) ?? undefined,
  });

beforeEach(() => {
  // ⚠️ O vitest carrega o `.env`, que tem `AI_PROVIDER=gemini`. Sem fixar, o
  // turno roda contra o provedor real, estoura sem rede e a fila do mock nunca
  // é consumida — o teste passaria provando outra coisa.
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "mock");
  vi.stubEnv("AI_ROUTE_TEXTO", "");
  __resetMockProvider();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetMockProvider();
});

describe("o histórico entregue ao provedor", () => {
  it("⭐ a resposta de cada tool carrega o id do pedido correspondente", async () => {
    __pushMockCompletion({
      content: "",
      toolCalls: [
        { id: "call_alpha", name: "relatorio_vendas", args: { periodo: "mes" } },
      ],
    });
    __pushMockCompletion({ content: "Você vendeu R$ 10." });

    await turno("quanto eu vendi no mes passado?");

    expect(__pendingMockCompletions(), "fila do mock não consumida").toBe(0);

    const entrada = __lastMockChatInput();
    const daTool = entrada?.messages.filter((m) => m.role === "tool") ?? [];

    expect(daTool.length).toBe(1);
    expect(daTool[0].toolCallId).toBe("call_alpha");
    expect(daTool[0].toolName).toBe("relatorio_vendas");
  });

  it("⭐ com DUAS tools, cada resposta fica com o SEU id — sem embaralhar", async () => {
    // O caso que o pareamento por índice existe para acertar. Duas tools
    // diferentes, pedidas juntas, respondidas em paralelo.
    __pushMockCompletion({
      content: "",
      toolCalls: [
        { id: "call_um", name: "relatorio_vendas", args: {} },
        { id: "call_dois", name: "relatorio_estoque", args: {} },
      ],
    });
    __pushMockCompletion({ content: "pronto" });

    await turno("me da o resumo de vendas e de estoque");

    const entrada = __lastMockChatInput();
    const daTool = entrada?.messages.filter((m) => m.role === "tool") ?? [];

    expect(daTool.length).toBe(2);
    // O par (nome, id) tem que bater com o que foi pedido — não pode haver
    // troca entre as duas.
    const pares = daTool.map((m) => `${m.toolName}=${m.toolCallId}`);
    expect(pares).toEqual([
      "relatorio_vendas=call_um",
      "relatorio_estoque=call_dois",
    ]);
  });

  it("⭐ esse histórico traduzido para o dialeto da OpenAI fica válido", async () => {
    // A prova ponta a ponta do motivo de o campo existir: o que o orquestrador
    // monta tem que virar um corpo que uma API no formato da OpenAI aceite.
    __pushMockCompletion({
      content: "",
      toolCalls: [{ id: "call_x", name: "buscar_produto", args: { termo: "farol" } }],
    });
    __pushMockCompletion({ content: "achei" });

    await turno("procura farol");

    const traduzido = toDeepSeekMessages(__lastMockChatInput()!.messages);
    const daTool = traduzido.filter((m) => m.role === "tool");

    expect(daTool.length).toBe(1);
    expect(daTool[0].tool_call_id).toBe("call_x");
    // Nenhuma resposta de tool pode sair sem id: é exatamente isso que a API
    // recusa com HTTP 400.
    for (const m of traduzido) {
      if (m.role === "tool") expect(m.tool_call_id).toBeTruthy();
    }
  });
});
