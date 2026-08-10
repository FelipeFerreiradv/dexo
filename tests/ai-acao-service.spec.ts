import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

const executarMock = vi.fn();
vi.mock("../app/ai/acoes/executores", async (orig) => {
  const real = (await orig()) as any;
  return { ...real, executarAcao: (...a: any[]) => executarMock(...a) };
});

import {
  cancelarAcao,
  confirmarAcao,
  proporAcao,
} from "../app/ai/acoes/acao.service";
import {
  PROPOSTA_VALIDA_POR_MS,
  type AiAcaoPreview,
} from "../app/ai/acoes/acao.types";

// ===========================================================================
// A escrita com confirmação humana. Fase 9.
//
// ⭐ O QUE ESTE SPEC PROTEGE, do mais caro para o mais barato:
//
//  1. PROPOR NÃO ESCREVE. Nenhuma linha de negócio é tocada até o clique.
//  2. ⭐⭐ IDEMPOTÊNCIA. Clique duplo, retry de rede ou duas abas executam UMA
//     vez. Sem isso, "cadastrar produto" vira dois produtos.
//  3. ⭐ O PAYLOAD SAI DO BANCO, nunca do cliente. É o que impede a rota de
//     confirmação de virar uma rota de escrita genérica.
//  4. ISOLAMENTO. Proposta de outro tenant — ou de outro colaborador do MESMO
//     tenant — não resolve.
//  5. VALIDADE. Proposta velha não executa: o "de X para Y" pode não ser mais
//     verdade.
// ===========================================================================

const AGORA = new Date("2026-08-10T12:00:00.000Z");

const escopo = (over?: { dataOwnerId?: string; actorId?: string }) =>
  ({
    dataOwnerId: over?.dataOwnerId ?? "t1",
    actorId: over?.actorId ?? "u1",
    can: () => true,
    canAction: () => true,
  }) as any;

const PREVIEW: AiAcaoPreview = {
  titulo: "Alterar preço",
  alvo: "Cubo de roda (SKU 4821)",
  campos: [{ campo: "Preço de venda", de: "R$ 180,00", para: "R$ 240,00" }],
};

/** Banco de mentira com a semântica do Postgres que importa aqui. */
function montarDb() {
  const linhas: any[] = [];
  let seq = 0;

  const casa = (l: any, w: any) =>
    Object.entries(w).every(([k, v]) => l[k] === v);

  return {
    linhas,
    aiAction: {
      create: async ({ data }: any) => {
        const l = { id: `a${++seq}`, resultId: null, errorCode: null, ...data };
        linhas.push(l);
        return l;
      },
      findFirst: async ({ where }: any) =>
        linhas.find((l) => casa(l, where)) ?? null,
      // ⭐ `updateMany` condicional: é o `UPDATE ... WHERE status='pendente'`
      // atômico do Postgres, e é a peça que dá a idempotência.
      updateMany: async ({ where, data }: any) => {
        const alvos = linhas.filter((l) => casa(l, where));
        for (const l of alvos) Object.assign(l, data);
        return { count: alvos.length };
      },
      update: async ({ where, data }: any) => {
        const l = linhas.find((x) => x.id === where.id);
        if (l) Object.assign(l, data);
        return l;
      },
    },
  } as any;
}

beforeEach(() => {
  executarMock.mockReset().mockResolvedValue({ resultId: "p-novo" });
});

