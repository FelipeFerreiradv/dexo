import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseNfeXml } from "../../../app/fiscal/sefaz/nfe-xml-parser.service";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";

// GOLDEN F0 — deep snapshot de parseNfeXml em 1549bc4 (o plano manda estendê-lo
// só de forma aditiva: a devolução lê `det@nItem` e o `imposto` bruto daqui).
// Fixtures = as MESMAS de tests/fiscal/sefaz/nfe-xml-parser.spec.ts (amostra
// nfeProc copiada verbatim para __fixtures__/nfe-proc-sample.xml, e as mesmas
// derivações) e de tests/fiscal/danfe-from-xml.spec.ts (round-trip builder →
// wrapInProc → parser, com dhEmi/cNF fixos).

const AMOSTRA = readFileSync(join(__dirname, "__fixtures__", "nfe-proc-sample.xml"), "utf-8");
const FIXED = new Date("2026-05-14T15:00:00-03:00");
const builder = new NfeXmlBuilderSefazService();

/** Mesmo embrulho de danfe-from-xml.spec.ts. */
function wrapInProc(nfeXml: string, chave: string): string {
  const nfeStripped = nfeXml.replace(/^<\?xml[^?]*\?>\s*/, "");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    nfeStripped,
    '<protNFe versao="4.00">',
    "<infProt>",
    "<tpAmb>2</tpAmb>",
    "<verAplic>SVRS202604</verAplic>",
    `<chNFe>${chave}</chNFe>`,
    "<dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>",
    "<nProt>135260000000777</nProt>",
    "<digVal>YWJjZGU=</digVal>",
    "<cStat>100</cStat>",
    "<xMotivo>Autorizado o uso da NF-e</xMotivo>",
    "</infProt>",
    "</protNFe>",
    "</nfeProc>",
  ].join("");
}

function roundTrip(
  draftOver: Parameters<typeof makeDraft>[0],
  numero: number,
  config = makeConfig(),
  cNF = "87654321",
): string {
  const built = builder.build({ draft: makeDraft(draftOver), config, numero, dhEmi: FIXED, cNF });
  return wrapInProc(built.xml, built.chaveAcesso);
}

const ITENS_EXTRAS = `</det>
      <det nItem="2">
        <prod>
          <cProd>PROD-002</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>SEGUNDO PRODUTO</xProd>
          <NCM>11111111</NCM>
          <CFOP>5102</CFOP>
          <uCom>KG</uCom>
          <qCom>2.0000</qCom>
          <vUnCom>50.0000</vUnCom>
          <vProd>100.00</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>KG</uTrib>
          <qTrib>2.0000</qTrib>
          <vUnTrib>50.0000</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>
      <det nItem="3">
        <prod>
          <cProd>PROD-003</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>TERCEIRO PRODUTO</xProd>
          <NCM>22222222</NCM>
          <CFOP>5102</CFOP>
          <uCom>UN</uCom>
          <qCom>5.0000</qCom>
          <vUnCom>20.0000</vUnCom>
          <vProd>100.00</vProd>
          <cEANTrib>SEM GTIN</cEANTrib>
          <uTrib>UN</uTrib>
          <qTrib>5.0000</qTrib>
          <vUnTrib>20.0000</vUnTrib>
          <indTot>1</indTot>
        </prod>
        <imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto>
      </det>`;

const TRIBUTOS_LP = {
  bcIcms: 100,
  valorIcms: 18,
  aliquotaIcms: 18,
  bcIpi: 0,
  valorIpi: 0,
  aliquotaIpi: 0,
  bcPis: 100,
  valorPis: 1.65,
  aliquotaPis: 1.65,
  bcCofins: 100,
  valorCofins: 7.6,
  aliquotaCofins: 7.6,
  valorTotalTributos: 26.25,
};

