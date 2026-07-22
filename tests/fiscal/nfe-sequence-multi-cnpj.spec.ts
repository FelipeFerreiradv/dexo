import { describe, it, expect, beforeEach, vi } from "vitest";

// Multi-CNPJ — numeração POR EMITENTE (companyFiscalConfigId) na NfeSequence.
// Invariantes centrais:
//  1. SEM opts, o caminho é o LEGADO byte-idêntico (nenhuma menção a
//     companyFiscalConfigId no SQL) — regressão zero para 1-CNPJ.
//  2. COM opts, o SELECT filtra por emitente (com adoção da linha legada NULL
//     apenas quando isDefaultConfig) e o UPDATE grava o configId (adoção
//     idempotente) — o contador do CNPJ padrão continua de onde parou.
//  3. O retry pós-ON CONFLICT usa o SELECT NOVO (nunca o legado) — é o que
//     impede número duplicado na janela de deploy em que o unique antigo
//     ainda está de pé.

const h = vi.hoisted(() => {
  const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
  const selectResponses: Array<Array<{ id: string; proximoNumero: number }>> =
    [];
  // INSERT com RETURNING: default = inseriu ([{id}]); scriptar [] p/ conflito.
  const insertResponses: Array<Array<{ id: string }>> = [];
  const defaultImpl = async (
    sql: string,
    ...params: unknown[]
  ): Promise<any> => {
    queryCalls.push({ sql, params });
    if (sql.trimStart().startsWith("SELECT")) {
      return selectResponses.length > 0 ? selectResponses.shift() : [];
    }
    if (sql.trimStart().startsWith("INSERT")) {
      return insertResponses.length > 0
        ? insertResponses.shift()
        : [{ id: "seq-new" }];
    }
    return [];
  };
  const tx = { $queryRawUnsafe: vi.fn(defaultImpl) };
  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    nfeSequence: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  return { prisma, queryCalls, selectResponses, insertResponses, tx, defaultImpl };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));

import { NfeSequenceService } from "../../app/fiscal/sequence/nfe-sequence.service";

const OPTS_DEFAULT = { companyFiscalConfigId: "cfg-A", isDefaultConfig: true };
const OPTS_SECUNDARIA = {
  companyFiscalConfigId: "cfg-B",
  isDefaultConfig: false,
};

beforeEach(() => {
  h.queryCalls.length = 0;
  h.selectResponses.length = 0;
  h.insertResponses.length = 0;
  h.prisma.nfeSequence.findFirst.mockReset();
  // Restaura a implementação padrão — testes com contador em memória fazem
  // mockImplementation próprio e não podem vazar para os vizinhos.
  h.tx.$queryRawUnsafe.mockReset();
  h.tx.$queryRawUnsafe.mockImplementation(h.defaultImpl);
});