describe("⭐ propor NÃO escreve", () => {
  it("grava a proposta como pendente e devolve o id e o preview", async () => {
    const db = montarDb();

    const p = await proporAcao({
      scope: escopo(),
      tipo: "produto.preco",
      payload: { produtoId: "p1", preco: 240 },
      preview: PREVIEW,
      conversationId: "c1",
      db,
      now: AGORA,
    });

    expect(p.id).toBeTruthy();
    expect(p.tipo).toBe("produto.preco");
    expect(p.preview).toEqual(PREVIEW);
    expect(db.linhas[0].status).toBe("pendente");
    // ⭐ NENHUM executor foi chamado. Nada mudou no sistema.
    expect(executarMock).not.toHaveBeenCalled();
  });

  it("o tenant e o ator saem do ESCOPO, nunca do payload", async () => {
    const db = montarDb();
    await proporAcao({
      scope: escopo({ dataOwnerId: "tenantX", actorId: "userX" }),
      tipo: "produto.criar",
      // Payload tentando se passar por outro tenant — é ignorado.
      payload: { dataOwnerId: "OUTRO", produto: { name: "x" } },
      preview: PREVIEW,
      db,
      now: AGORA,
    });

    expect(db.linhas[0].dataOwnerId).toBe("tenantX");
    expect(db.linhas[0].actorUserId).toBe("userX");
  });

  it("⭐ a proposta NOVA aposenta a anterior do mesmo tipo, na mesma conversa", async () => {
    // ⚠️ Conserto de um achado: "cadastra o coxim, R$ 90" → cartão A; "errei, é
    // R$ 190" → cartão B. Ele confirma B, rola a conversa para cima, vê A ainda
    // com o botão ativo e clica — SEGUNDO produto criado, com o preço errado.
    const db = montarDb();
    const comum = {
      scope: escopo(),
      tipo: "produto.criar" as const,
      preview: PREVIEW,
      conversationId: "c1",
      db,
      now: AGORA,
    };

    const a = await proporAcao({ ...comum, payload: { preco: 90 } });
    const b = await proporAcao({ ...comum, payload: { preco: 190 } });

    const linhaA = db.linhas.find((l: any) => l.id === a.id);
    const linhaB = db.linhas.find((l: any) => l.id === b.id);
    expect(linhaA.status).toBe("cancelada");
    expect(linhaA.errorCode).toBe("substituida");
    expect(linhaB.status).toBe("pendente");
  });

  it("⚠️ não aposenta proposta de OUTRO tipo, nem de outra conversa", async () => {
    const db = montarDb();
    const base = { scope: escopo(), preview: PREVIEW, payload: {}, db, now: AGORA };

    const outroTipo = await proporAcao({
      ...base,
      tipo: "cliente.criar",
      conversationId: "c1",
    });
    const outraConversa = await proporAcao({
      ...base,
      tipo: "produto.criar",
      conversationId: "c2",
    });
    await proporAcao({ ...base, tipo: "produto.criar", conversationId: "c1" });

    for (const id of [outroTipo.id, outraConversa.id]) {
      expect(db.linhas.find((l: any) => l.id === id).status).toBe("pendente");
    }
  });

  it("a validade é gravada e é a constante declarada", async () => {
    const db = montarDb();
    const p = await proporAcao({
      scope: escopo(),
      tipo: "cliente.criar",
      payload: {},
      preview: PREVIEW,
      db,
      now: AGORA,
    });

    expect(new Date(p.expiraEm).getTime()).toBe(
      AGORA.getTime() + PROPOSTA_VALIDA_POR_MS,
    );
  });
});

