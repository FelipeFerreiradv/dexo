import { describe, it, expect } from "vitest";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { parseChave } from "../../../app/fiscal/sefaz/chave-acesso";
import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";

describe("NfeXmlBuilderSefazService — estrutura", () => {
  const builder = new NfeXmlBuilderSefazService();
  const FIXED_DH = new Date("2026-05-14T15:00:00-03:00");

  it("monta envelope <NFe><infNFe Id='NFe<chave>' versao='4.00'>", () => {
    const { xml, chaveAcesso, infNFeId } = builder.build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });

    expect(xml).toContain('<NFe xmlns="http://www.portalfiscal.inf.br/nfe">');
    expect(xml).toContain(`<infNFe Id="${infNFeId}" versao="4.00">`);
    expect(xml).toContain("</infNFe>");
    expect(xml).toContain("</NFe>");

    expect(chaveAcesso).toMatch(/^\d{44}$/);
    expect(infNFeId).toBe(`NFe${chaveAcesso}`);

    // Round-trip da chave
    expect(() => parseChave(chaveAcesso)).not.toThrow();
  });

  it("inclui todos os campos obrigatorios do <ide>", () => {
    const { xml } = builder.build({
      draft: makeDraft({ serie: 1, naturezaOperacao: "VENDA DE PECA USADA" }),
      config: makeConfig(),
      numero: 42,
      dhEmi: FIXED_DH,
      cNF: "11111111",
    });

    expect(xml).toContain("<cUF>35</cUF>");
    expect(xml).toContain("<cNF>11111111</cNF>");
    expect(xml).toContain("<natOp>VENDA DE PECA USADA</natOp>");
    expect(xml).toContain("<mod>55</mod>");
    expect(xml).toContain("<serie>1</serie>");
    expect(xml).toContain("<nNF>42</nNF>");
    expect(xml).toContain("<dhEmi>");
    expect(xml).toContain("<tpNF>1</tpNF>"); // SAIDA
    expect(xml).toContain("<idDest>1</idDest>"); // INTERNA
    expect(xml).toContain("<cMunFG>3550308</cMunFG>");
    expect(xml).toContain("<tpImp>1</tpImp>");
    expect(xml).toContain("<tpEmis>1</tpEmis>");
    expect(xml).toContain("<cDV>");
    expect(xml).toContain("<tpAmb>2</tpAmb>"); // HOMOLOGACAO
    expect(xml).toContain("<finNFe>1</finNFe>"); // NORMAL
    expect(xml).toContain("<indPres>1</indPres>"); // PRESENCIAL
  });

  it("popula <emit> com CRT correto para regime tributario", () => {
    const xmlSimples = builder.build({
      draft: makeDraft(),
      config: makeConfig({ regimeTributario: "SIMPLES" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    }).xml;
    expect(xmlSimples).toContain("<CRT>1</CRT>");

    const xmlNormal = builder.build({
      draft: makeDraft(),
      config: makeConfig({ regimeTributario: "LUCRO_PRESUMIDO" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    }).xml;
    expect(xmlNormal).toContain("<CRT>3</CRT>");
  });

  it("usa ICMSSN102 para Simples Nacional default", () => {
    const { xml } = builder.build({
      draft: makeDraft(),
      config: makeConfig({ regimeTributario: "SIMPLES" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("<ICMSSN102>");
    expect(xml).toContain("<CSOSN>102</CSOSN>");
    expect(xml).not.toContain("<ICMS00>");
  });

  it("usa ICMS00 para regime normal com CST=00", () => {
    const item = makeItem({
      cstIcms: "00",
      tributosJson: {
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
      },
    });
    const { xml } = builder.build({
      draft: makeDraft({ itens: [item] }),
      config: makeConfig({ regimeTributario: "LUCRO_PRESUMIDO" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("<ICMS00>");
    expect(xml).toContain("<CST>00</CST>");
    expect(xml).toContain("<vBC>100.00</vBC>");
    expect(xml).toContain("<pICMS>18.00</pICMS>");
    expect(xml).toContain("<vICMS>18.00</vICMS>");
  });

  it("monta <dest> com CPF para PF e CNPJ para PJ", () => {
    const xmlPF = builder.build({
      draft: makeDraft({
        destinatarioJson: {
          tipoPessoa: "PF",
          cpfCnpj: "12345678901",
          nome: "JOAO TESTE",
          inscricaoEstadual: null,
          email: null,
          telefone: null,
          cep: "04000000",
          logradouro: "RUA",
          numero: "1",
          complemento: null,
          bairro: "B",
          municipio: "SP",
          codMunicipio: "3550308",
          uf: "SP",
          codPais: "1058",
          pais: "BRASIL",
        },
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    }).xml;
    expect(xmlPF).toContain("<CPF>12345678901</CPF>");
    expect(xmlPF).toContain("<indIEDest>9</indIEDest>"); // PF não contribuinte

    const xmlPJ = builder.build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    }).xml;
    expect(xmlPJ).toContain("<CNPJ>00000000000100</CNPJ>");
    expect(xmlPJ).toContain("<indIEDest>2</indIEDest>"); // PJ isento
  });

  it("inclui <IE> apenas quando IE valida (nao isento)", () => {
    const xmlComIE = builder.build({
      draft: makeDraft({
        destinatarioJson: {
          tipoPessoa: "PJ",
          cpfCnpj: "00000000000100",
          nome: "CLIENTE",
          inscricaoEstadual: "999888777",
          email: null,
          telefone: null,
          cep: "04000000",
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
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    }).xml;
    expect(xmlComIE).toContain("<indIEDest>1</indIEDest>");
    expect(xmlComIE).toContain("<IE>999888777</IE>");
  });

  it("multiplos itens recebem nItem sequencial", () => {
    const { xml } = builder.build({
      draft: makeDraft({
        itens: [
          makeItem({ codigo: "P1", descricao: "PROD A" }),
          makeItem({ codigo: "P2", descricao: "PROD B" }),
          makeItem({ codigo: "P3", descricao: "PROD C" }),
        ],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain('<det nItem="1">');
    expect(xml).toContain('<det nItem="2">');
    expect(xml).toContain('<det nItem="3">');
    expect(xml).toContain("<cProd>P1</cProd>");
    expect(xml).toContain("<cProd>P2</cProd>");
    expect(xml).toContain("<cProd>P3</cProd>");
  });

  it("inclui observacao obrigatoria de homologacao em <infAdic>", () => {
    const { xml } = builder.build({
      draft: makeDraft({ ambiente: "HOMOLOGACAO" }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("<infAdic>");
    expect(xml).toContain("HOMOLOGACAO - SEM VALOR FISCAL");
  });

  it("nao inclui aviso de homologacao em PRODUCAO", () => {
    const { xml } = builder.build({
      draft: makeDraft({
        ambiente: "PRODUCAO",
        numeroPedido: "PED-001",
      }),
      config: makeConfig({ ambiente: "PRODUCAO" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).not.toContain("HOMOLOGACAO");
    expect(xml).toContain("Pedido: PED-001");
    expect(xml).toContain("<tpAmb>1</tpAmb>");
  });

  it("preenche <total>/<ICMSTot> com todos os campos obrigatorios", () => {
    const { xml } = builder.build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    const required = [
      "vBC", "vICMS", "vICMSDeson", "vFCP", "vBCST", "vST", "vFCPST",
      "vFCPSTRet", "vProd", "vFrete", "vSeg", "vDesc", "vII", "vIPI",
      "vIPIDevol", "vPIS", "vCOFINS", "vOutro", "vNF",
    ];
    for (const tag of required) {
      expect(xml, `total/${tag}`).toMatch(new RegExp(`<${tag}>[^<]+</${tag}>`));
    }
    expect(xml).toContain("<vProd>100.00</vProd>");
    expect(xml).toContain("<vNF>100.00</vNF>");
  });

  it("inclui <transp><modFrete>9</modFrete> quando SEM_FRETE", () => {
    const { xml } = builder.build({
      draft: makeDraft({ modalidadeFrete: "SEM_FRETE" }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("<modFrete>9</modFrete>");
  });

  it("inclui <pag><detPag><tPag>90 quando sem pagamento", () => {
    const { xml } = builder.build({
      draft: makeDraft({ pagamentosJson: null }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("<pag>");
    expect(xml).toContain("<tPag>90</tPag>");
    expect(xml).toContain("<vPag>0.00</vPag>");
  });

  it("monta <pag> com multiplos pagamentos", () => {
    const { xml } = builder.build({
      draft: makeDraft({
        pagamentosJson: [
          { meio: "PIX", valor: 50 },
          { meio: "DINHEIRO", valor: 50 },
        ],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toMatch(/<tPag>17<\/tPag>[\s\S]*<vPag>50\.00<\/vPag>/);
    expect(xml).toMatch(/<tPag>01<\/tPag>[\s\S]*<vPag>50\.00<\/vPag>/);
  });

  it("monta <cobr><dup> quando ha duplicatas", () => {
    const { xml } = builder.build({
      draft: makeDraft({
        duplicatasJson: [
          // Usa data TZ-aware no horário comercial brasileiro (-03:00). Datas
          // "YYYY-MM-DD" são interpretadas como UTC midnight pelo construtor
          // Date, o que pode pular um dia em America/Sao_Paulo.
          { numero: "001", dataVencimento: "2026-06-14T12:00:00-03:00", valor: 100 },
        ],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("<cobr>");
    expect(xml).toContain("<nDup>001</nDup>");
    expect(xml).toContain("<dVenc>2026-06-14</dVenc>");
    expect(xml).toContain("<vDup>100.00</vDup>");
  });

  it("escapa caracteres especiais em descricao do produto", () => {
    const { xml } = builder.build({
      draft: makeDraft({
        itens: [makeItem({ descricao: 'P&D "TESTE" <ESPECIAL>' })],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    expect(xml).toContain("P&amp;D");
    expect(xml).not.toContain("<ESPECIAL>");
    expect(xml).toMatch(/&lt;ESPECIAL&gt;/);
  });

  it("trunca descricao do produto a 120 chars (limite SEFAZ xProd)", () => {
    const longText = "A".repeat(200);
    const { xml } = builder.build({
      draft: makeDraft({
        itens: [makeItem({ descricao: longText })],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "12345678",
    });
    const match = xml.match(/<xProd>([^<]+)<\/xProd>/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(120);
  });

  it("rejeita quando config.uf ausente", () => {
    expect(() =>
      new NfeXmlBuilderSefazService().build({
        draft: makeDraft(),
        config: makeConfig({ uf: null }),
        numero: 1,
        dhEmi: FIXED_DH,
        cNF: "12345678",
      }),
    ).toThrow(/uf/);
  });

  it("rejeita quando destinatarioJson ausente", () => {
    expect(() =>
      new NfeXmlBuilderSefazService().build({
        draft: makeDraft({ destinatarioJson: null }),
        config: makeConfig(),
        numero: 1,
        dhEmi: FIXED_DH,
        cNF: "12345678",
      }),
    ).toThrow(/destinatario/);
  });

  it("rejeita quando itens vazios", () => {
    expect(() =>
      new NfeXmlBuilderSefazService().build({
        draft: makeDraft({ itens: [] }),
        config: makeConfig(),
        numero: 1,
        dhEmi: FIXED_DH,
        cNF: "12345678",
      }),
    ).toThrow(/itens/);
  });
});
