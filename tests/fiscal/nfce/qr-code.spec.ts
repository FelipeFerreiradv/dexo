import { describe, it, expect } from "vitest";
import { createHash } from "crypto";

import {
  montarQrCodeNfce,
  buildInfNFeSuplXml,
  injectInfNFeSupl,
  extractQrCodeFromXml,
  NFCE_QR_VERSAO,
} from "../../../app/fiscal/nfce/qr-code";
import { getNfceQrUrls } from "../../../app/fiscal/nfce/nfce-urls";
import {
  montarChave,
  chaveToString,
  parseChave,
} from "../../../app/fiscal/sefaz/chave-acesso";

// Chave 65 determinística p/ os testes (cNF fixo válido).
function chave65(): string {
  const partes = montarChave({
    uf: "SC",
    ano: 2026,
    mes: 7,
    cnpj: "11222333000181",
    modelo: "65",
    serie: 1,
    numero: 123,
    tpEmis: 1,
    cNF: "10000007",
  });
  return chaveToString(partes);
}

describe("chave de acesso modelo 65", () => {
  it("mod=65 nas posicoes 20-21 e DV valido (parseChave roundtrip)", () => {
    const chave = chave65();
    expect(chave).toHaveLength(44);
    expect(chave.slice(20, 22)).toBe("65");
    const parts = parseChave(chave);
    expect(parts.mod).toBe("65");
    expect(parts.serie).toBe("001");
    expect(parts.nNF).toBe("000000123");
  });
});

describe("montarQrCodeNfce (QR v2 online)", () => {
  const base = {
    tpAmb: "2" as const,
    cscId: "000001",
    cscToken: "SEGREDO-CSC-DE-TESTE",
    uf: "SC" as const,
    ambiente: "homologacao" as const,
  };

  it("p-string: chave|2|tpAmb|cIdToken(sem zeros)|SHA1_HEX_MAIUSCULO", () => {
    const chave = chave65();
    const { qrCode } = montarQrCodeNfce({ ...base, chaveAcesso: chave });

    const url = new URL(qrCode);
    const p = url.searchParams.get("p")!;
    const [chNFe, versao, tpAmb, cIdToken, hash] = p.split("|");
    expect(chNFe).toBe(chave);
    expect(versao).toBe(NFCE_QR_VERSAO);
    expect(tpAmb).toBe("2");
    // "000001" → "1" (sem zeros à esquerda)
    expect(cIdToken).toBe("1");
    // Vetor calculado à mão: SHA1(parcial + CSC) hex maiúsculo, 40 chars.
    const esperado = createHash("sha1")
      .update(`${chave}|2|2|1` + base.cscToken, "utf8")
      .digest("hex")
      .toUpperCase();
    expect(hash).toBe(esperado);
    expect(hash).toMatch(/^[0-9A-F]{40}$/);
  });

  it("usa a URL da UF/ambiente (SC homolog e prod distintas)", () => {
    const chave = chave65();
    const hom = montarQrCodeNfce({ ...base, chaveAcesso: chave });
    expect(hom.qrCode.startsWith("https://hom.sat.sef.sc.gov.br/")).toBe(true);
    const prod = montarQrCodeNfce({
      ...base,
      chaveAcesso: chave,
      tpAmb: "1",
      ambiente: "producao",
    });
    expect(prod.qrCode.startsWith("https://sat.sef.sc.gov.br/")).toBe(true);
    expect(prod.urlChave).toBe(getNfceQrUrls("SC", "producao").chave);
  });

  it("UF sem tabela → erro claro; CSC/id invalidos → erro claro", () => {
    const chave = chave65();
    expect(() =>
      montarQrCodeNfce({ ...base, chaveAcesso: chave, uf: "SP" as any }),
    ).toThrow(/sem URLs de QR Code NFC-e/);
    expect(() =>
      montarQrCodeNfce({ ...base, chaveAcesso: chave, cscToken: "  " }),
    ).toThrow(/CSC/);
    expect(() =>
      montarQrCodeNfce({ ...base, chaveAcesso: chave, cscId: "0" }),
    ).toThrow(/idCSC/);
    expect(() =>
      montarQrCodeNfce({ ...base, chaveAcesso: "123" }),
    ).toThrow(/44/);
  });
});

describe("infNFeSupl — build/inject/extract", () => {
  it("bloco com qrCode em CDATA + urlChave", () => {
    const xml = buildInfNFeSuplXml("https://qr?p=A|2|2|1|HASH", "https://consulta");
    expect(xml).toBe(
      "<infNFeSupl><qrCode><![CDATA[https://qr?p=A|2|2|1|HASH]]></qrCode><urlChave>https://consulta</urlChave></infNFeSupl>",
    );
  });

  it("injeta ENTRE </infNFe> e <Signature (posicao do schema)", () => {
    const assinado =
      '<NFe xmlns="ns"><infNFe Id="NFe1">conteudo</infNFe><Signature>sig</Signature></NFe>';
    const out = injectInfNFeSupl(assinado, "<infNFeSupl>X</infNFeSupl>");
    expect(out).toBe(
      '<NFe xmlns="ns"><infNFe Id="NFe1">conteudo</infNFe><infNFeSupl>X</infNFeSupl><Signature>sig</Signature></NFe>',
    );
  });

  it("sem <Signature> → erro (nunca injeta em XML nao assinado)", () => {
    expect(() =>
      injectInfNFeSupl("<NFe><infNFe/></NFe>", "<infNFeSupl/>"),
    ).toThrow(/Signature/);
  });

  it("extractQrCodeFromXml recupera qrCode (CDATA) e urlChave", () => {
    const xml =
      "<nfeProc><NFe><infNFeSupl><qrCode><![CDATA[https://qr?p=X]]></qrCode><urlChave>https://chave</urlChave></infNFeSupl></NFe></nfeProc>";
    const got = extractQrCodeFromXml(xml);
    expect(got.qrCode).toBe("https://qr?p=X");
    expect(got.urlChave).toBe("https://chave");
    expect(extractQrCodeFromXml("<NFe/>")).toEqual({
      qrCode: null,
      urlChave: null,
    });
  });
});