describe("⭐⭐ confirmar executa UMA vez", () => {
  async function pendente(db: any, over?: any) {
    return proporAcao({
      scope: escopo(),
      tipo: "produto.preco",
      payload: { produtoId: "p1", preco: 240 },
      preview: PREVIEW,
      db,
      now: AGORA,
      ...over,
    });
  }

  it("o caminho feliz executa e marca confirmada", async () => {
    const db = montarDb();
    const p = await pendente(db);

    const r = await confirmarAcao({
      id: p.id,
      scope: escopo(),
      db,
      now: AGORA,
    });

    expect(r).toEqual({
      ok: true,
      status: "confirmada",
      resultId: "p-novo",
      jaEstava: false,
    });
    expect(executarMock).toHaveBeenCalledTimes(1);
    expect(db.linhas[0].status).toBe("confirmada");
    expect(db.linhas[0].resultId).toBe("p-novo");
  });

  it("⭐⭐ CLIQUE DUPLO: a segunda chamada NÃO executa de novo", async () => {
    // Sem isto, "cadastrar produto" com dois cliques vira dois produtos — e o
    // lojista descobre no inventário, semanas depois.
    const db = montarDb();
    const p = await pendente(db);

    const a = await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });
    const b = await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    expect(executarMock).toHaveBeenCalledTimes(1);
    expect(a.ok && a.jaEstava).toBe(false);
    expect(b.ok && b.jaEstava).toBe(true);
    // A segunda devolve o MESMO resultado, e não um erro: quem clicou rápido
    // não fez nada errado.
    expect(b.ok && b.resultId).toBe("p-novo");
  });

  it("⭐⭐ DOIS CLIQUES SIMULTÂNEOS: só um executa", async () => {
    const db = montarDb();
    const p = await pendente(db);

    const [a, b] = await Promise.all([
      confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA }),
      confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA }),
    ]);

    // ⭐ O que importa: UMA execução.
    expect(executarMock).toHaveBeenCalledTimes(1);
    expect(a.ok).toBe(true);
    // O perdedor pega a ação `executando` e é mandado esperar — não recebe
    // "já foi decidida", que o deixaria sem saber se deu certo.
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.motivo).toBe("em_andamento");
    expect(b.mensagem).toMatch(/aguarde/i);
  });

  it("⭐ o que executa sai do BANCO, não do cliente", async () => {
    const db = montarDb();
    const p = await pendente(db);

    await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    const [tipo, payload] = executarMock.mock.calls[0];
    expect(tipo).toBe("produto.preco");
    expect(payload).toEqual({ produtoId: "p1", preco: 240 });
  });

  it("⭐ proposta de OUTRO TENANT não resolve", async () => {
    const db = montarDb();
    const p = await pendente(db);

    const r = await confirmarAcao({
      id: p.id,
      scope: escopo({ dataOwnerId: "t2" }),
      db,
      now: AGORA,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // "não encontrada", e não 403: não se confirma a existência de um id alheio.
    expect(r.motivo).toBe("nao_encontrada");
    expect(executarMock).not.toHaveBeenCalled();
  });

  it("⭐ proposta de OUTRO COLABORADOR do mesmo tenant não resolve", async () => {
    const db = montarDb();
    const p = await pendente(db);

    const r = await confirmarAcao({
      id: p.id,
      scope: escopo({ actorId: "u2" }),
      db,
      now: AGORA,
    });

    expect(r.ok).toBe(false);
    expect(executarMock).not.toHaveBeenCalled();
  });

  it("⭐ proposta VENCIDA não executa, e sai de pendente", async () => {
    const db = montarDb();
    const p = await pendente(db);
    const depois = new Date(AGORA.getTime() + PROPOSTA_VALIDA_POR_MS + 1);

    const r = await confirmarAcao({ id: p.id, scope: escopo(), db, now: depois });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("expirada");
    expect(executarMock).not.toHaveBeenCalled();
    // Não fica pendente para sempre oferecendo um botão que nunca funciona.
    expect(db.linhas[0].status).toBe("cancelada");
    expect(db.linhas[0].errorCode).toBe("expirada");
  });

  it("⭐ execução que estoura vira `falhou` e NÃO volta a pendente", async () => {
    // Uma escrita que quebrou no meio pode ter aplicado parte. Reoferecer o
    // botão convidaria a aplicar a outra metade duas vezes.
    executarMock.mockRejectedValue(new Error("banco fora"));
    const db = montarDb();
    const p = await pendente(db);

    const r = await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("erro_execucao");
    expect(db.linhas[0].status).toBe("falhou");
    expect(db.linhas[0].errorCode).toContain("banco fora");
    // E a mensagem que o usuário lê não é o erro do banco.
    expect(r.mensagem).not.toMatch(/banco fora/);
  });

  it("⭐⭐ a REIVINDICAÇÃO exige status pendente no `where`", async () => {
    // ⚠️ ESTE TESTE EXISTE PORQUE O ANTERIOR NÃO BASTAVA. A revisão adversarial
    // provou que apagar `status: "pendente"` do `where` deixava a suíte inteira
    // verde: o dublê muta o MESMO objeto que o perdedor já leu, então ele saía
    // pelo early-return de "já confirmada" e nunca chegava ao updateMany. Em
    // produção, com dois processos atrás do pm2, a escrita rodaria duas vezes.
    //
    // Aqui a asserção é sobre o `where` de verdade, e não sobre o efeito.
    const db = montarDb();
    const chamadas: any[] = [];
    const original = db.aiAction.updateMany;
    db.aiAction.updateMany = async (arg: any) => {
      chamadas.push(arg);
      return original(arg);
    };
    const p = await pendente(db);

    await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    const reivindicacao = chamadas.find(
      (c) => c.data?.status === "executando",
    );
    expect(reivindicacao, "não houve reivindicação").toBeTruthy();
    expect(reivindicacao.where.status).toBe("pendente");
    expect(reivindicacao.where.id).toBe(p.id);
  });

  it("⭐⭐ o ramo `count === 0` é exercitado de verdade", async () => {
    // O outro processo venceu a corrida entre a leitura e a reivindicação. Sem
    // este teste, o bloco inteiro era código morto sob teste — mesmo padrão de
    // `ai-usage.spec.ts`, que força `{count: 0}` no mock de quota.
    const db = montarDb();
    const p = await pendente(db);

    let primeira = true;
    db.aiAction.updateMany = async () => {
      if (primeira) {
        primeira = false;
        // Simula: o outro processo reivindicou, executou e concluiu.
        db.linhas[0].status = "confirmada";
        db.linhas[0].resultId = "p-do-outro";
        return { count: 0 };
      }
      return { count: 1 };
    };

    const r = await confirmarAcao({
      id: p.id,
      scope: escopo(),
      db,
      now: AGORA,
    });

    expect(executarMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jaEstava).toBe(true);
    expect(r.resultId).toBe("p-do-outro");
  });

  it("⭐ a reivindicação marca `executando`, NÃO `confirmada`", async () => {
    // Marcar "confirmada" antes de executar torna indistinguíveis "deu certo" e
    // "o processo morreu no meio" — e o segundo pareceria sucesso para sempre.
    const db = montarDb();
    const p = await pendente(db);

    let statusDurante: string | undefined;
    executarMock.mockImplementation(async () => {
      statusDurante = db.linhas[0].status;
      return { resultId: "p-novo" };
    });

    await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    expect(statusDurante).toBe("executando");
    expect(db.linhas[0].status).toBe("confirmada");
  });

  it("⭐⭐ falhar ao ANOTAR o resultado NÃO vira 'nada foi alterado'", async () => {
    // ⚠️ O achado mais grave da revisão. O `update` que grava o `resultId`
    // morava dentro do mesmo `try` da execução: com o preço já no Mercado Livre
    // e o pool do Prisma estourando na linha seguinte, a ação virava "falhou",
    // o SystemLog registrava "falhou" e o lojista lia "Nada foi alterado".
    const db = montarDb();
    const p = await pendente(db);
    db.aiAction.update = async () => {
      throw new Error("P2024 Timed out fetching a new connection");
    };

    const r = await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    // A escrita aconteceu, e a resposta diz isso.
    expect(executarMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("confirmada");
    expect(r.resultId).toBe("p-novo");
  });

  it("id que não existe: não encontrada, sem executar nada", async () => {
    const db = montarDb();
    const r = await confirmarAcao({
      id: "inexistente",
      scope: escopo(),
      db,
      now: AGORA,
    });
    expect(r.ok).toBe(false);
    expect(executarMock).not.toHaveBeenCalled();
  });
});

describe("cancelar", () => {
  it("tira de pendente e NÃO executa nada", async () => {
    const db = montarDb();
    const p = await proporAcao({
      scope: escopo(),
      tipo: "produto.criar",
      payload: {},
      preview: PREVIEW,
      db,
      now: AGORA,
    });

    const r = await cancelarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("cancelada");
    expect(db.linhas[0].status).toBe("cancelada");
    expect(executarMock).not.toHaveBeenCalled();
  });

  it("⭐ cancelar depois de confirmada NÃO desfaz nada", async () => {
    // Não existe desfazer: o produto já foi criado, o preço já foi ao
    // marketplace. Dizer "cancelado" aqui seria mentira.
    const db = montarDb();
    const p = await proporAcao({
      scope: escopo(),
      tipo: "produto.preco",
      payload: { produtoId: "p1", preco: 240 },
      preview: PREVIEW,
      db,
      now: AGORA,
    });
    await confirmarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    const r = await cancelarAcao({ id: p.id, scope: escopo(), db, now: AGORA });

    expect(r.ok).toBe(false);
    expect(db.linhas[0].status).toBe("confirmada");
  });

  it("cancelar proposta de outra pessoa não faz nada", async () => {
    const db = montarDb();
    const p = await proporAcao({
      scope: escopo(),
      tipo: "produto.criar",
      payload: {},
      preview: PREVIEW,
      db,
      now: AGORA,
    });

    const r = await cancelarAcao({
      id: p.id,
      scope: escopo({ actorId: "u2" }),
      db,
      now: AGORA,
    });

    expect(r.ok).toBe(false);
    expect(db.linhas[0].status).toBe("pendente");
  });
});
