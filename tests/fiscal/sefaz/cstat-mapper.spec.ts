import { describe, it, expect } from "vitest";
import {
  lookupCStat,
  isServicoOperacional,
} from "../../../app/fiscal/sefaz/cstat-mapper";

describe("cstat-mapper — codigos mapeados", () => {
  const goldens: Array<{
    cStat: number;
    categoria: string;
    label: string;
  }> = [
    { cStat: 107, categoria: "servico_operacional", label: "servico em operacao" },
    { cStat: 108, categoria: "servico_indisponivel", label: "paralisado curto" },
    { cStat: 109, categoria: "servico_indisponivel", label: "paralisado sem previsao" },
    { cStat: 100, categoria: "autorizada", label: "autorizada" },
    { cStat: 101, categoria: "cancelada", label: "cancelada" },
    { cStat: 102, categoria: "inutilizada", label: "inutilizada" },
    { cStat: 103, categoria: "lote_recebido", label: "lote recebido" },
    { cStat: 105, categoria: "lote_em_processamento", label: "em processamento" },
    { cStat: 150, categoria: "autorizada", label: "autorizada fora prazo" },
    { cStat: 110, categoria: "denegada", label: "denegada" },
    { cStat: 218, categoria: "duplicidade", label: "ja existe" },
    { cStat: 539, categoria: "duplicidade", label: "duplicidade chave" },
    { cStat: 217, categoria: "nao_consta", label: "nao consta" },
  ];

  for (const g of goldens) {
    it(`mapeia ${g.cStat} (${g.label}) como ${g.categoria}`, () => {
      const result = lookupCStat(g.cStat);
      expect(result.categoria).toBe(g.categoria);
      expect(result.descricao.length).toBeGreaterThan(0);
    });
  }
});

describe("cstat-mapper — fallbacks", () => {
  it("familia 200-599 cai em 'rejeitada' quando nao explicitamente mapeado", () => {
    // Usamos codigos NAO listados na tabela explicita.
    expect(lookupCStat(205).categoria).toBe("rejeitada");
    expect(lookupCStat(280).categoria).toBe("rejeitada");
    expect(lookupCStat(599).categoria).toBe("rejeitada");
  });

  it("cStat null/undefined/NaN cai em 'desconhecido'", () => {
    expect(lookupCStat(null).categoria).toBe("desconhecido");
    expect(lookupCStat(undefined).categoria).toBe("desconhecido");
    expect(lookupCStat(NaN).categoria).toBe("desconhecido");
  });

  it("cStat fora de qualquer faixa conhecida cai em 'desconhecido'", () => {
    expect(lookupCStat(99999).categoria).toBe("desconhecido");
    expect(lookupCStat(-1).categoria).toBe("desconhecido");
  });
});

describe("cstat-mapper — isServicoOperacional", () => {
  it("retorna true APENAS para 107", () => {
    expect(isServicoOperacional(107)).toBe(true);
    expect(isServicoOperacional(108)).toBe(false);
    expect(isServicoOperacional(109)).toBe(false);
    expect(isServicoOperacional(100)).toBe(false);
    expect(isServicoOperacional(null)).toBe(false);
  });
});
