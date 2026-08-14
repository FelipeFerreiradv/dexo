// BLOCO H — histórico da venda.
//
// Duas invariantes que este spec existe para travar:
//
//  1. FLAG AUSENTE ⇒ nada escreve, nada lê. É o que torna seguro subir o
//     código ANTES do DDL rodar no Supabase.
//  2. BEST-EFFORT ⇒ falha de auditoria NUNCA estoura no chamador. Todo
//     chamador está pós-commit; estourar não desfaria nada, só derrubaria o
//     fluxo de uma venda que já aconteceu.
//
// E o `diffSaleFields`, que é onde mora a armadilha real: comparar valores
// monetários e ausência tem mais casos de borda do que parece — `null` vs
// `undefined` vs `""` vs `0` vs `"0.00"`.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

function makePrisma() {
  return {
    receivableEvent: {
      create: vi.fn().mockResolvedValue({ id: "e-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

vi.mock("../app/lib/prisma", () => ({ default: makePrisma() }));
vi.mock("@/app/lib/prisma", () => ({ default: makePrisma() }));

import prismaDefault from "../app/lib/prisma";
import {
  recordSaleEvent,
  listSaleTimeline,
  isSaleTimelineEnabled,
  diffSaleFields,
} from "../app/financeiro/lib/sale-timeline";

const prisma = prismaDefault as any;
const USER = "user-owner";
const drain = () => new Promise((r) => setImmediate(r));

describe("Flag — o código sobe antes do DDL", () => {
  const ORIG = process.env.SALE_TIMELINE_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SALE_TIMELINE_ENABLED;
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.SALE_TIMELINE_ENABLED;
    else process.env.SALE_TIMELINE_ENABLED = ORIG;
  });

  it("ausente ⇒ desligada", () => {
    expect(isSaleTimelineEnabled({})).toBe(false);
    expect(isSaleTimelineEnabled({ SALE_TIMELINE_ENABLED: "true" })).toBe(
      false,
    );
    expect(isSaleTimelineEnabled({ SALE_TIMELINE_ENABLED: "1" })).toBe(true);
  });

  it("desligada ⇒ NÃO escreve (a tabela pode nem existir ainda)", async () => {
    recordSaleEvent({
      receivableId: "r-1",
      userId: USER,
      type: "CREATED",
      message: "x",
    });
    await drain();
    expect(prisma.receivableEvent.create).not.toHaveBeenCalled();
  });

  it("desligada ⇒ leitura devolve [] sem consultar", async () => {
    const out = await listSaleTimeline("r-1", USER);
    expect(out).toEqual([]);
    expect(prisma.receivableEvent.findMany).not.toHaveBeenCalled();
  });
});

describe("Escrita — best-effort e sem bloquear", () => {
  const ORIG = process.env.SALE_TIMELINE_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SALE_TIMELINE_ENABLED = "1";
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.SALE_TIMELINE_ENABLED;
    else process.env.SALE_TIMELINE_ENABLED = ORIG;
  });

  it("grava o evento com autor e detalhes", async () => {
    recordSaleEvent({
      receivableId: "r-1",
      userId: USER,
      type: "PAID",
      message: "Venda recebida",
      details: { totalAmount: 500 },
      actor: { id: "u-9", name: "Maria" },
    });
    await drain();

    const data = prisma.receivableEvent.create.mock.calls[0][0].data;
    expect(data.receivableId).toBe("r-1");
    expect(data.userId).toBe(USER);
    expect(data.type).toBe("PAID");
    expect(data.actorId).toBe("u-9");
    // Snapshot: renomear o colaborador não pode reescrever o passado.
    expect(data.actorName).toBe("Maria");
  });

  it("sem autor grava NULL — ação de sistema, não 'não sabemos'", async () => {
    recordSaleEvent({
      receivableId: "r-1",
      userId: USER,
      type: "FISCAL_EMITTED",
      message: "NFC-e autorizada",
    });
    await drain();
    const data = prisma.receivableEvent.create.mock.calls[0][0].data;
    expect(data.actorId).toBeNull();
    expect(data.actorName).toBeNull();
  });

  it("falha de banco NÃO estoura no chamador", async () => {
    // O chamador está pós-commit: a venda já aconteceu. Estourar aqui não
    // desfaria nada e ainda derrubaria o fluxo.
    prisma.receivableEvent.create.mockRejectedValueOnce(new Error("db down"));
    expect(() =>
      recordSaleEvent({
        receivableId: "r-1",
        userId: USER,
        type: "CREATED",
        message: "x",
      }),
    ).not.toThrow();
    await drain();
    await drain();
  });

  it("é fire-and-forget: devolve void, não promessa", async () => {
    // A garantia NÃO é "não inicia a escrita" — `void gravar(...)` dispara a
    // consulta no mesmo tick, igual ao `logFinanceAction` que este serviço
    // espelha. A garantia é que o chamador NÃO TEM COMO aguardar: o retorno é
    // `undefined`, então nenhum caminho de venda fica preso na auditoria.
    const retorno = recordSaleEvent({
      receivableId: "r-1",
      userId: USER,
      type: "CREATED",
      message: "x",
    });

    expect(retorno).toBeUndefined();
    await drain();
    expect(prisma.receivableEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe("Leitura — escopo e paginação", () => {
  const ORIG = process.env.SALE_TIMELINE_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SALE_TIMELINE_ENABLED = "1";
    prisma.receivableEvent.findMany.mockResolvedValue([]);
  });
  afterAll(() => {
    if (ORIG === undefined) delete process.env.SALE_TIMELINE_ENABLED;
    else process.env.SALE_TIMELINE_ENABLED = ORIG;
  });

  it("fecha o escopo de tenant no where, mais recente primeiro", async () => {
    await listSaleTimeline("r-1", USER);
    const arg = prisma.receivableEvent.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ receivableId: "r-1", userId: USER });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });

  it("limita o take — venda muito editada não vira payload sem fim", async () => {
    await listSaleTimeline("r-1", USER, { limit: 9999 });
    expect(prisma.receivableEvent.findMany.mock.calls[0][0].take).toBe(200);

    vi.clearAllMocks();
    await listSaleTimeline("r-1", USER, { limit: 0 });
    expect(prisma.receivableEvent.findMany.mock.calls[0][0].take).toBe(1);

    vi.clearAllMocks();
    await listSaleTimeline("r-1", USER);
    expect(prisma.receivableEvent.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("cursor por data quando informado", async () => {
    const antes = new Date("2026-08-01T00:00:00.000Z");
    await listSaleTimeline("r-1", USER, { before: antes });
    expect(prisma.receivableEvent.findMany.mock.calls[0][0].where).toEqual({
      receivableId: "r-1",
      userId: USER,
      createdAt: { lt: antes },
    });
  });
});

describe("diffSaleFields — o 'o quê mudou'", () => {
  it("campo NÃO enviado não conta como alteração", () => {
    // O formulário envia o objeto inteiro; ausência de chave é a única prova
    // de que o operador não mexeu naquilo.
    expect(diffSaleFields({ totalAmount: 100 }, {})).toEqual([]);
  });

  it("detecta mudança de valor com rótulo legível", () => {
    expect(diffSaleFields({ totalAmount: 100 }, { totalAmount: 150 })).toEqual([
      "Valor total",
    ]);
  });

  it("número e string numérica são o MESMO valor", () => {
    // O banco devolve Decimal como string; o formulário manda number. Sem
    // isto, toda edição registraria "Valor total" como alterado.
    expect(
      diffSaleFields({ totalAmount: 100 }, { totalAmount: "100.00" }),
    ).toEqual([]);
  });

  it("null, undefined e vazio são a mesma ausência", () => {
    expect(
      diffSaleFields({ fineAmount: null }, { fineAmount: undefined }),
    ).toEqual([]);
    expect(diffSaleFields({ document: null }, { document: "" })).toEqual([]);
  });

  it("de ausente para valor É alteração", () => {
    expect(diffSaleFields({ fineAmount: null }, { fineAmount: 50 })).toEqual([
      "Multa",
    ]);
  });

  it("datas comparam por instante, não por string", () => {
    expect(
      diffSaleFields(
        { dueDate: new Date("2026-09-01T00:00:00.000Z") },
        { dueDate: "2026-09-01T00:00:00.000Z" },
      ),
    ).toEqual([]);
  });

  it("acumula vários campos, em ordem estável", () => {
    expect(
      diffSaleFields(
        { totalAmount: 100, fineAmount: null, document: "A" },
        { totalAmount: 200, fineAmount: 10, document: "B" },
      ),
    ).toEqual(["Valor total", "Multa", "Documento"]);
  });

  it("ignora campo fora do vocabulário legível", () => {
    // `debtDetails` e afins não entram: a timeline é para o operador, não um
    // dump do payload.
    expect(diffSaleFields({ xpto: 1 }, { xpto: 2 })).toEqual([]);
  });
});
