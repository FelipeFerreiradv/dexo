import { describe, it, expect } from "vitest";
import { XMLParser } from "fast-xml-parser";
import {
  buildRelatorioMensalXml,
  stripXmlDeclaration,
  escapeXmlAttr,
  formatBrasiliaIso,
  type RelatorioNota,
} from "../../app/fiscal/generators/relatorio-mensal-xml";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft } from "./__helpers__/test-draft";

const GERADO_EM = new Date("2026-06-12T12:00:00-03:00");

/** nfeProc real (builder SEFAZ + protNFe sintético), como salvo em disco. */
function makeNfeProc(numero: number): { xml: string; chave: string } {
  const builder = new NfeXmlBuilderSefazService();
  const built = builder.build({
    draft: makeDraft(),
    config: makeConfig(),
    numero,
    dhEmi: new Date("2026-04-10T12:00:00-03:00"),
    cNF: "87654321",
  });
  const inner = built.xml.replace(/^<\?xml[\s\S]*?\?>\s*/, "");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    inner,
    '<protNFe versao="4.00"><infProt>',
    "<tpAmb>2</tpAmb>",
    `<chNFe>${built.chaveAcesso}</chNFe>`,
    "<dhRecbto>2026-04-10T12:00:31-03:00</dhRecbto>",
    "<nProt>135260000000777</nProt>",
    "<cStat>100</cStat>",
    "<xMotivo>Autorizado o uso da NF-e</xMotivo>",
    "</infProt></protNFe>",
    "</nfeProc>",
  ].join("");
  return { xml, chave: built.chaveAcesso };
}

function makeNota(
  numero: number,
  overrides: Partial<RelatorioNota> = {},
): RelatorioNota {
  const proc = makeNfeProc(numero);
  return {
    numero,
    serie: 1,
    chaveAcesso: proc.chave,
    status: "AUTHORIZED",
    dataEmissao: new Date("2026-04-10T15:00:00Z"),
    dataAutorizacao: new Date("2026-04-10T15:00:31Z"),
    protocoloAutorizacao: "135260000000777",
    destinatarioNome: "CLIENTE TESTE LTDA",
    destinatarioDocumento: "00000000000100",
    valorTotal: 100,
    xmlAutorizado: proc.xml,
    ...overrides,
  };
}

function parseRelatorio(xml: string): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
  });
  return parser.parse(xml);
}

