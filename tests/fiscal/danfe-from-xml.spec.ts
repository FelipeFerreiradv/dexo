import { describe, it, expect } from "vitest";
import {
  DanfePdfService,
  projectParsedNfeToDraft,
} from "../../app/fiscal/generators/danfe-pdf.service";
import { parseNfeXml } from "../../app/fiscal/sefaz/nfe-xml-parser.service";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

describe("DanfePdfService.generateFromXml — round-trip do nosso builder", () => {
  it("gera DANFE a partir de um XML que nosso builder produziu", async () => {
    const builder = new NfeXmlBuilderSefazService();
    const built = builder.build({
      draft: makeDraft({
        itens: [makeItem(), makeItem({ codigo: "PROD-002", descricao: "OUTRO ITEM" })],
      }),
      config: makeConfig(),
      numero: 7,
      dhEmi: new Date("2026-05-14T15:00:00-03:00"),
      cNF: "12345678",
    });

    // Encapsula em nfeProc com um protNFe sintético, como a SEFAZ retornaria
    const nfeProcXml = wrapInProc(built.xml, built.chaveAcesso);

    const service = new DanfePdfService();
    const pdfBytes = await service.generateFromXml(nfeProcXml);

    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.byteLength).toBeGreaterThan(500); // PDF não-vazio
    expect(toAscii(pdfBytes).startsWith("%PDF-")).toBe(true);
  });

  it("DANFE do XML tem mesmos campos visíveis do DANFE do DB", async () => {
    const builder = new NfeXmlBuilderSefazService();
    const draft = makeDraft();
    const config = makeConfig();
    const built = builder.build({
      draft,
      config,
      numero: 42,
      dhEmi: new Date("2026-05-14T15:00:00-03:00"),
      cNF: "12345678",
    });
    const nfeProcXml = wrapInProc(built.xml, built.chaveAcesso);

    const service = new DanfePdfService();
    const pdfFromXml = await service.generateFromXml(nfeProcXml);
    const pdfFromDb = await service.generate(
      { ...draft, numero: 42, chaveAcesso: built.chaveAcesso },
      config,
      built.chaveAcesso,
      "135260000000001",
    );

    // Comparação estrutural: ambos devem ser PDFs válidos com tamanho similar
    expect(pdfFromXml.byteLength).toBeGreaterThan(500);
    expect(pdfFromDb.byteLength).toBeGreaterThan(500);
    // Tamanho não tem que bater byte-a-byte (timestamps PDF diferem), mas a
    // ordem de magnitude deve coincidir (mesmo conteúdo renderizado)
    const ratio = pdfFromXml.byteLength / pdfFromDb.byteLength;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);
  });
});

describe("projectParsedNfeToDraft — mapeamento XML → tipos de domínio", () => {
  it("preserva numero, serie, chave e total na projecao", () => {
    const builder = new NfeXmlBuilderSefazService();
    const built = builder.build({
      draft: makeDraft(),
      config: makeConfig(),
      numero: 99,
      dhEmi: new Date("2026-05-14T15:00:00-03:00"),
      cNF: "12345678",
    });
    const nfeProcXml = wrapInProc(built.xml, built.chaveAcesso);
    const parsed = parseNfeXml(nfeProcXml);
    const { draft, config } = projectParsedNfeToDraft(parsed);

    expect(draft.numero).toBe(99);
    expect(draft.serie).toBe(1);
    expect(draft.chaveAcesso).toBe(built.chaveAcesso);
    expect(draft.ambiente).toBe("HOMOLOGACAO");
    expect(draft.status).toBe("AUTHORIZED");
    expect(draft.itens).toHaveLength(1);
    expect(draft.itens[0].codigo).toBe("PROD-001");

    expect(config.cnpj).toBe("11222333000181");
    expect(config.razaoSocial).toBe("EMPRESA TESTE LTDA");
    expect(config.uf).toBe("SP");
    expect(config.regimeTributario).toBe("SIMPLES"); // CRT=1
    expect(config.providerName).toBe("SEFAZ_DIRECT");

    expect(draft.totaisJson?.totalNota).toBe(100);
    expect(draft.totaisJson?.totalProdutos).toBe(100);
  });

  it("destinatario PF (CPF) e marcado como PF na projecao", () => {
    const builder = new NfeXmlBuilderSefazService();
    const built = builder.build({
      // PRODUCAO para preservar o nome real do destinatario no XML (em
      // homologacao o xNome e substituido pelo literal da Rejeicao 598).
      draft: makeDraft({
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
      }),
      config: makeConfig(),
      numero: 1,
      dhEmi: new Date("2026-05-14T15:00:00-03:00"),
      cNF: "12345678",
    });
    const nfeProcXml = wrapInProc(built.xml, built.chaveAcesso);
    const parsed = parseNfeXml(nfeProcXml);
    const { draft } = projectParsedNfeToDraft(parsed);

    expect(draft.destinatarioJson?.tipoPessoa).toBe("PF");
    expect(draft.destinatarioJson?.cpfCnpj).toBe("12345678901");
    expect(draft.destinatarioJson?.nome).toBe("JOAO PF");
  });

  it("regime LUCRO_PRESUMIDO ↔ CRT=3", () => {
    const builder = new NfeXmlBuilderSefazService();
    const built = builder.build({
      draft: makeDraft({
        itens: [
          makeItem({
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
          }),
        ],
      }),
      config: makeConfig({ regimeTributario: "LUCRO_PRESUMIDO" }),
      numero: 1,
      dhEmi: new Date("2026-05-14T15:00:00-03:00"),
      cNF: "12345678",
    });
    const nfeProcXml = wrapInProc(built.xml, built.chaveAcesso);
    const parsed = parseNfeXml(nfeProcXml);
    const { config } = projectParsedNfeToDraft(parsed);

    expect(config.regimeTributario).toBe("LUCRO_PRESUMIDO");
  });
});

/**
 * Embrulha um <NFe> assinado num <nfeProc> com protNFe sintético, como a
 * SEFAZ retornaria após autorização.
 */
function wrapInProc(nfeXml: string, chave: string): string {
  // Remove a declaração XML do nfeXml — o nfeProc terá a sua própria
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

function toAscii(bytes: Uint8Array): string {
  let s = "";
  const limit = Math.min(bytes.length, 16);
  for (let i = 0; i < limit; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
