import { describe, it, expect, beforeEach, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Listagem de notas emitidas — dois contratos travados aqui:
//
// 1) REGRESSÃO (bug em PROD, reproduzido contra o banco real): buscar pela
//    CHAVE DE ACESSO (44 dígitos) derrubava a consulta inteira. O ramo
//    `{ numero: Number(term) }` mandava 3.12e+43 para uma coluna Int (INT4) e
//    o query engine lançava — a rota devolvia 500 e a tela mostrava "Erro ao
//    carregar notas fiscais" com lista vazia. Justamente a busca que acharia
//    a nota (o ramo chaveAcesso) morria junto.
//
// 2) Filtro por modelo (NF-e 55 × NFC-e 65): aditivo — ausente ⇒ where sem a
//    cláusula, exatamente como a listagem sempre funcionou.
// ──────────────────────────────────────────────────────────────────────────

const { findManyMock, countMock, groupByMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn(),
  groupByMock: vi.fn(),
}));

vi.mock("../../app/lib/prisma", () => ({
  default: {
    nfeEmitida: {
      findMany: findManyMock,
      count: countMock,
      groupBy: groupByMock,
    },
  },
}));
vi.mock("@/app/lib/prisma", () => ({
  default: {
    nfeEmitida: {
      findMany: findManyMock,
      count: countMock,
      groupBy: groupByMock,
    },
  },
}));

import { NfeRepository } from "../../app/repositories/nfe.repository";

const repo = new NfeRepository();
const CHAVE = "31260751195502000156650040000000021521124598";

function whereDaUltimaBusca() {
  return findManyMock.mock.calls[0][0].where;
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([]);
  countMock.mockResolvedValue(0);
});

describe("busca da listagem — ramo `numero` não pode estourar o Int32", () => {
  it("chave de acesso (44 dígitos): busca por chaveAcesso, SEM ramo numero", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10, search: CHAVE } as any);

    const or = whereDaUltimaBusca().OR;
    expect(or).toContainEqual({ chaveAcesso: { contains: CHAVE } });
    // O ramo que quebrava a query não pode existir de forma alguma.
    expect(or.some((c: any) => "numero" in c)).toBe(false);
  });

  it("qualquer termo numérico acima do Int32 fica fora do ramo numero", async () => {
    // 10 dígitos já estoura: 3126075119 > 2147483647.
    await repo.findEmitted("u1", {
      page: 1,
      limit: 10,
      search: "3126075119",
    } as any);
    expect(whereDaUltimaBusca().OR.some((c: any) => "numero" in c)).toBe(false);
  });

  it("REGRESSÃO: número curto continua buscando por numero", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10, search: "42" } as any);

    const or = whereDaUltimaBusca().OR;
    expect(or).toContainEqual({ numero: 42 });
    expect(or).toContainEqual({ chaveAcesso: { contains: "42" } });
  });

  it("REGRESSÃO: termo textual não injeta `{ numero: undefined }` no OR", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10, search: "VENDA" } as any);

    const or = whereDaUltimaBusca().OR;
    expect(or.some((c: any) => "numero" in c)).toBe(false);
    expect(or).toContainEqual({
      naturezaOperacao: { contains: "VENDA", mode: "insensitive" },
    });
  });

  it("limite exato do Int32 entra; um a mais não", async () => {
    await repo.findEmitted("u1", {
      page: 1,
      limit: 10,
      search: "2147483647",
    } as any);
    expect(whereDaUltimaBusca().OR).toContainEqual({ numero: 2147483647 });

    findManyMock.mockClear();
    await repo.findEmitted("u1", {
      page: 1,
      limit: 10,
      search: "2147483648",
    } as any);
    expect(whereDaUltimaBusca().OR.some((c: any) => "numero" in c)).toBe(false);
  });
});

describe("filtro por modelo na listagem", () => {
  it("modelo 65 → where.modelo = '65'", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10, modelo: "65" } as any);
    expect(whereDaUltimaBusca().modelo).toBe("65");
  });

  it("modelo 55 → where.modelo = '55'", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10, modelo: "55" } as any);
    expect(whereDaUltimaBusca().modelo).toBe("55");
  });

  it("REGRESSÃO: sem modelo ⇒ where NÃO tem a cláusula (lista os dois)", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10 } as any);
    expect("modelo" in whereDaUltimaBusca()).toBe(false);
  });

  it("valor inválido é ignorado (where sem cláusula)", async () => {
    await repo.findEmitted("u1", { page: 1, limit: 10, modelo: "99" } as any);
    expect("modelo" in whereDaUltimaBusca()).toBe(false);
  });
});
