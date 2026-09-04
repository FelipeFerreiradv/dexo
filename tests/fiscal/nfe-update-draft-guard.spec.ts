import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// GUARDA ATOMICA de updateDraft + persistCalculo (BUG "nota autorizada some").
//
// updateDraft agora so escreve quando o status atual e DRAFT|REJECTED, de forma
// ATOMICA (updateMany condicional ao status, dentro de $transaction, junto com a
// troca de itens). Um autosave atrasado que chegue depois da emissao ter
// reivindicado/autorizado a nota e um NO-OP: nao rebaixa o status nem troca os
// itens. persistCalculo persiste totais+itens SEM tocar no status (usado pela
// emissao, que ja esta em VALIDATING). Mockamos o prisma para provar a logica
// sem banco — mesmo padrao de nfe-sequence.spec.ts.
// ──────────────────────────────────────────────────────────────────────────

let updateManyResult = { count: 1 };
let currentRow: any = null;

const calls = {
  updateMany: [] as any[],
  itemDeleteMany: [] as any[],
  itemCreateMany: [] as any[],
  update: [] as any[],
  txOpened: 0,
};

const mockTx = {
  nfeEmitida: {
    updateMany: vi.fn(async (args: any) => {
      calls.updateMany.push(args);
      return updateManyResult;
    }),
    findFirst: vi.fn(async () => currentRow),
    update: vi.fn(async (args: any) => {
      calls.update.push(args);
      return currentRow;
    }),
  },
  nfeItem: {
    deleteMany: vi.fn(async (args: any) => {
      calls.itemDeleteMany.push(args);
      return { count: 0 };
    }),
    createMany: vi.fn(async (args: any) => {
      calls.itemCreateMany.push(args);
      return { count: args.data.length };
    }),
  },
};

vi.mock("../../app/lib/prisma", () => ({
  default: {
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      calls.txOpened++;
      return fn(mockTx);
    }),
    // Caminho SEM transacao (autosave sem troca de itens) usa prisma.nfeEmitida.*
    // direto — o updateMany condicional ao status ja e atomico sozinho. Getter
    // LAZY: le mockTx so no acesso (evita a TDZ do hoisting do vi.mock).
    get nfeEmitida() {
      return mockTx.nfeEmitida;
    },
  },
}));

import { NfeRepository } from "../../app/repositories/nfe.repository";

function makeRow(over: Record<string, any> = {}) {
  return {
    id: "nfe-1",
    userId: "user-1",
    orderId: null,
    customerId: null,
    ambiente: "PRODUCAO",
    modelo: "55",
    serie: 4,
    numero: 5,
    chaveAcesso: "3520...44",
    status: "AUTHORIZED",
    protocoloAutorizacao: "135240000000000",
    dataAutorizacao: new Date("2026-07-10T12:00:00Z"),
    destinatarioJson: { nome: "Cliente", cpfCnpj: "123" },
    totaisJson: { totalNota: 100 },
    motivoRejeicao: null,
    cStatRejeicao: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    itens: [],
    ...over,
  };
}

const ITEM = {
  codigo: "ABC-1",
  descricao: "Peca",
  ncm: "87089900",
  cfop: "5102",
  cest: null,
  origem: 0,
  unidade: "UN",
  quantidade: 1,
  valorUnitario: 10,
  valorTotal: 10,
  desconto: null,
  observacoes: null,
  tributosJson: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  updateManyResult = { count: 1 };
  currentRow = null;
  calls.updateMany = [];
  calls.itemDeleteMany = [];
  calls.itemCreateMany = [];
  calls.update = [];
  calls.txOpened = 0;
});

