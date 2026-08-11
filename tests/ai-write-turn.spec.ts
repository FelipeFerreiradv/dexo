import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { runTurn } from "../app/ai/agent/orchestrator";
import { REGRAS_DE_ESCRITA } from "../app/ai/agent/system-prompt";
import {
  __lastMockChatInput,
  __pendingMockCompletions,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";
import { getToolRegistry } from "../app/ai/tools";
import { selectTools } from "../app/ai/tools/select";

// ===========================================================================
// O turno COM escrita, pelo orquestrador real. Fase 9.
//
// O que este spec fixa:
//   1. ⭐ ZERO REGRESSÃO — sem tool de escrita no turno, o resultado não tem
//      `acoes` e o prompt não tem as regras de escrita. Um turno de consulta
//      continua byte a byte o de antes;
//   2. ⭐ a proposta SOBE para a UI (`AiTurnResult.acoes`);
//   3. ⭐ as REGRAS DE ESCRITA entram só quando há como escrever — e a mais
//      importante delas é "não diga que fez";
//   4. a proposta NÃO é gravada na mensagem: `AiMessage` guarda a conversa, a
//      trilha da ação mora em `AiAction`.
// ===========================================================================

const escopo = () =>
  ({
    dataOwnerId: "t1",
    actorId: "u1",
    can: () => true,
    canAction: () => true,
  }) as any;

interface Espiao {
  db: any;
  mensagens: any[];
  acoesGravadas: any[];
}

function montarDb(): Espiao {
  const conversas: any[] = [];
  const mensagens: any[] = [];
  const acoesGravadas: any[] = [];
  const espiao: Espiao = { db: null, mensagens, acoesGravadas };

  espiao.db = {
    $queryRaw: async () => [],
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
    aiAction: {
      create: async ({ data }: any) => {
        const row = { id: `a${acoesGravadas.length + 1}`, ...data };
        acoesGravadas.push(row);
        return row;
      },
      // Aposentar a proposta anterior do mesmo tipo (ver `proporAcao`).
      updateMany: async ({ where, data }: any) => {
        const alvos = acoesGravadas.filter((l) =>
          Object.entries(where).every(([k, v]: [string, any]) =>
            v && typeof v === "object" && Array.isArray(v.in)
              ? v.in.includes((l as any)[k])
              : (l as any)[k] === v,
          ),
        );
        for (const l of alvos) Object.assign(l, data);
        return { count: alvos.length };
      },
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

/**
 * ⚠️ O `proporAcao` real usa o prisma de MÓDULO, não o `db` injetado do turno
 * (a proposta não faz parte da transação do turno). Aqui ele é redirecionado
 * para o espião — é o que permite ver a linha gravada.
 */
vi.mock("../app/ai/acoes/acao.service", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    proporAcao: (input: any) => real.proporAcao({ ...input, db: dbAtual }),
  };
});

let dbAtual: any = null;

const turno = (message: string, espiao: Espiao) =>
  runTurn({
    dataOwnerId: "t1",
    actorUserId: "u1",
    message,
    db: espiao.db,
    scope: escopo(),
  });

const systemPrompt = () =>
  __lastMockChatInput()?.messages.find((m) => m.role === "system")?.content ??
  "";

beforeEach(() => {
  __resetMockProvider();
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "mock");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("⭐ zero regressão: turno sem escrita", () => {
  it("não tem `acoes` no resultado", async () => {
    const espiao = montarDb();
    dbAtual = espiao.db;
    __pushMockCompletion({ content: "vendeu X" });

    const r = await turno("quanto eu vendi em julho?", espiao);

    expect("acoes" in r).toBe(false);
    expect(__pendingMockCompletions()).toBe(0);
  });

  it("⭐ o prompt NÃO carrega as regras de escrita", async () => {
    // Elas custam ~250 tokens de entrada. Num turno que não pode escrever, são
    // 250 tokens explicando como não fazer uma coisa que não é oferecida.
    const espiao = montarDb();
    dbAtual = espiao.db;
    __pushMockCompletion({ content: "oi" });

    await turno("bom dia", espiao);

    expect(systemPrompt()).not.toContain("COMO PREPARAR UMA ALTERAÇÃO");
  });
});

describe("⭐ turno COM escrita", () => {
  /** A tool que o modelo vai pedir, com args válidos. */
  const pedirCadastro = () =>
    __pushMockCompletion({
      content: "",
      toolCalls: [
        {
          id: "tc1",
          name: "cadastrar_produto",
          args: { nome: "Farol dianteiro esquerdo", preco: 320, estoque: 1 },
        },
      ],
    });

  it("a proposta SOBE no resultado do turno", async () => {
    const espiao = montarDb();
    dbAtual = espiao.db;
    pedirCadastro();
    __pushMockCompletion({
      content: "Preparei o cadastro. Confere e confirma no cartão?",
    });

    const r = await turno("cadastra essa peca: farol dianteiro esquerdo, 320, 1 un", espiao);

    expect(r.acoes).toHaveLength(1);
    expect(r.acoes![0].preview.titulo).toBe("Cadastrar peça");
    expect(__pendingMockCompletions()).toBe(0);
  });

  it("⭐ NADA foi escrito: só a linha da proposta, com status pendente", async () => {
    const espiao = montarDb();
    dbAtual = espiao.db;
    pedirCadastro();
    __pushMockCompletion({ content: "preparei" });

    await turno("cadastra essa peca nova", espiao);

    expect(espiao.acoesGravadas).toHaveLength(1);
    expect(espiao.acoesGravadas[0].status).toBe("pendente");
  });

  it("⭐ as REGRAS DE ESCRITA entram no prompt", async () => {
    const espiao = montarDb();
    dbAtual = espiao.db;
    pedirCadastro();
    __pushMockCompletion({ content: "preparei" });

    await turno("cadastra essa peca nova", espiao);

    const p = systemPrompt();
    expect(p).toContain("COMO PREPARAR UMA ALTERAÇÃO");
    // A linha que impede o pior erro possível.
    expect(p).toMatch(/NUNCA diga que fez/i);
    // E a que impede a confirmação por texto.
    expect(p).toMatch(/a confirmação é o botão/i);
  });

  it("⭐ a proposta NÃO é gravada dentro da mensagem da conversa", async () => {
    // `AiMessage` guarda a conversa; a trilha da ação mora em `AiAction`, que
    // tem status, decisão e resultado. Duplicar criaria duas verdades.
    const espiao = montarDb();
    dbAtual = espiao.db;
    pedirCadastro();
    __pushMockCompletion({ content: "preparei" });

    await turno("cadastra essa peca nova", espiao);

    const doAssistente = espiao.mensagens.filter(
      (m) => m.role === "assistant",
    );
    for (const m of doAssistente) {
      expect(m.content).not.toContain("Cadastrar peça");
      expect(JSON.stringify(m.toolCalls ?? [])).not.toContain("preview");
    }
  });
});

describe("as regras de escrita, como texto", () => {
  it("proíbem dizer que fez, aceitar 'sim' e encadear duas escritas", () => {
    expect(REGRAS_DE_ESCRITA).toMatch(/NUNCA diga que fez/i);
    expect(REGRAS_DE_ESCRITA).toMatch(/cadastrei/i);
    expect(REGRAS_DE_ESCRITA).toMatch(/NÃO é confirmação/i);
    expect(REGRAS_DE_ESCRITA).toMatch(/Uma preparação por vez/i);
  });

  it("⭐ dizem, com todas as letras, que o Bitz não apaga", () => {
    expect(REGRAS_DE_ESCRITA).toMatch(/NÃO apaga/i);
  });

  it("exigem o SKU exato em vez do palpite", () => {
    expect(REGRAS_DE_ESCRITA).toMatch(/SKU exato/i);
    expect(REGRAS_DE_ESCRITA).toMatch(/Nunca escolha a mais parecida/i);
  });
});

describe("o catálogo do turno", () => {
  it("⭐ 'cadastra essa peça' seleciona a tool de escrita", () => {
    const nomes = selectTools(
      "cadastra essa peca no sistema",
      getToolRegistry(),
    ).map((t: any) => t.name);
    expect(nomes).toContain("cadastrar_produto");
  });

  it("⭐ 'qual o preço do farol?' NÃO seleciona a de alterar preço", () => {
    // Numa frase ambígua, consultar tem que vencer alterar: errar mostrando um
    // número é recuperável, errar propondo uma alteração assusta o lojista.
    const nomes = selectTools(
      "qual o preco do farol do palio?",
      getToolRegistry(),
    ).map((t: any) => t.name);
    expect(nomes).not.toContain("alterar_preco_produto");
  });
});

describe("⭐⭐ seleção: as frases REAIS do lojista", () => {
  // ⚠️ A REVISÃO ADVERSARIAL PEGOU OS DOIS LADOS DISTO.
  //
  // PARA MENOS: as chaves eram pares ("alterar preco"), e a comparação é
  // substring sobre a frase inteira — "altera O preco" já não casava. Três das
  // quatro tools de escrita eram inalcançáveis nas frases naturais: 2 acertos em
  // 18 frases testadas.
  //
  // PARA MAIS: com chaves soltas, "cadastro de cliente sumiu" arrastava a tool
  // de cadastrar PEÇA para dentro de um turno de consulta.
  //
  // A regra que resolve os dois: tool de escrita precisa de DOIS sinais
  // (MIN_PONTOS_ESCRITA em select.ts) — verbo de mudança + objeto.
  const nomes = (m: string) =>
    selectTools(m, getToolRegistry()).map((t: any) => t.name);

  const PEDE_ESCRITA: Array<[string, string]> = [
    ["altera o preco dessa peca para 240", "alterar_preco_produto"],
    ["muda o preco desse farol pra 300", "alterar_preco_produto"],
    ["troca o preco da 4821", "alterar_preco_produto"],
    ["quero atualizar o preco de venda", "alterar_preco_produto"],
    ["reajusta o valor dessa peca", "alterar_preco_produto"],
    ["cadastra essa peca no sistema", "cadastrar_produto"],
    ["cria um produto novo aqui", "cadastrar_produto"],
    ["preciso incluir uma peca nova", "cadastrar_produto"],
    ["cadastra um cliente novo, Maria Souza", "cadastrar_cliente"],
    ["cria o cliente oficina do joao", "cadastrar_cliente"],
    ["ajusta o estoque dessa peca pra 7", "ajustar_estoque_produto"],
    ["cadastra essas pecas: farol, lanterna, retrovisor", "cadastrar_pecas_em_massa"],
    ["cria os produtos que eu tirei do gol", "cadastrar_pecas_em_massa"],
    ["corrige a quantidade em estoque", "ajustar_estoque_produto"],
    ["chegou mais 3 unidades no estoque", "ajustar_estoque_produto"],
  ];

  it.each(PEDE_ESCRITA)("'%s' oferece %s", (frase, esperada) => {
    expect(nomes(frase)).toContain(esperada);
  });

  // ⚠️ O QUE ESTA LISTA COBRE, E O QUE ELA NÃO COBRE.
  //
  // Ela prende as frases em que oferecer uma tool de escrita seria ERRADO: a
  // pessoa está claramente consultando. Não tenta cobrir toda frase ambígua —
  // "cadastro de cliente sumiu" tem verbo de criação E o objeto, e por isso
  // OFERECE `cadastrar_cliente`. Isso é tolerado de propósito: oferecer não é
  // chamar, o prompt manda preparar e nunca afirmar, e o cartão exige o clique.
  // Apertar mais aqui derrubaria as frases legítimas de cadastro.
  const SO_CONSULTA = [
    "qual o preco do farol do palio?",
    "quanto tenho de estoque do cubo de roda",
    "quanto eu vendi em julho",
    "quais pecas estao com estoque baixo",
    "me mostra os anuncios pausados",
    "quanto custa o cubo de roda dianteiro",
    // ⚠️ Estas três a revisão adversarial reproduziu com o registry de produção:
    // as chaves do LOTE eram vocabulário de consulta (`lista`, `todas`,
    // `desmont`, `pecas`) e a tool de ESCRITA EM MASSA liderava o cardápio.
    "lista todas as pecas com estoque baixo",
    "me mostra todas as pecas do gol",
    "quais lotes ainda nao foram desmontados",
  ];

  it.each(SO_CONSULTA)("'%s' NÃO oferece tool de escrita nenhuma", (frase) => {
    const oferecidas = selectTools(frase, getToolRegistry());
    const escrita = oferecidas.filter((t: any) => t.kind === "write");
    expect(
      escrita.map((t: any) => t.name),
      "tool de escrita num turno de consulta",
    ).toEqual([]);
  });
});
