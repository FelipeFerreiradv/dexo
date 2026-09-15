import { describe, it, expect } from "vitest";
import { buildPeriodoWhere } from "../../app/repositories/nfe.repository";

/**
 * O filtro de período das notas emitidas.
 *
 * Contexto: a tela exibia `dataEmissao` e filtrava por `createdAt`, e os
 * seletores de mês/ano não alimentavam a listagem — trocar o mês não mudava
 * nada. Estes testes fixam as três propriedades que não podem regredir:
 * o campo de referência, o fallback de nota sem `dataEmissao`, e as bordas
 * em horário de Brasília (as mesmas do relatório mensal).
 */
describe("buildPeriodoWhere", () => {
  it("usa dataEmissao como campo de referência, nao createdAt", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    expect(w.OR[0]).toHaveProperty("dataEmissao");
    // createdAt só aparece no ramo de fallback, nunca como filtro principal.
    expect(JSON.stringify(w.OR[0])).not.toContain("createdAt");
  });

  it("nota com dataEmissao nula cai em createdAt em vez de sumir", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    const fallback = w.OR[1];
    expect(fallback.AND[0]).toEqual({ dataEmissao: null });
    expect(fallback.AND[1]).toHaveProperty("createdAt");
  });

  it("abre a janela em 00:00 de Brasilia (03:00Z) do primeiro dia", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    expect(w.OR[0].dataEmissao.gte.toISOString()).toBe(
      "2026-08-01T03:00:00.000Z",
    );
  });

  it("fecha a janela em 00:00 de Brasilia do dia seguinte ao ultimo, exclusivo", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    // 31/08 23:59:59 de Brasilia ainda entra; 01/09 00:00 nao.
    expect(w.OR[0].dataEmissao.lt.toISOString()).toBe(
      "2026-09-01T03:00:00.000Z",
    );
  });

  it("uma nota emitida 23:30 do ultimo dia (02:30Z do dia seguinte) entra no mes", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    const nota = new Date("2026-09-01T02:30:00.000Z"); // 31/08 23:30 em Brasilia
    expect(nota >= w.OR[0].dataEmissao.gte).toBe(true);
    expect(nota < w.OR[0].dataEmissao.lt).toBe(true);
  });

  it("uma nota emitida 00:30 do primeiro dia do mes seguinte fica de fora", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    const nota = new Date("2026-09-01T03:30:00.000Z"); // 01/09 00:30 em Brasilia
    expect(nota < w.OR[0].dataEmissao.lt).toBe(false);
  });

  it("aceita so a data inicial", () => {
    const w = buildPeriodoWhere("2026-08-01", undefined);
    expect(w.OR[0].dataEmissao.gte).toBeInstanceOf(Date);
    expect(w.OR[0].dataEmissao.lt).toBeUndefined();
  });

  it("aceita so a data final", () => {
    const w = buildPeriodoWhere(undefined, "2026-08-31");
    expect(w.OR[0].dataEmissao.gte).toBeUndefined();
    expect(w.OR[0].dataEmissao.lt).toBeInstanceOf(Date);
  });

  it("a janela de agosto cobre exatamente 31 dias", () => {
    const w = buildPeriodoWhere("2026-08-01", "2026-08-31");
    const dias =
      (w.OR[0].dataEmissao.lt.getTime() - w.OR[0].dataEmissao.gte.getTime()) /
      86_400_000;
    expect(dias).toBe(31);
  });

  it("fevereiro bissexto de 2028 cobre 29 dias", () => {
    const w = buildPeriodoWhere("2028-02-01", "2028-02-29");
    const dias =
      (w.OR[0].dataEmissao.lt.getTime() - w.OR[0].dataEmissao.gte.getTime()) /
      86_400_000;
    expect(dias).toBe(29);
  });
});