describe("NfeRepository.updateDraft — guarda atomica de status", () => {
  it("edita normalmente quando a nota esta editavel (count=1): troca itens e devolve a linha", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });

    const repo = new NfeRepository();
    const res = await repo.updateDraft("user-1", "nfe-1", {
      naturezaOperacao: "VENDA",
      itens: [ITEM as any],
    });

    // O gate filtra por userId + status DRAFT|REJECTED e forca DRAFT.
    expect(calls.updateMany).toHaveLength(1);
    expect(calls.updateMany[0].where).toEqual({
      id: "nfe-1",
      userId: "user-1",
      status: { in: ["DRAFT", "REJECTED"] },
    });
    expect(calls.updateMany[0].data.status).toBe("DRAFT");
    expect(calls.updateMany[0].data.motivoRejeicao).toBeNull();
    // Itens trocados (replace) porque o status era editavel.
    expect(calls.itemDeleteMany).toHaveLength(1);
    expect(calls.itemCreateMany).toHaveLength(1);
    expect(calls.itemCreateMany[0].data).toHaveLength(1);
    expect(res.id).toBe("nfe-1");
  });

  it.each(["VALIDATING", "SIGNING", "SENDING", "AUTHORIZED", "CANCELLED", "INUTILIZED"])(
    "NO-OP quando a nota ja saiu de DRAFT/REJECTED (%s): nao rebaixa status nem troca itens",
    async (status) => {
      updateManyResult = { count: 0 }; // gate nao casou → nada escrito
      currentRow = makeRow({ status });

      const repo = new NfeRepository();
      const res = await repo.updateDraft("user-1", "nfe-1", {
        naturezaOperacao: "HACK",
        itens: [ITEM as any],
      });

      // O gate foi TENTADO (atomico), mas nenhuma escrita de item ocorreu.
      expect(calls.updateMany).toHaveLength(1);
      expect(calls.itemDeleteMany).toHaveLength(0);
      expect(calls.itemCreateMany).toHaveLength(0);
      // Devolve a linha ATUAL intacta — status preservado (nota nao vira DRAFT).
      expect(res.status).toBe(status);
    },
  );

  it("prova a atomicidade: com status inelegivel, a troca de itens NUNCA roda", async () => {
    updateManyResult = { count: 0 };
    currentRow = makeRow({ status: "AUTHORIZED", itens: [] });

    const repo = new NfeRepository();
    await repo.updateDraft("user-1", "nfe-1", { itens: [ITEM as any, ITEM as any] });

    expect(calls.itemDeleteMany).toHaveLength(0);
    expect(calls.itemCreateMany).toHaveLength(0);
  });

  it("permite editar uma nota REJECTED (reemissao apos correcao)", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });

    const repo = new NfeRepository();
    await repo.updateDraft("user-1", "nfe-1", { naturezaOperacao: "X" });

    expect(calls.updateMany[0].where.status).toEqual({ in: ["DRAFT", "REJECTED"] });
  });

  it("linha inexistente / de outro tenant (count=0 e sem linha) → lanca", async () => {
    updateManyResult = { count: 0 };
    currentRow = null; // findFirst nao acha

    const repo = new NfeRepository();
    await expect(
      repo.updateDraft("user-1", "nfe-1", { naturezaOperacao: "X" }),
    ).rejects.toThrow(/não encontrado/i);
  });

  it("o gate sempre escopa por userId (multi-tenant)", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });

    const repo = new NfeRepository();
    await repo.updateDraft("outro-user", "nfe-1", { naturezaOperacao: "X" });

    expect(calls.updateMany[0].where.userId).toBe("outro-user");
  });

  it("OTIMIZACAO: sem troca de itens NAO abre transacao; com itens abre", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });
    const repo = new NfeRepository();

    // Sem itens (autosave de step): caminho rapido, updateMany atomico, sem tx.
    await repo.updateDraft("user-1", "nfe-1", { naturezaOperacao: "X" });
    expect(calls.txOpened).toBe(0);
    expect(calls.updateMany).toHaveLength(1);

    calls.txOpened = 0;
    calls.updateMany = [];
    // Com itens: precisa de $transaction (guarda + troca de itens atomicos).
    await repo.updateDraft("user-1", "nfe-1", { itens: [ITEM as any] });
    expect(calls.txOpened).toBe(1);
    expect(calls.itemCreateMany).toHaveLength(1);
  });
});