describe("NfeSequenceService — numeração por emitente (multi-CNPJ)", () => {
  it("REGRESSAO: sem opts, SQL legado sem NENHUMA menção a companyFiscalConfigId", async () => {
    h.selectResponses.push([{ id: "seq-1", proximoNumero: 7 }]);
    const svc = new NfeSequenceService();
    const numero = await svc.reservarProximoNumero("u1", "HOMOLOGACAO", 1);
    expect(numero).toBe(7);

    for (const call of h.queryCalls) {
      expect(call.sql).not.toContain("companyFiscalConfigId");
    }
    const select = h.queryCalls.find((c) => c.sql.includes("FOR UPDATE"))!;
    expect(select.params).toEqual(["u1", "HOMOLOGACAO", 1, "55"]);
    const update = h.queryCalls.find((c) => c.sql.trimStart().startsWith("UPDATE"))!;
    expect(update.params).toEqual([8, "seq-1"]);
  });

  it("com opts: SELECT filtra por emitente com ramo de adoção e ORDER BY que prefere a linha adotada", async () => {
    h.selectResponses.push([{ id: "seq-legada", proximoNumero: 42 }]);
    const svc = new NfeSequenceService();
    const numero = await svc.reservarProximoNumero(
      "u1",
      "PRODUCAO",
      1,
      "55",
      OPTS_DEFAULT,
    );
    expect(numero).toBe(42);

    const select = h.queryCalls.find((c) => c.sql.includes("FOR UPDATE"))!;
    expect(select.sql).toContain('"companyFiscalConfigId" = $5');
    expect(select.sql).toContain('"companyFiscalConfigId" IS NULL');
    expect(select.sql).toContain('ORDER BY ("companyFiscalConfigId" IS NULL) ASC');
    expect(select.params).toEqual([
      "u1",
      "PRODUCAO",
      1,
      "55",
      "cfg-A",
      true,
    ]);

    // Adoção idempotente: o UPDATE grava o configId na linha (legada ou não).
    const update = h.queryCalls.find((c) => c.sql.trimStart().startsWith("UPDATE"))!;
    expect(update.sql).toContain('"companyFiscalConfigId" = $2');
    expect(update.params).toEqual([43, "cfg-A", "seq-legada"]);
  });

  it("emitente NÃO-padrão nunca adota linha NULL (isDefaultConfig=false no filtro)", async () => {
    // SELECT vazio (não há contador do cfg-B) → INSERT cria contador PRÓPRIO.
    const svc = new NfeSequenceService();
    const numero = await svc.reservarProximoNumero(
      "u1",
      "PRODUCAO",
      1,
      "55",
      OPTS_SECUNDARIA,
    );
    expect(numero).toBe(1);

    const select = h.queryCalls.find((c) => c.sql.includes("FOR UPDATE"))!;
    // $6=false: o ramo "OR (companyFiscalConfigId IS NULL)" não casa nada.
    expect(select.params[5]).toBe(false);

    const insert = h.queryCalls.find((c) => c.sql.includes("INSERT"))!;
    expect(insert.sql).toContain('"companyFiscalConfigId"');
    expect(insert.sql).toContain("ON CONFLICT DO NOTHING");
    // RETURNING distingue "inserimos" (nº 1 é nosso, sem re-SELECT que
    // enxergaria a própria linha e devolveria 2) de "conflitou".
    expect(insert.sql).toContain('RETURNING "id"');
    expect(insert.params).toEqual(["u1", "PRODUCAO", 1, "55", "cfg-B"]);
    // Primeira emissão começa em 1 — sem pular o nº 1.
    const selects = h.queryCalls.filter((c) => c.sql.includes("FOR UPDATE"));
    expect(selects).toHaveLength(1);
  });

  it("conflito de INSERT sem linha adotável → LANÇA (nunca devolve número às cegas)", async () => {
    // SELECT vazio, INSERT conflita (RETURNING []), retry vazio: estado só
    // alcançável na janela pré-SQL-2 com config fora do padrão — falha alto.
    h.insertResponses.push([]);
    const svc = new NfeSequenceService();
    await expect(
      svc.reservarProximoNumero("u1", "PRODUCAO", 3, "55", OPTS_SECUNDARIA),
    ).rejects.toThrow(/reservar número/);
  });

  it("contadores INDEPENDENTES por emitente na MESMA serie/ambiente/modelo", async () => {
    // Contadores em memória por configId, honrando o filtro do SELECT novo.
    const counters: Record<string, number> = { "cfg-A": 10, "cfg-B": 3 };
    h.tx.$queryRawUnsafe.mockImplementation(
      async (sql: string, ...params: unknown[]) => {
        h.queryCalls.push({ sql, params });
        if (sql.trimStart().startsWith("SELECT")) {
          const cfg = params[4] as string;
          return [{ id: `seq-${cfg}`, proximoNumero: counters[cfg] }];
        }
        if (sql.includes("UPDATE")) {
          const cfg = params[1] as string;
          counters[cfg] = params[0] as number;
          return { count: 1 };
        }
        return [];
      },
    );

    const svc = new NfeSequenceService();
    const nA1 = await svc.reservarProximoNumero("u1", "PRODUCAO", 1, "55", {
      companyFiscalConfigId: "cfg-A",
      isDefaultConfig: true,
    });
    const nB1 = await svc.reservarProximoNumero("u1", "PRODUCAO", 1, "55", {
      companyFiscalConfigId: "cfg-B",
      isDefaultConfig: false,
    });
    const nA2 = await svc.reservarProximoNumero("u1", "PRODUCAO", 1, "55", {
      companyFiscalConfigId: "cfg-A",
      isDefaultConfig: true,
    });

    // Cada CNPJ conta sozinho — sem colisão nem interferência.
    expect(nA1).toBe(10);
    expect(nB1).toBe(3);
    expect(nA2).toBe(11);
  });

  it("retry pós-ON CONFLICT usa o SELECT NOVO e adota a linha existente (nunca duplica número)", async () => {
    // 1º SELECT: vazio (cfg-A ainda sem linha própria na visão do filtro).
    // INSERT: conflita com o unique ANTIGO por userId (janela de deploy) —
    // RETURNING vazio.
    // 2º SELECT (retry): acha a linha legada via ramo OR NULL → adota.
    h.selectResponses.push([]);
    h.selectResponses.push([{ id: "seq-legada", proximoNumero: 5 }]);
    h.insertResponses.push([]);

    const svc = new NfeSequenceService();
    const numero = await svc.reservarProximoNumero(
      "u1",
      "PRODUCAO",
      2,
      "55",
      OPTS_DEFAULT,
    );
    expect(numero).toBe(5);

    const selects = h.queryCalls.filter((c) => c.sql.includes("FOR UPDATE"));
    expect(selects).toHaveLength(2);
    for (const s of selects) {
      // Ambos os SELECTs (inclusive o retry) carregam o filtro por emitente.
      expect(s.sql).toContain('"companyFiscalConfigId" = $5');
      expect(s.params[4]).toBe("cfg-A");
    }
    const update = h.queryCalls.find((c) => c.sql.trimStart().startsWith("UPDATE"))!;
    expect(update.params).toEqual([6, "cfg-A", "seq-legada"]);
  });

  it("consultar/ajustar propagam o filtro por emitente quando opts presente", async () => {
    h.prisma.nfeSequence.findFirst.mockResolvedValue({ proximoNumero: 9 });
    const svc = new NfeSequenceService();
    const n = await svc.consultarProximoNumero(
      "u1",
      "PRODUCAO",
      1,
      "55",
      OPTS_DEFAULT,
    );
    expect(n).toBe(9);
    const where = h.prisma.nfeSequence.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { companyFiscalConfigId: "cfg-A" },
      { companyFiscalConfigId: null },
    ]);

    // Emitente não-padrão: SEM o ramo de adoção (não enxerga linha legada).
    h.prisma.nfeSequence.findFirst.mockClear();
    h.prisma.nfeSequence.findFirst.mockResolvedValue(null);
    await svc.consultarProximoNumero("u1", "PRODUCAO", 1, "55", OPTS_SECUNDARIA);
    const where2 = h.prisma.nfeSequence.findFirst.mock.calls[0][0].where;
    expect(where2.OR).toEqual([{ companyFiscalConfigId: "cfg-B" }]);
  });
});