const CASOS: Array<{ nome: string; xml: () => string; frete?: boolean }> = [
  { nome: "proc-amostra", xml: () => AMOSTRA },
  {
    nome: "nfe-sem-proc",
    xml: () =>
      AMOSTRA.replace(/<nfeProc[^>]*>/, "")
        .replace(/<protNFe[\s\S]*<\/protNFe>/, "")
        .replace(/<\/nfeProc>/, ""),
  },
  { nome: "proc-tres-itens", xml: () => AMOSTRA.replace("</det>", ITENS_EXTRAS) },
  {
    nome: "builder-dois-itens",
    xml: () =>
      roundTrip({ itens: [makeItem(), makeItem({ codigo: "PROD-002", descricao: "OUTRO ITEM" })] }, 7),
  },
  {
    nome: "builder-pf-producao",
    xml: () =>
      roundTrip(
        {
          ambiente: "PRODUCAO",
          destinatarioJson: {
            tipoPessoa: "PF",
            cpfCnpj: "12345678901",
            nome: "JOAO PF",
            inscricaoEstadual: null,
            email: null,
            telefone: null,
            cep: "01000000",
            logradouro: "R",
            numero: "1",
            complemento: null,
            bairro: "B",
            municipio: "SP",
            codMunicipio: "3550308",
            uf: "SP",
            codPais: "1058",
            pais: "BRASIL",
          },
        },
        1,
      ),
  },
  {
    nome: "builder-lucro-presumido",
    xml: () =>
      roundTrip(
        { itens: [makeItem({ cstIcms: "00", tributosJson: TRIBUTOS_LP })] },
        1,
        makeConfig({ regimeTributario: "LUCRO_PRESUMIDO" }),
      ),
  },
  {
    nome: "builder-infcpl",
    xml: () => roundTrip({ informacoesComplementares: "Garantia de 90 dias", numeroPedido: "PED-7" }, 5),
  },
  {
    nome: "builder-frete-volumes",
    frete: true,
    xml: () =>
      roundTrip(
        {
          valorFrete: 25,
          modalidadeFrete: "CIF",
          volumesJson: [
            { quantidade: 2, especie: "CAIXA", marca: "DEXO", numeracao: "001", pesoLiquido: 9.5, pesoBruto: 10.25 },
          ],
        } as never,
        77,
      ),
  },
  {
    nome: "builder-nfce-sem-dest",
    xml: () =>
      roundTrip(
        {
          modelo: "65",
          indPresenca: "PRESENCIAL",
          destinatarioJson: null,
          pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
        },
        123,
        makeConfig(),
        "10000007",
      ),
  },
];

/** Datas (se um dia aparecerem) viram ISO; o resto sai como o parser devolveu. */
function serializar(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, valor) => (valor instanceof Date ? valor.toISOString() : valor),
    2,
  );
}

describe("golden F0 — parseNfeXml (deep)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const caso of CASOS) {
    it(caso.nome, async () => {
      vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", caso.frete ? "true" : "false");
      const parsed = parseNfeXml(caso.xml());
      await expect(serializar(parsed)).toMatchFileSnapshot(`./__snapshots__/xml-parser-${caso.nome}.json`);
    });
  }

  it("erros: mensagens travadas", async () => {
    const erros: Record<string, string> = {};
    const tentativas: Record<string, string> = {
      vazio: "",
      semNFe: "<outroRoot><x/></outroRoot>",
      semInfNFe: '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><x/></NFe>',
      semDest55: AMOSTRA.replace(/<dest>[\s\S]*<\/dest>/, ""),
      xxe: `<?xml version="1.0"?>
<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe35260511222333000181550010000000011120100012" versao="4.00">
    <ide><cUF>35</cUF><natOp>&xxe;</natOp><mod>55</mod></ide>
  </infNFe>
</NFe>`,
    };
    for (const [nome, xml] of Object.entries(tentativas)) {
      try {
        parseNfeXml(xml);
        erros[nome] = "(não lançou)";
      } catch (e) {
        erros[nome] = (e as Error).message;
      }
    }
    await expect(serializar(erros)).toMatchFileSnapshot("./__snapshots__/xml-parser-erros.json");
  });
});