describe("NfeRepository.persistCalculo — persiste totais/itens sem tocar status", () => {
  it("grava totaisJson e itens, mas NAO grava status nem motivoRejeicao", async () => {
    currentRow = makeRow({ status: "VALIDATING" });

    const repo = new NfeRepository();
    await repo.persistCalculo("nfe-1", {
      totaisJson: { totalNota: 42 },
      itens: [ITEM as any],
    });

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].where).toEqual({ id: "nfe-1" });
    expect(calls.update[0].data).toEqual({ totaisJson: { totalNota: 42 } });
    // NUNCA toca status/motivoRejeicao (senao a nota em VALIDATING seria mexida).
    expect(calls.update[0].data).not.toHaveProperty("status");
    expect(calls.update[0].data).not.toHaveProperty("motivoRejeicao");
    // Egress: retorno descartado → só o id trafega de volta.
    expect(calls.update[0].select).toEqual({ id: true });
    // Itens re-gravados (com os tributos calculados).
    expect(calls.itemDeleteMany).toHaveLength(1);
    expect(calls.itemCreateMany).toHaveLength(1);
  });

  it("sem itens: grava so os totais, nao mexe nos itens", async () => {
    currentRow = makeRow({ status: "VALIDATING" });

    const repo = new NfeRepository();
    await repo.persistCalculo("nfe-1", { totaisJson: { totalNota: 7 } });

    expect(calls.update).toHaveLength(1);
    expect(calls.itemDeleteMany).toHaveLength(0);
    expect(calls.itemCreateMany).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// valorFrete: persistencia e leitura de volta (Cenario 8 — editar/reabrir).
// A coluna e nullable e segue o mesmo padrao condicional dos demais blocos:
// so entra no UPDATE quando veio no input (undefined = campo intocado).
// ──────────────────────────────────────────────────────────────────────────
describe("NfeRepository — valorFrete", () => {
  it("persiste o valor informado", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });
    const repo = new NfeRepository();
    await repo.updateDraft("user-1", "nfe-1", { valorFrete: 50.25 } as any);
    expect(calls.updateMany[0].data.valorFrete).toBe(50.25);
  });

  it("aceita zero (frete declarado como gratis)", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });
    const repo = new NfeRepository();
    await repo.updateDraft("user-1", "nfe-1", { valorFrete: 0 } as any);
    expect(calls.updateMany[0].data.valorFrete).toBe(0);
  });

  it("null limpa o campo", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });
    const repo = new NfeRepository();
    await repo.updateDraft("user-1", "nfe-1", { valorFrete: null } as any);
    expect(calls.updateMany[0].data.valorFrete).toBeNull();
  });

  it("TRAVA: autosave de outra etapa NAO toca no valorFrete", async () => {
    updateManyResult = { count: 1 };
    currentRow = makeRow({ status: "DRAFT" });
    const repo = new NfeRepository();
    await repo.updateDraft("user-1", "nfe-1", { naturezaOperacao: "VENDA" });
    expect("valorFrete" in calls.updateMany[0].data).toBe(false);
  });

  it("le de volta como number (Decimal do Prisma) e null como null", async () => {
    updateManyResult = { count: 1 };
    const repo = new NfeRepository();

    currentRow = makeRow({ status: "DRAFT", valorFrete: "50.25" });
    let res: any = await repo.updateDraft("user-1", "nfe-1", {});
    expect(res.valorFrete).toBe(50.25);

    currentRow = makeRow({ status: "DRAFT", valorFrete: null });
    res = await repo.updateDraft("user-1", "nfe-1", {});
    expect(res.valorFrete).toBeNull();

    // Linha legada, anterior ao ALTER: a coluna nem existe no objeto.
    currentRow = makeRow({ status: "DRAFT" });
    res = await repo.updateDraft("user-1", "nfe-1", {});
    expect(res.valorFrete).toBeNull();
  });
});
