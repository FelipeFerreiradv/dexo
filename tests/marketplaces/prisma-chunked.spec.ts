import { describe, it, expect, vi } from "vitest";

import { findManyInChunks } from "../../app/lib/prisma-chunked";

// ──────────────────────────────────────────────────────────────────────────
// INCIDENTE PROD: "Importar anúncios" numa conta com >32.767 anúncios ativos
// quebrava com `too many bind variables in prepared statement, expected
// maximum of 32767, received 32768` — o Prisma monta um bind por elemento do
// `in:`. Este helper fatia a lista; os testes travam o contrato.
// ──────────────────────────────────────────────────────────────────────────

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("findManyInChunks", () => {
  it("lista vazia NÃO toca o banco (preserva os guards `length > 0`)", async () => {
    const query = vi.fn();
    expect(await findManyInChunks([], query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("cabe em um lote → uma única query, sem overhead", async () => {
    const query = vi.fn().mockResolvedValue([{ ok: 1 }]);
    const out = await findManyInChunks(ids(500), query);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toHaveLength(500);
    expect(out).toEqual([{ ok: 1 }]);
  });

  it("exatamente no limite do lote → ainda uma query", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await findManyInChunks(ids(10_000), query);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("32.768 ids (o caso do erro) → fatiado, nenhum lote acima do teto", async () => {
    const query = vi.fn().mockImplementation(async (c: string[]) => c);
    const out = await findManyInChunks(ids(32_768), query);

    expect(query).toHaveBeenCalledTimes(4);
    for (const [c] of query.mock.calls) {
      expect(c.length).toBeLessThanOrEqual(10_000);
      expect(c.length).toBeLessThan(32_767);
    }
    // Resultado idêntico ao de uma query única: nada se perde na concatenação.
    expect(out).toHaveLength(32_768);
    expect(out[0]).toBe("id-0");
    expect(out[32_767]).toBe("id-32767");
  });

  it("escala: 250.000 ids seguem o mesmo caminho", async () => {
    const query = vi.fn().mockImplementation(async (c: string[]) => c);
    const out = await findManyInChunks(ids(250_000), query);
    expect(query).toHaveBeenCalledTimes(25);
    expect(out).toHaveLength(250_000);
  });

  it("deduplica ids repetidos (menos binds, sem linha repetida)", async () => {
    const query = vi.fn().mockImplementation(async (c: string[]) => c);
    const out = await findManyInChunks(["a", "b", "a", "b", "c"], query);
    expect(query.mock.calls[0][0]).toEqual(["a", "b", "c"]);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("lotes são SEQUENCIAIS (não estoura o pool numa conta gigante)", async () => {
    let emVoo = 0;
    let maxEmVoo = 0;
    const query = vi.fn().mockImplementation(async (c: string[]) => {
      emVoo++;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      emVoo--;
      return c;
    });
    await findManyInChunks(ids(30_000), query);
    expect(maxEmVoo).toBe(1);
  });

  it("respeita `size` customizado", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await findManyInChunks(ids(10), query, 3);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
