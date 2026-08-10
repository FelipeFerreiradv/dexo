import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

vi.mock("../app/ai/acoes/executores", () => ({
  executarAcao: async () => ({ resultId: "x" }),
  TIPOS_EXECUTAVEIS: [],
}));

import { confirmarAcao } from "../app/ai/acoes/acao.service";
import { runTurn } from "../app/ai/agent/orchestrator";
import { scopeFromRequest } from "../app/ai/core/scope";
import {
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";

const lerCodigo = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8");

// ===========================================================================
// PERFORMANCE E EGRESS DAS FASES 7–11.
//
// A auditoria anterior cobriu as Fases 1–6 (`docs/bitz/auditoria-perf-egress`).
// Este arquivo prende o que veio depois — e prende COMPORTAMENTO, não intenção:
// cada teste aqui falha se a otimização for desfeita, mesmo que o código
// continue "parecendo" certo.
//
// ⚠️ NENHUM deles muda regra de negócio. São todos sobre CUSTO: quantas idas ao
// banco, quantos bytes lidos, quantos bytes enviados ao provedor de IA.
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };
const escopo = () => scopeFromRequest(req(ADMIN))!;

describe("⭐ confirmar uma ação não lê o cartão inteiro do banco", () => {
  it("a projeção EXCLUI `preview` — num lote são +2 KB de JSON por clique", () => {
    // `preview` é a TABELA que o cartão desenhou: 25 peças × (nome, preço,
    // estoque, detalhe, aviso). A confirmação nunca a lê — o que executa sai do
    // `payload`. Ler para descartar é banda e memória de graça.
    let projecao: any = null;
    const db = {
      aiAction: {
        findFirst: async (args: any) => {
          projecao ??= args?.select ?? null;
          return {
            id: "a1",
            status: "pendente",
            expiresAt: new Date(Date.now() + 60_000),
            action: "produto.criar",
            payload: {},
            conversationId: null,
            resultId: null,
          };
        },
        updateMany: async () => ({ count: 1 }),
        update: async () => ({}),
      },
    } as any;

    return confirmarAcao({ id: "a1", scope: escopo(), db }).then(() => {
      expect(projecao, "a leitura voltou a trazer a linha inteira").toBeTruthy();
      expect(projecao.preview).toBeUndefined();
    });
  });

  it("⚠️ e INCLUI todos os campos que o serviço lê — senão quebra em silêncio", () => {
    // O outro lado da projeção: esquecer um campo aqui não dá erro de
    // compilação (o dublê é `any`), vira `undefined` em produção. Este teste é
    // a rede: ele lista o que o arquivo de fato consome.
    const fonte = lerCodigo("app/ai/acoes/acao.service.ts");
    const usados = new Set(
      [...fonte.matchAll(/\blinha\.(\w+)/g)].map((m) => m[1]),
    );
    const bloco = fonte.slice(fonte.indexOf("select: {"));
    for (const campo of usados) {
      expect(bloco, `\`linha.${campo}\` é lido mas não está no select`).toMatch(
        new RegExp(`\\b${campo}:\\s*true`),
      );
    }
    expect(usados.size).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------

describe("⭐ histórico e memória vão ao banco JUNTOS, não em série", () => {
  function montarDb(memorias: any[]) {
    const conversas: any[] = [];
    const mensagens: any[] = [];
    /** Ordem dos eventos: "inicio:x" e "fim:x". Prova a concorrência. */
    const eventos: string[] = [];

    const devagar = async <T,>(nome: string, valor: T): Promise<T> => {
      eventos.push(`inicio:${nome}`);
      await new Promise((r) => setTimeout(r, 12));
      eventos.push(`fim:${nome}`);
      return valor;
    };

    return {
      eventos,
      db: {
        aiMemory: {
          findMany: async () => devagar("memoria", memorias),
        },
        aiConversation: {
          create: async ({ data }: any) => {
            const row = { id: "c1", summary: null, ...data };
            conversas.push(row);
            return row;
          },
          findFirst: async () => conversas[0] ?? null,
          update: async () => ({}),
        },
        aiMessage: {
          create: async ({ data }: any) => (mensagens.push(data), data),
          findMany: async () =>
            devagar(
              "historico",
              mensagens
                .filter((m) => m.role !== "tool")
                .map((m) => ({ role: m.role, content: m.content }))
                .reverse(),
            ),
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

  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "mock");
    __resetMockProvider();
    __pushMockCompletion({ content: "ok" });
  });

  it("⭐⭐ as duas leituras COMEÇAM antes de qualquer uma terminar", () => {
    // Em série, a ordem seria inicio:historico, fim:historico, inicio:memoria.
    // Em paralelo, os dois "inicio" vêm antes do primeiro "fim" — e o turno
    // economiza uma ida e volta inteira ao Postgres, em TODA mensagem.
    const espiao = montarDb([
      {
        id: "m1",
        topico: "geral",
        conteudo: "uma regra da casa",
        createdAt: new Date(),
      },
    ]);

    return runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "bom dia",
      db: espiao.db,
      scope: escopo(),
    }).then(() => {
      const leituras = espiao.eventos.filter((e) => /historico|memoria/.test(e));
      const primeiroFim = leituras.findIndex((e) => e.startsWith("fim:"));
      const iniciosAntes = leituras
        .slice(0, primeiroFim)
        .filter((e) => e.startsWith("inicio:")).length;
      expect(
        iniciosAntes,
        `as leituras voltaram a ser sequenciais: ${leituras.join(" → ")}`,
      ).toBe(2);
    });
  });

  it("⚠️ falha ao ler a memória NÃO derruba o turno nem o histórico", () => {
    // O `.catch` mora DENTRO da promessa, não em volta do `Promise.all` —
    // senão uma falha no bloco de enriquecimento levaria junto o caminho
    // crítico. O invariante do módulo é que `runTurn` nunca lança.
    const espiao = montarDb([]);
    espiao.db.aiMemory.findMany = async () => {
      throw new Error('relation "AiMemory" does not exist');
    };
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});

    return runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "bom dia",
      db: espiao.db,
      scope: escopo(),
    }).then((r) => {
      expect(r.degraded).toBe(false);
      expect(r.content).toBe("ok");
      erro.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------

describe("⭐ egress: o que NÃO é enviado", () => {
  it("loja sem memória não acrescenta um byte ao prompt", () => {
    // Sem a guarda de lista vazia, todo tenant que nunca ensinou nada pagaria
    // a moldura (~180 tokens) em toda mensagem, para embrulhar um nada. Na
    // largada isso é 100% dos clientes.
    const orq = lerCodigo("app/ai/agent/orchestrator.ts");
    expect(orq).toMatch(/if \(memorias\.length > 0\)/);
  });

  it("⚠️ a proposta de escrita NÃO viaja para o provedor de IA", () => {
    // `acao` sai por fora do `content` da tool. Mandá-la ao modelo custaria a
    // mesma carga em TODO turno seguinte da conversa, junto do histórico — e
    // ele não precisa dos campos para dizer "confirma no cartão".
    const runner = lerCodigo("app/ai/agent/tool-runner.ts");
    expect(runner).toMatch(/paraOModelo/);
    expect(runner).toMatch(/acao = bruto\.acao \?\? undefined/);
  });

  it("a foto é reduzida no NAVEGADOR antes de subir", () => {
    // O maior lever de egress das Fases 7–8: uma foto de celular tem 3–6 MB e
    // sai da máquina do lojista, atravessa a nossa API e vai para o provedor.
    // Reduzir antes corta os três trechos de uma vez.
    const anexo = lerCodigo("hooks/use-bitz-anexo.ts");
    expect(anexo).toMatch(/createImageBitmap/);
    expect(anexo).toMatch(/MAX_PX|MAX_ANEXO_IMAGEM_PX/);
  });

  it("⚠️ uma busca por vez em `/ai/memorias`", () => {
    // O StrictMode em desenvolvimento monta duas vezes e a tela abria com duas
    // chamadas com 1 ms de diferença, as duas indo ao Postgres. Em produção não
    // duplica hoje; a trava é o que impede a duplicata de voltar por uma
    // remontagem futura.
    const hook = lerCodigo("hooks/use-bitz-memorias.ts");
    expect(hook).toMatch(/emVooRef/);
    expect(hook).toMatch(/finally/);
  });
});