describe("buildRelatorioMensalXml", () => {
  it("resumo com quantidade e soma corretas para 2 notas", () => {
    const xml = buildRelatorioMensalXml({
      emitente: { cnpj: "11222333000181", razaoSocial: "EMPRESA TESTE LTDA" },
      ano: 2026,
      mes: 4,
      geradoEm: GERADO_EM,
      notas: [
        makeNota(1, { valorTotal: 100.5 }),
        makeNota(2, { valorTotal: 200.25 }),
      ],
    });

    expect(xml).toContain('<resumo quantidade="2" valorTotal="300.75">');
    expect(xml).toContain('<competencia ano="2026" mes="04"/>');
    expect(xml).toContain(
      '<emitente cnpj="11222333000181" razaoSocial="EMPRESA TESTE LTDA"/>',
    );
  });

  it("embute o nfeProc VERBATIM, perdendo apenas a declaracao <?xml?>", () => {
    const proc = makeNfeProc(7);
    const semDeclaracao = stripXmlDeclaration(proc.xml);

    // strip removeu SO o prefixo da declaracao — original = declaracao + resto
    expect(proc.xml.endsWith(semDeclaracao)).toBe(true);
    expect(semDeclaracao.startsWith("<nfeProc")).toBe(true);

    const xml = buildRelatorioMensalXml({
      emitente: { cnpj: "11222333000181", razaoSocial: "EMPRESA TESTE LTDA" },
      ano: 2026,
      mes: 4,
      geradoEm: GERADO_EM,
      notas: [
        makeNota(7, { xmlAutorizado: proc.xml, chaveAcesso: proc.chave }),
      ],
    });

    // conteudo embutido byte-a-byte e UMA unica declaracao XML (a do topo)
    expect(xml).toContain(semDeclaracao);
    expect(xml.match(/<\?xml/g)).toHaveLength(1);
  });

  it("arquivo consolidado e XML bem-formado e o nfeProc interno permanece integro", () => {
    const xml = buildRelatorioMensalXml({
      emitente: { cnpj: "11222333000181", razaoSocial: "EMPRESA TESTE LTDA" },
      ano: 2026,
      mes: 4,
      geradoEm: GERADO_EM,
      notas: [makeNota(1), makeNota(2)],
    });

    const doc = parseRelatorio(xml);
    expect(doc.relatorioNFe).toBeDefined();
    expect(doc.relatorioNFe["@_versao"]).toBe("1.0");

    const resumoNotas = doc.relatorioNFe.resumo.nota;
    expect(Array.isArray(resumoNotas)).toBe(true);
    expect(resumoNotas).toHaveLength(2);
    expect(resumoNotas[0]["@_status"]).toBe("AUTHORIZED");
    expect(resumoNotas[0]["@_protocolo"]).toBe("135260000000777");

    const notas = doc.relatorioNFe.notas.nota;
    expect(notas).toHaveLength(2);
    // nfeProc interno parseado como no — estrutura preservada
    expect(notas[0].nfeProc).toBeDefined();
    expect(notas[0].nfeProc.NFe.infNFe).toBeDefined();
    expect(notas[0].nfeProc.protNFe.infProt.cStat).toBe("100");
    expect(notas[0]["@_chaveAcesso"]).toBe(String(makeNota(1).chaveAcesso));
  });

  it("mes sem notas devolve XML valido vazio", () => {
    const xml = buildRelatorioMensalXml({
      emitente: { cnpj: "11222333000181", razaoSocial: "EMPRESA TESTE LTDA" },
      ano: 2026,
      mes: 2,
      geradoEm: GERADO_EM,
      notas: [],
    });

    expect(xml).toContain('<resumo quantidade="0" valorTotal="0.00"/>');
    expect(xml).toContain("<notas/>");
    const doc = parseRelatorio(xml);
    expect(doc.relatorioNFe.resumo["@_quantidade"]).toBe("0");
  });

  it("XML ausente em disco: nota entra no resumo e leva xmlIndisponivel='true'", () => {
    const xml = buildRelatorioMensalXml({
      emitente: { cnpj: "11222333000181", razaoSocial: "EMPRESA TESTE LTDA" },
      ano: 2026,
      mes: 4,
      geradoEm: GERADO_EM,
      notas: [makeNota(1), makeNota(2, { xmlAutorizado: null })],
    });

    expect(xml).toContain('<resumo quantidade="2"');
    expect(xml).toContain('xmlIndisponivel="true"');

    const doc = parseRelatorio(xml);
    const notas = doc.relatorioNFe.notas.nota;
    expect(notas).toHaveLength(2);
    expect(notas[1]["@_xmlIndisponivel"]).toBe("true");
    expect(notas[1].nfeProc).toBeUndefined();
  });

  it("escapa atributos do container (destinatario com & e aspas)", () => {
    const xml = buildRelatorioMensalXml({
      emitente: { cnpj: "11222333000181", razaoSocial: 'A&B "PECAS" LTDA' },
      ano: 2026,
      mes: 4,
      geradoEm: GERADO_EM,
      notas: [makeNota(1, { destinatarioNome: 'OFICINA <X> & "Y"' })],
    });

    expect(xml).toContain("A&amp;B &quot;PECAS&quot; LTDA");
    const doc = parseRelatorio(xml);
    expect(doc.relatorioNFe.resumo.nota["@_destinatario"]).toBe(
      'OFICINA <X> & "Y"',
    );
  });
});

describe("stripXmlDeclaration", () => {
  it("remove BOM + declaracao e nada mais", () => {
    const body = "<a>conteudo intacto</a>";
    expect(
      stripXmlDeclaration('﻿<?xml version="1.0" encoding="UTF-8"?>\n' + body),
    ).toBe(body);
  });

  it("sem declaracao: devolve identico", () => {
    expect(stripXmlDeclaration("<a/>")).toBe("<a/>");
  });
});

describe("helpers", () => {
  it('escapeXmlAttr cobre & < > "', () => {
    expect(escapeXmlAttr('a&b<c>d"e')).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });

  it("formatBrasiliaIso converte instante UTC para -03:00 fixo", () => {
    // 15:00Z = 12:00 em Brasilia
    expect(formatBrasiliaIso(new Date("2026-04-10T15:00:00Z"))).toBe(
      "2026-04-10T12:00:00-03:00",
    );
  });
});
