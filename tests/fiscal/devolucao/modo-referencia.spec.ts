import { describe, expect, it } from "vitest";

import {
  DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO,
  dataBrasilISO,
  modoReferenciaDevolucao,
  normalizarDesdeISO,
} from "../../../app/fiscal/devolucao/modo-referencia";

describe("modoReferenciaDevolucao", () => {
  it("HOMOLOGACAO → ITEM sempre", () => {
    expect(modoReferenciaDevolucao("HOMOLOGACAO", new Date("2026-01-01T12:00:00Z"), "2026-10-05")).toBe("ITEM");
    expect(modoReferenciaDevolucao("HOMOLOGACAO", new Date("2030-01-01T12:00:00Z"), "2031-01-01")).toBe("ITEM");
  });

  it("PRODUCAO antes da data → NOTA; na data e depois → ITEM", () => {
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("2026-10-04T15:00:00Z"), "2026-10-05")).toBe("NOTA");
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("2026-10-05T03:00:00Z"), "2026-10-05")).toBe("ITEM");
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("2027-02-01T00:00:00Z"), "2026-10-05")).toBe("ITEM");
  });

  it("usa a data do Brasil (UTC-3), não a do servidor", () => {
    // 05/10 02:59 UTC = 04/10 23:59 em Brasília → ainda NOTA
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("2026-10-05T02:59:59Z"), "2026-10-05")).toBe("NOTA");
    expect(dataBrasilISO(new Date("2026-10-05T02:59:59Z"))).toBe("2026-10-04");
    expect(dataBrasilISO(new Date("2026-10-05T03:00:00Z"))).toBe("2026-10-05");
  });

  it("data de corte ausente ou inválida cai no padrão 2026-10-05", () => {
    expect(DEVOLUCAO_REF_ITEM_PROD_DESDE_PADRAO).toBe("2026-10-05");
    expect(normalizarDesdeISO(undefined)).toBe("2026-10-05");
    expect(normalizarDesdeISO("05/10/2026")).toBe("2026-10-05");
    expect(normalizarDesdeISO("2026-02-30")).toBe("2026-10-05");
    expect(normalizarDesdeISO(" 2026-11-01 ")).toBe("2026-11-01");
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("2026-10-06T12:00:00Z"), "lixo")).toBe("ITEM");
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("2026-10-01T12:00:00Z"), null)).toBe("NOTA");
  });

  it("data inválida em produção → NOTA; ambiente desconhecido segue a regra de produção", () => {
    expect(modoReferenciaDevolucao("PRODUCAO", new Date("x"), "2026-10-05")).toBe("NOTA");
    expect(modoReferenciaDevolucao("?", new Date("2026-10-01T12:00:00Z"), "2026-10-05")).toBe("NOTA");
  });
});
