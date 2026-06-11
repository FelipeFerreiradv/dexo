import { describe, it, expect } from "vitest";
import {
  CFOP_CATALOG,
  CFOP_ENTRADA,
  CFOP_SAIDA,
  cfopDigits,
  cfopTipoFromOperacao,
  findCfop,
  getCfopsByTipo,
  type CfopEntry,
} from "../../app/fiscal/domain/cfop-catalog";
import {
  matchesTokens,
  tokenize,
} from "../../app/localizacoes/lib/search-utils";

// Reproduz a busca do combobox (CfopCombobox): tokens AND, accent/caixa-insensível.
function search(query: string, list: readonly CfopEntry[]): CfopEntry[] {
  const tokens = tokenize(query);
  return list.filter((c) =>
    matchesTokens(tokens, { code: c.codigo, description: c.descricao }),
  );
}

describe("cfop-catalog — integridade dos dados", () => {
  it("tem um conjunto substancial de CFOPs", () => {
    expect(CFOP_CATALOG.length).toBeGreaterThan(400);
  });

  it("todo código tem exatamente 4 dígitos numéricos", () => {
    for (const c of CFOP_CATALOG) {
      expect(c.codigo).toMatch(/^\d{4}$/);
    }
  });

  it("o tipo bate com o primeiro dígito (1/2/3 entrada, 5/6/7 saída)", () => {
    for (const c of CFOP_CATALOG) {
      const first = c.codigo[0];
      if (first === "1" || first === "2" || first === "3") {
        expect(c.tipo).toBe("ENTRADA");
      } else if (first === "5" || first === "6" || first === "7") {
        expect(c.tipo).toBe("SAIDA");
      } else {
        throw new Error(`CFOP com primeiro dígito inesperado: ${c.codigo}`);
      }
    }
  });

  it("não há códigos duplicados", () => {
    const codes = CFOP_CATALOG.map((c) => c.codigo);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("toda descrição é não-vazia", () => {
    for (const c of CFOP_CATALOG) {
      expect(c.descricao.trim().length).toBeGreaterThan(0);
    }
  });

  it("inclui CFOPs comuns de comércio/autopeças", () => {
    for (const code of ["5102", "5101", "1102", "2102", "6102", "5405"]) {
      expect(findCfop(code), `esperava encontrar ${code}`).toBeDefined();
    }
  });

  it("ENTRADA + SAIDA particionam o catálogo sem sobreposição", () => {
    expect(CFOP_ENTRADA.length + CFOP_SAIDA.length).toBe(CFOP_CATALOG.length);
    expect(CFOP_ENTRADA.every((c) => c.tipo === "ENTRADA")).toBe(true);
    expect(CFOP_SAIDA.every((c) => c.tipo === "SAIDA")).toBe(true);
  });
});

describe("cfop-catalog — helpers", () => {
  it("findCfop tolera ponto e espaços", () => {
    expect(findCfop("5.102")?.codigo).toBe("5102");
    expect(findCfop(" 5102 ")?.codigo).toBe("5102");
    expect(findCfop("5102")?.descricao).toContain("Venda de mercadoria");
  });

  it("findCfop retorna undefined para código inexistente ou vazio", () => {
    expect(findCfop("9999")).toBeUndefined();
    expect(findCfop("")).toBeUndefined();
    expect(findCfop(null)).toBeUndefined();
  });

  it("cfopDigits extrai apenas dígitos", () => {
    expect(cfopDigits("5.102")).toBe("5102");
    expect(cfopDigits("abc")).toBe("");
    expect(cfopDigits(undefined)).toBe("");
  });

  it("getCfopsByTipo filtra por tipo", () => {
    expect(getCfopsByTipo("ENTRADA").every((c) => c.codigo[0] <= "3")).toBe(
      true,
    );
    expect(getCfopsByTipo("SAIDA").every((c) => c.codigo[0] >= "5")).toBe(true);
  });

  it("cfopTipoFromOperacao mapeia o tipoOperacao da nota (default SAIDA)", () => {
    expect(cfopTipoFromOperacao("ENTRADA")).toBe("ENTRADA");
    expect(cfopTipoFromOperacao("SAIDA")).toBe("SAIDA");
    expect(cfopTipoFromOperacao(undefined)).toBe("SAIDA");
    expect(cfopTipoFromOperacao("qualquer")).toBe("SAIDA");
  });
});

describe("cfop-catalog — busca (mesma lógica do combobox)", () => {
  it("encontra por código exato", () => {
    const hits = search("5102", CFOP_SAIDA);
    expect(hits.some((c) => c.codigo === "5102")).toBe(true);
  });

  it("encontra por texto, ignorando acento e caixa", () => {
    const hits = search("COMERCIALIZACAO", CFOP_ENTRADA);
    expect(hits.some((c) => c.codigo === "1102")).toBe(true);
  });

  it("aplica AND entre tokens", () => {
    // "venda produção" casa 5101 (Venda de produção do estabelecimento) e não 5102.
    const hits = search("venda producao", CFOP_SAIDA);
    expect(hits.some((c) => c.codigo === "5101")).toBe(true);
    expect(hits.some((c) => c.codigo === "5102")).toBe(false);
  });

  it("query vazia devolve a lista inteira do tipo", () => {
    expect(search("", CFOP_SAIDA).length).toBe(CFOP_SAIDA.length);
  });
});
