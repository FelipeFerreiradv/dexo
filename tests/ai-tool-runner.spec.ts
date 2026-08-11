import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { scopeFromRequest } from "../app/ai/core/scope";
import {
  MAX_TOOL_RESULT_CHARS,
  runTool,
  truncateToolResult,
} from "../app/ai/agent/tool-runner";
import { buildRegistry, type AiTool } from "../app/ai/tools/registry";

// ===========================================================================
// O tool-runner — a fronteira entre o que o modelo PEDIU e o que o sistema FAZ.
//
// Os testes seguem a ordem dos passos porque a ORDEM é a política:
// permissão antes de validação, validação antes de execução. Trocar a ordem
// não quebraria nenhuma funcionalidade, e por isso mesmo precisa de teste.
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;

const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };
const SEM_FINANCEIRO = {
  id: "c",
  dataOwnerId: "TENANT-A",
  parentUserId: "a",
  pagePermissions: { financeiro: false },
};

let chamadas: Array<{ args: any; tenant: string }> = [];

const toolFake = (over: Partial<AiTool> = {}): AiTool => ({
  name: "consultar_coisa",
  description: "Consulta uma coisa.",
  args: z
    .object({ consulta: z.string(), limite: z.number().optional() })
    .strict(),
  kind: "read",
  page: "produtos",
  keywords: ["coisa"],
  sourceLabel: "Coisas do seu sistema",
  handler: async (args: any, scope) => {
    chamadas.push({ args, tenant: scope.dataOwnerId });
    return { total: 1, itens: [{ id: "1" }] };
  },
  ...over,
});

const registryCom = (...tools: AiTool[]) => buildRegistry(tools);

beforeEach(() => {
  chamadas = [];
  vi.restoreAllMocks();
});

describe("caminho feliz", () => {
  it("valida, executa e devolve o resultado serializado", async () => {
    const registry = registryCom(toolFake());
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "farol" } },
      { registry, scope },
    );

    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(JSON.parse(r.content)).toEqual({ total: 1, itens: [{ id: "1" }] });
  });

  it("⭐ o tenant chega ao handler pelo SCOPE, nunca pelos argumentos", async () => {
    const registry = registryCom(toolFake());
    const scope = scopeFromRequest(req(ADMIN))!;

    await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "farol" } },
      { registry, scope },
    );

    expect(chamadas[0].tenant).toBe("TENANT-A");
    expect(chamadas[0].args).toEqual({ consulta: "farol" });
  });
});

describe("⭐ o modelo não consegue escolher a loja", () => {
  it("chave extra vinda do modelo é REJEITADA, não ignorada", async () => {
    const registry = registryCom(toolFake());
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      {
        id: "1",
        name: "consultar_coisa",
        args: { consulta: "farol", userId: "OUTRO-TENANT" },
      },
      { registry, scope },
    );

    // Rejeitar (e não silenciosamente descartar) é o que torna a tentativa
    // VISÍVEL: o modelo recebe o erro e o log registra a chamada falha.
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("argumentos_invalidos");
    expect(chamadas).toHaveLength(0);
  });

  it.each(["userId", "dataOwnerId", "tenantId", "ownerId"])(
    "tentar injetar `%s` falha",
    async (chave) => {
      const registry = registryCom(toolFake());
      const scope = scopeFromRequest(req(ADMIN))!;

      const r = await runTool(
        {
          id: "1",
          name: "consultar_coisa",
          args: { consulta: "x", [chave]: "OUTRO" },
        },
        { registry, scope },
      );

      expect(r.ok).toBe(false);
      expect(chamadas).toHaveLength(0);
    },
  );
});

