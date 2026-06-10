import { describe, it, expect } from "vitest";
import {
  SEFAZ_ENDPOINTS,
  AN_ENDPOINTS,
  SVC_AN_ENDPOINTS,
  SVC_RS_ENDPOINTS,
  SVC_FALLBACK,
  COD_UF,
  getSefazEndpoint,
  getAnEndpoint,
  getSvcEndpoint,
} from "../../../app/fiscal/sefaz/endpoints";
import type { UF, SefazServico } from "../../../app/fiscal/sefaz/endpoints";

const TODAS_UFS: UF[] = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA",
  "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN",
  "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

const SERVICOS_OBRIGATORIOS: SefazServico[] = [
  "NFeAutorizacao4",
  "NFeRetAutorizacao4",
  "NfeConsultaProtocolo4",
  "NfeStatusServico4",
  "NfeInutilizacao4",
  "RecepcaoEvento4",
];

describe("SEFAZ endpoints — cobertura", () => {
  it("cobre todas as 27 UFs (26 + DF)", () => {
    expect(Object.keys(SEFAZ_ENDPOINTS)).toHaveLength(27);
    for (const uf of TODAS_UFS) {
      expect(SEFAZ_ENDPOINTS[uf], `UF ${uf}`).toBeDefined();
    }
  });

  it("cada UF tem ambos ambientes (homologacao + producao)", () => {
    for (const uf of TODAS_UFS) {
      expect(SEFAZ_ENDPOINTS[uf].homologacao).toBeDefined();
      expect(SEFAZ_ENDPOINTS[uf].producao).toBeDefined();
    }
  });

  it("cada combinacao UF+ambiente expoe todos os 6 servicos com URLs https", () => {
    for (const uf of TODAS_UFS) {
      for (const ambiente of ["homologacao", "producao"] as const) {
        for (const servico of SERVICOS_OBRIGATORIOS) {
          const url = SEFAZ_ENDPOINTS[uf][ambiente][servico];
          expect(
            url,
            `${uf}/${ambiente}/${servico}`,
          ).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("getSefazEndpoint retorna URL correta para UFs conhecidas", () => {
    const url = getSefazEndpoint("SP", "homologacao", "NFeAutorizacao4");
    expect(url).toMatch(/^https:\/\/.+sp\.gov\.br/);
    expect(url).toMatch(/nfeautorizacao4/i);
  });

  it("getSefazEndpoint distingue ambientes", () => {
    const hom = getSefazEndpoint("SP", "homologacao", "NfeStatusServico4");
    const prod = getSefazEndpoint("SP", "producao", "NfeStatusServico4");
    expect(hom).not.toBe(prod);
  });

  it("COD_UF tem codigo IBGE de 2 digitos para cada UF", () => {
    for (const uf of TODAS_UFS) {
      const codigo = COD_UF[uf];
      expect(codigo, `COD_UF[${uf}]`).toBeGreaterThanOrEqual(11);
      expect(codigo).toBeLessThanOrEqual(53);
    }
    // Conferencia de alguns codigos conhecidos
    expect(COD_UF.SP).toBe(35);
    expect(COD_UF.RJ).toBe(33);
    expect(COD_UF.MG).toBe(31);
    expect(COD_UF.RS).toBe(43);
  });
});

describe("Ambiente Nacional (AN)", () => {
  it("oferece inutilizacao + evento + distribuicao em ambos ambientes", () => {
    for (const ambiente of ["homologacao", "producao"] as const) {
      expect(AN_ENDPOINTS[ambiente].NfeInutilizacao4).toMatch(/^https:\/\//);
      expect(AN_ENDPOINTS[ambiente].RecepcaoEvento4).toMatch(/^https:\/\//);
      expect(AN_ENDPOINTS[ambiente].NFeDistribuicaoDFe).toMatch(/^https:\/\//);
    }
  });

  it("getAnEndpoint resolve corretamente", () => {
    expect(getAnEndpoint("producao", "NFeDistribuicaoDFe")).toContain(
      "www.nfe.fazenda.gov.br",
    );
  });
});

describe("Contingencia (SVC-AN / SVC-RS)", () => {
  it("SVC_FALLBACK mapeia todas as 27 UFs", () => {
    for (const uf of TODAS_UFS) {
      expect(SVC_FALLBACK[uf]).toMatch(/^SVC_(AN|RS)$/);
    }
  });

  it("getSvcEndpoint roteia UFs SVC_AN para a SVC_AN", () => {
    expect(SVC_FALLBACK.SP).toBe("SVC_AN");
    const url = getSvcEndpoint("SP", "homologacao", "NFeAutorizacao4");
    expect(url).toBe(SVC_AN_ENDPOINTS.homologacao.NFeAutorizacao4);
  });

  it("getSvcEndpoint roteia UFs SVC_RS para a SVC_RS", () => {
    expect(SVC_FALLBACK.MT).toBe("SVC_RS");
    const url = getSvcEndpoint("MT", "producao", "NfeStatusServico4");
    expect(url).toBe(SVC_RS_ENDPOINTS.producao.NfeStatusServico4);
  });
});
