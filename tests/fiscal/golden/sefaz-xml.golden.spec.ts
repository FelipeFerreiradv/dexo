import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NfeXmlBuilderSefazService,
  type NfeRespTec,
} from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";
import { CASOS_EMISSAO, CNF_FIXO, DH_EMI_FIXO } from "./__fixtures__/casos-emissao";

// GOLDEN F0 — XML SEFAZ direto (NfeXmlBuilderSefazService.build) em 1549bc4.
// Arquivo .xml = saída VERBATIM do builder (sem Signature, sem envelope):
// byte a byte. dhEmi e cNF fixos ⇒ chave determinística. A §6.5 do plano exige
// que, sem contexto de devolução, a saída continue idêntica a estes arquivos.
// Modelo 65: o builder não precisa de CSC/certificado (o QR entra no provider).

// Dados fictícios de RT (CNPJ de teste, não é o da Dexo nem da Focus).
const RESP_TEC: NfeRespTec = {
  cnpj: "11.222.333/0001-81",
  xContato: "Suporte Teste",
  email: "suporte@resptec.test",
  fone: "(11) 4000-0000",
};

interface CasoXml {
  nome: string;
  build: () => ReturnType<NfeXmlBuilderSefazService["build"]>;
  freteFlag: "true" | "false";
}

const builder = new NfeXmlBuilderSefazService();

const CASOS: CasoXml[] = [
  ...CASOS_EMISSAO.map((c) => ({
    nome: c.nome,
    freteFlag: c.freteFlag,
    build: () =>
      builder.build({
        draft: c.draft(),
        config: c.config(),
        numero: c.numero,
        dhEmi: DH_EMI_FIXO,
        cNF: CNF_FIXO,
      }),
  })),
  {
    nome: "resptec-sem-csrt",
    freteFlag: "false",
    build: () =>
      builder.build({
        draft: makeDraft({ ambiente: "PRODUCAO", numeroPedido: "PED-9" }),
        config: makeConfig({ ambiente: "PRODUCAO" }),
        numero: 101,
        dhEmi: DH_EMI_FIXO,
        cNF: CNF_FIXO,
        respTec: RESP_TEC,
      }),
  },
  {
    nome: "resptec-com-csrt",
    freteFlag: "false",
    build: () =>
      builder.build({
        draft: makeDraft({ ambiente: "PRODUCAO" }),
        config: makeConfig({ ambiente: "PRODUCAO", uf: "PR", codMunicipio: "4105805", municipio: "COLOMBO" }),
        numero: 101,
        dhEmi: DH_EMI_FIXO,
        cNF: CNF_FIXO,
        respTec: { ...RESP_TEC, idCSRT: "01", csrt: "CSRT-FICTICIO-HARNESS-0001" },
      }),
  },
  {
    nome: "tpemis-svc-an",
    freteFlag: "false",
    build: () =>
      builder.build({
        draft: makeDraft(),
        config: makeConfig(),
        numero: 101,
        dhEmi: DH_EMI_FIXO,
        cNF: CNF_FIXO,
        tpEmis: 6,
      }),
  },
];

describe("golden F0 — XML SEFAZ direto (NfeXmlBuilderSefazService.build)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const caso of CASOS) {
    it(caso.nome, async () => {
      vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", caso.freteFlag);
      const out = caso.build();
      expect(out.chaveAcesso).toMatch(/^\d{44}$/);
      expect(out.infNFeId).toBe(`NFe${out.chaveAcesso}`);
      expect(out.chaveParts.cNF).toBe(CNF_FIXO);
      await expect(out.xml).toMatchFileSnapshot(`./__snapshots__/sefaz-${caso.nome}.xml`);
    });
  }

  it("determinismo: dhEmi/cNF fixos ⇒ XML idêntico em builds repetidos", () => {
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "true");
    const [caso] = CASOS.filter((c) => c.nome === "frete-flag-ligada");
    expect(caso.build().xml).toBe(caso.build().xml);
  });
});
