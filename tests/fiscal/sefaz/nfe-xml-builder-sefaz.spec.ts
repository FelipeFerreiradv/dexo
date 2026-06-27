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
      cNF: "87654321",
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
      cNF: "87654329",
    });

    expect(xml).toContain("<cUF>35</cUF>");
    expect(xml).toContain("<cNF>87654329</cNF>");
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
      cNF: "87654321",
    }).xml;
    expect(xmlSimples).toContain("<CRT>1</CRT>");

    const xmlNormal = builder.build({
      draft: makeDraft(),
      config: makeConfig({ regimeTributario: "LUCRO_PRESUMIDO" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    }).xml;
    expect(xmlNormal).toContain("<CRT>3</CRT>");
  });

  it("usa ICMSSN102 para Simples Nacional default", () => {
    const { xml } = builder.build({
      draft: makeDraft(),
      config: makeConfig({ regimeTributario: "SIMPLES" }),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
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
      cNF: "87654321",
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
      cNF: "87654321",
    }).xml;
    expect(xmlPF).toContain("<CPF>12345678901</CPF>");
    expect(xmlPF).toContain("<indIEDest>9</indIEDest>"); // PF não contribuinte

    const xmlPJ = builder.build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    }).xml;
    expect(xmlPJ).toContain("<CNPJ>00000000000100</CNPJ>");
    expect(xmlPJ).toContain("<indIEDest>2</indIEDest>"); // PJ isento
  });

  it("emite <enderDest> para destinatario nacional mesmo sem alguns campos", () => {
    // Rejeicao "NF-e sem a informacao de endereco do destinatario": enderDest
    // e obrigatorio para PF/PJ. Deve sair sempre (a completude e checada no
    // use case). Aqui garantimos que o bloco NAO e omitido.
    const { xml } = builder.build({
      draft: makeDraft({
        destinatarioJson: {
          tipoPessoa: "PJ",
          cpfCnpj: "00000000000100",
          nome: "CLIENTE",
          inscricaoEstadual: "ISENTO",
          email: null,
          telefone: null,
          cep: "30140071",
          logradouro: "AV AFONSO PENA",
          numero: "1000",
          complemento: null,
          bairro: "CENTRO",
          municipio: "BELO HORIZONTE",
          codMunicipio: "3106200",
          uf: "MG",
          codPais: "1058",
          pais: "BRASIL",
        },
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    });
    expect(xml).toContain("<enderDest>");
    expect(xml).toContain("<cMun>3106200</cMun>");
    expect(xml).toContain("<UF>MG</UF>");
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
      cNF: "87654321",
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
      cNF: "87654321",
    });
    expect(xml).toContain('<det nItem="1">');
    expect(xml).toContain('<det nItem="2">');
    expect(xml).toContain('<det nItem="3">');
    expect(xml).toContain("<cProd>P1</cProd>");
    expect(xml).toContain("<cProd>P2</cProd>");
    expect(xml).toContain("<cProd>P3</cProd>");
  });

  it("homologacao forca o literal no xNome do DESTINATARIO (Rejeicao 598), nao no infCpl", () => {
    const { xml } = builder.build({
      draft: makeDraft({ ambiente: "HOMOLOGACAO" }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    });
    // O literal DEVE estar no <dest><xNome>, dentro do bloco <dest>...</dest>
    const destBloco = xml.match(/<dest>[\s\S]*?<\/dest>/)?.[0] ?? "";
    expect(destBloco).toContain(
      "<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>",
    );
    // O nome real do destinatario NAO deve aparecer no XML de homologacao
    expect(xml).not.toContain("CLIENTE TESTE LTDA");
    // E o literal NAO deve estar no infCpl (lugar errado, nao exigido)
    expect(xml).not.toMatch(/<infCpl>[^<]*HOMOLOGACAO[^<]*<\/infCpl>/);
  });

  it("dhEmi e dVenc usam offset fixo -03:00 independente do TZ do servidor (XML-5)", () => {
    // Instante 18:00Z => 15:00 em Brasilia. Mesmo com server em qualquer TZ,
    // o builder converte para -03:00.
    const { xml } = builder.build({
      draft: makeDraft({
        duplicatasJson: [
          { numero: "001", dataVencimento: "2026-06-14T12:00:00-03:00", valor: 100 },
        ],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: new Date("2026-05-14T18:00:00Z"),
      cNF: "87654321",
    });
    expect(xml).toContain("<dhEmi>2026-05-14T15:00:00-03:00</dhEmi>");
    expect(xml).toContain("<dVenc>2026-06-14</dVenc>");
  });

  it("AAMM da chave bate com dhEmi mesmo na virada de mes em servidor UTC (XML-5)", () => {
    // 2026-07-01T01:30Z = 2026-06-30T22:30 em Brasilia. AAMM deve ser 2606, nao 2607.
    const { xml, chaveAcesso } = builder.build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: new Date("2026-07-01T01:30:00Z"),
      cNF: "87654321",
    });
    expect(xml).toContain("<dhEmi>2026-06-30T22:30:00-03:00</dhEmi>");
    // chave: cUF(2)=35 + AAMM(4) ... → posicoes 2..6 sao o AAMM
    expect(chaveAcesso.slice(2, 6)).toBe("2606");
  });

  it("natOp vazia recebe fallback 'VENDA' e e truncada a 60 (XML-19)", () => {
    const { xml } = builder.build({
      draft: makeDraft({ naturezaOperacao: "" }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    });
    expect(xml).toContain("<natOp>VENDA</natOp>");
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
      cNF: "87654321",
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
      cNF: "87654321",
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
      cNF: "87654321",
    });
    expect(xml).toContain("<modFrete>9</modFrete>");
  });

  it("inclui <pag><detPag><tPag>90 quando sem pagamento", () => {
    const { xml } = builder.build({
      draft: makeDraft({ pagamentosJson: null }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
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
      cNF: "87654321",
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
      cNF: "87654321",
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
      cNF: "87654321",
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
      cNF: "87654321",
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
        cNF: "87654321",
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
        cNF: "87654321",
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
        cNF: "87654321",
      }),
    ).toThrow(/itens/);
  });
});