describe("⭐ permissão por página, dentro do chat", () => {
  it("colaborador sem `financeiro` não executa tool de financeiro", async () => {
    const registry = registryCom(toolFake({ page: "financeiro" }));
    const scope = scopeFromRequest(req(SEM_FINANCEIRO))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    expect(r.ok).toBe(false);
    expect(r.failure).toBe("sem_permissao");
    expect(chamadas).toHaveLength(0);
  });

  it("a recusa NÃO é 403 HTTP: é resultado de tool, e o chat continua", async () => {
    const registry = registryCom(toolFake({ page: "financeiro" }));
    const scope = scopeFromRequest(req(SEM_FINANCEIRO))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    // O texto instrui o modelo a explicar e a NÃO contornar.
    expect(r.content).toContain("SEM PERMISSÃO");
    expect(r.content).toMatch(/NÃO tente outra consulta/i);
    expect(r.content).toMatch(/NÃO estime/i);
  });

  it("a permissão é checada ANTES da validação de argumentos", async () => {
    // Se validasse primeiro, a mensagem de erro revelaria o formato de uma
    // consulta que este usuário não pode fazer.
    const registry = registryCom(toolFake({ page: "financeiro" }));
    const scope = scopeFromRequest(req(SEM_FINANCEIRO))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { lixo: true } },
      { registry, scope },
    );

    expect(r.failure).toBe("sem_permissao");
    expect(r.failure).not.toBe("argumentos_invalidos");
  });

  it("a mesma tool roda para quem TEM a permissão", async () => {
    const registry = registryCom(toolFake({ page: "financeiro" }));
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    expect(r.ok).toBe(true);
  });
});

describe("nunca lança", () => {
  it("tool desconhecida (nome alucinado) vira resultado, não exceção", async () => {
    const registry = registryCom(toolFake());
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "tool_que_nao_existe", args: {} },
      { registry, scope },
    );

    expect(r.ok).toBe(false);
    expect(r.failure).toBe("tool_desconhecida");
    expect(r.content).toContain("não existe");
  });

  it("handler que lança vira resultado, e o erro cru NÃO vai ao modelo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = registryCom(
      toolFake({
        handler: async () => {
          throw new Error('SELECT * FROM "Product" WHERE segredo=42 falhou');
        },
      }),
    );
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    expect(r.ok).toBe(false);
    expect(r.failure).toBe("falha_na_consulta");
    expect(r.content).not.toContain("SELECT");
    expect(r.content).not.toContain("segredo");
    expect(r.content).toMatch(/NÃO invente/i);
  });

  it("argumentos ausentes viram resultado com o que falta", async () => {
    const registry = registryCom(toolFake());
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: {} },
      { registry, scope },
    );

    expect(r.failure).toBe("argumentos_invalidos");
    expect(r.content).toContain("consulta");
  });

  it("args ausente por completo não quebra", async () => {
    const registry = registryCom(toolFake({ args: z.object({}).strict() }));
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: undefined },
      { registry, scope },
    );

    expect(r.ok).toBe(true);
  });
});

describe("serialização e egress", () => {
  it("⭐ BigInt não derruba o turno (todo COUNT(*) do queryRaw é BigInt)", async () => {
    const registry = registryCom(
      toolFake({ handler: async () => ({ total: BigInt(42) }) }),
    );
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content)).toEqual({ total: 42 });
  });

  it("resultado gigante é truncado com aviso acionável", async () => {
    const registry = registryCom(
      toolFake({ handler: async () => ({ txt: "x".repeat(20_000) }) }),
    );
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    expect(r.ok).toBe(true);
    expect(r.content).toContain("RESULTADO TRUNCADO");
    // O modelo precisa saber o que FAZER com o truncamento, não só que houve.
    expect(r.content).toMatch(/recorte mais específico/i);
  });

  it("truncateToolResult respeita o teto e não mexe no que cabe", () => {
    expect(truncateToolResult("curto")).toBe("curto");
    const grande = "y".repeat(MAX_TOOL_RESULT_CHARS + 100);
    const cortado = truncateToolResult(grande);
    expect(cortado.startsWith("y".repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
    expect(cortado).toContain("TRUNCADO");
  });

  it("resultado nulo vira `null` legível, não string vazia", async () => {
    const registry = registryCom(toolFake({ handler: async () => undefined }));
    const scope = scopeFromRequest(req(ADMIN))!;

    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: { consulta: "x" } },
      { registry, scope },
    );

    expect(r.ok).toBe(true);
    expect(r.content).toBe("null");
  });
});

describe("registry", () => {
  it("nome duplicado falha ALTO, no import — não em produção", () => {
    expect(() => registryCom(toolFake(), toolFake())).toThrow(/duplicada/);
  });
});
