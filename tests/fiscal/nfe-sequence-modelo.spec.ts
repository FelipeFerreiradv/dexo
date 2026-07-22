import { describe, it, expect, beforeEach, vi } from "vitest";

// NFC-e (Fase 2) — dimensão `modelo` na numeração. REGRESSÃO central: chamadas
// SEM modelo devem consultar/reservar com modelo='55' (default), mantendo a
// numeração da NF-e byte-idêntica; '65' usa contador próprio.

const h = vi.hoisted(() => {
  const queryCalls: Array<{ sql: string; params: unknown[] }> = [];
  // Multi-CNPJ: o @@unique composto por userId saiu do schema; consultar/
  // ajustar passaram de findUnique/upsert para findFirst + update/create.
  // Mesmas semânticas — o mock apenas acompanha a forma da chamada.
  const findFirst = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const tx = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      queryCalls.push({ sql, params });
      if (sql.trimStart().startsWith("SELECT")) {
        return [{ id: "seq-1", proximoNumero: 7 }];
      }
      return [];
    }),
  };
  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    nfeSequence: { findFirst, create, update },
  };
  return { prisma, queryCalls, findFirst, create, update };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));

import { NfeSequenceService } from "../../app/fiscal/sequence/nfe-sequence.service";

beforeEach(() => {
  h.queryCalls.length = 0;
  h.findFirst.mockReset();
  h.create.mockReset();
  h.update.mockReset();
});

describe("NfeSequenceService — dimensão modelo", () => {
  it("REGRESSAO: reservar SEM modelo usa '55' no WHERE (4o parametro)", async () => {
    const svc = new NfeSequenceService();
    const numero = await svc.reservarProximoNumero("u1", "HOMOLOGACAO", 1);
    expect(numero).toBe(7);
    const select = h.queryCalls.find((c) => c.sql.includes("FOR UPDATE"))!;
    expect(select.sql).toContain('"modelo" = $4');
    expect(select.params).toEqual(["u1", "HOMOLOGACAO", 1, "55"]);
  });

  it("reservar com '65' passa '65' — contador independente por modelo", async () => {
    const svc = new NfeSequenceService();
    await svc.reservarProximoNumero("u1", "HOMOLOGACAO", 1, "65");
    const select = h.queryCalls.find((c) => c.sql.includes("FOR UPDATE"))!;
    expect(select.params).toEqual(["u1", "HOMOLOGACAO", 1, "65"]);
  });

  it("INSERT de primeira emissao inclui modelo e usa ON CONFLICT sem alvo", async () => {
    const svc = new NfeSequenceService();
    // Força o caminho de INSERT: primeiro SELECT vazio.
    h.prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      const tx = {
        $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
          h.queryCalls.push({ sql, params });
          if (sql.trimStart().startsWith("SELECT")) return [];
          return [];
        }),
      };
      return fn(tx);
    });
    const numero = await svc.reservarProximoNumero("u1", "PRODUCAO", 2, "65");
    expect(numero).toBe(1);
    const insert = h.queryCalls.find((c) => c.sql.includes("INSERT"))!;
    expect(insert.sql).toContain('"modelo"');
    expect(insert.sql).toContain("ON CONFLICT DO NOTHING");
    expect(insert.sql).not.toContain('ON CONFLICT ("userId"');
    expect(insert.params).toEqual(["u1", "PRODUCAO", 2, "65"]);
  });

  it("consultar usa o seletor composto COM modelo (default '55')", async () => {
    h.findFirst.mockResolvedValue({ proximoNumero: 3 });
    const svc = new NfeSequenceService();
    const n = await svc.consultarProximoNumero("u1", "HOMOLOGACAO", 1);
    expect(n).toBe(3);
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          ambiente: "HOMOLOGACAO",
          serie: 1,
          modelo: "55",
        }),
        select: { proximoNumero: true },
      }),
    );
  });

  it("ajustar propaga modelo no create (primeira linha da combinação)", async () => {
    h.findFirst.mockResolvedValue(null);
    const svc = new NfeSequenceService();
    await svc.ajustarProximoNumero("u1", "HOMOLOGACAO", 1, 10, "65");
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u1",
          ambiente: "HOMOLOGACAO",
          serie: 1,
          modelo: "65",
          proximoNumero: 10,
        }),
      }),
    );
  });
});