describe("NfeXmlBuilderSefazService — <infAdic>/<infCpl> (observacoes)", () => {
  const builder = new NfeXmlBuilderSefazService();
  const FIXED_DH = new Date("2026-05-14T15:00:00-03:00");
  const build = (overrides: Parameters<typeof makeDraft>[0] = {}) =>
    builder.build({
      draft: makeDraft(overrides),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    });

  it("TRAVA de regressao: sem observacao e sem numeroPedido NAO emite <infAdic>", () => {
    const { xml } = build();
    expect(xml).not.toContain("<infAdic");
    expect(xml).not.toContain("<infCpl");
  });

  it("apenas numeroPedido: infCpl identico ao comportamento atual", () => {
    const { xml } = build({ numeroPedido: "PED-001" });
    expect(xml).toContain("<infCpl>Pedido: PED-001</infCpl>");
  });

  it("observacao preenchida vai ao <infCpl>", () => {
    const { xml } = build({ informacoesComplementares: "Garantia de 90 dias" });
    expect(xml).toContain("<infCpl>Garantia de 90 dias</infCpl>");
  });

  it("observacao + pedido: observacao primeiro, separador ' | '", () => {
    const { xml } = build({
      informacoesComplementares: "Troca em ate 7 dias",
      numeroPedido: "PED-9",
    });
    expect(xml).toContain(
      "<infCpl>Troca em ate 7 dias | Pedido: PED-9</infCpl>",
    );
  });

  it("observacao so com espacos nao emite <infAdic>", () => {
    const { xml } = build({ informacoesComplementares: "   " });
    expect(xml).not.toContain("<infAdic");
  });

  it("escapa caracteres especiais da observacao (sem escape duplo)", () => {
    const { xml } = build({
      informacoesComplementares: 'P&D <TESTE> "fragil"',
    });
    expect(xml).toContain("P&amp;D");
    expect(xml).toMatch(/&lt;TESTE&gt;/);
    expect(xml).not.toContain("&amp;amp;");
  });

  it("normaliza CRLF e remove caracteres de controle da observacao", () => {
    const { xml } = build({
      informacoesComplementares: "linha1\r\nlinha2" + String.fromCharCode(7),
    });
    const match = xml.match(/<infCpl>([\s\S]*?)<\/infCpl>/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("linha1\nlinha2");
    expect(match![1]).not.toContain(String.fromCharCode(7));
  });

  it("trunca o infCpl em 5000 caracteres (limite do leiaute)", () => {
    const { xml } = build({ informacoesComplementares: "A".repeat(6000) });
    const match = xml.match(/<infCpl>([\s\S]*?)<\/infCpl>/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(5000);
  });

  it("<infAdic> permanece como ultimo elemento do infNFe (apos <pag>)", () => {
    const { xml } = build({ informacoesComplementares: "obs" });
    const posPag = xml.indexOf("</pag>");
    const posInfAdic = xml.indexOf("<infAdic>");
    expect(posPag).toBeGreaterThan(-1);
    expect(posInfAdic).toBeGreaterThan(posPag);
  });
});

describe("NfeXmlBuilderSefazService — saneamento de espaços (XSD TString)", () => {
  const builder = new NfeXmlBuilderSefazService();
  const FIXED_DH = new Date("2026-05-14T15:00:00-03:00");

  it("remove espaço no início/fim dos campos texto (corrige 'Falha no Schema XML')", () => {
    const draft = makeDraft({
      ambiente: "PRODUCAO", // produção usa o nome real (homologação força literal)
      destinoOperacao: "INTERESTADUAL",
      destinatarioJson: {
        tipoPessoa: "PF",
        cpfCnpj: "34053537851",
        nome: "  Talita Aparecida Neves  ",
        inscricaoEstadual: "ISENTO",
        email: null,
        telefone: null,
        cep: "13472290",
        logradouro: "Rua São Gonçalo ",
        numero: "40 ",
        complemento: "   ", // só espaços → deve ser OMITIDO (não vira tag vazia)
        bairro: " Jardim Nossa Senhora do Carmo",
        municipio: "Americana",
        codMunicipio: " 3501608 ",
        uf: " SP ",
        codPais: "1058",
        pais: "BRASIL",
      },
      itens: [
        makeItem({
          codigo: " 6 ",
          descricao: "Tampa Combustível Citroen C3 2011 Preto 2011 ",
          unidade: "UN ",
          cfop: "6102",
        }),
      ],
    });

    const { xml } = builder.build({
      draft,
      config: makeConfig({ regimeTributario: "SIMPLES" }),
      numero: 52,
      dhEmi: FIXED_DH,
      cNF: "10000001",
    });

    // Nenhum valor de texto pode ter espaço colado nas tags.
    expect(xml).toContain(
      "<xProd>Tampa Combustível Citroen C3 2011 Preto 2011</xProd>",
    );
    expect(xml).toContain("<xNome>Talita Aparecida Neves</xNome>");
    expect(xml).toContain("<xLgr>Rua São Gonçalo</xLgr>");
    expect(xml).toContain("<nro>40</nro>");
    expect(xml).toContain("<xBairro>Jardim Nossa Senhora do Carmo</xBairro>");
    expect(xml).toContain("<cMun>3501608</cMun>");
    expect(xml).toContain("<UF>SP</UF>");
    expect(xml).toContain("<cProd>6</cProd>");
    expect(xml).toContain("<uCom>UN</uCom>");
    expect(xml).toContain("<uTrib>UN</uTrib>");

    // complemento só-espaços é omitido (não gera <xCpl></xCpl>).
    expect(xml).not.toContain("<xCpl>");

    // Garantia genérica: nenhum campo texto termina com espaço antes do fecho.
    expect(xml).not.toMatch(/<xProd>[^<]* <\/xProd>/);
    expect(xml).not.toMatch(/<xNome>[^<]* <\/xNome>/);
    expect(xml).not.toMatch(/<xLgr>[^<]* <\/xLgr>/);
  });

  it("não altera valores já limpos (zero regressão)", () => {
    const { xml } = builder.build({
      draft: makeDraft({
        itens: [makeItem({ descricao: "PRODUTO LIMPO", unidade: "UN" })],
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED_DH,
      cNF: "87654321",
    });
    expect(xml).toContain("<xProd>PRODUTO LIMPO</xProd>");
    expect(xml).toContain("<uCom>UN</uCom>");
  });
});
