import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  NfeXmlBuilderSefazService,
  type NfeRespTec,
} from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";

// ──────────────────────────────────────────────────────────────────────────
// BUG 2 — grupo <infRespTec> (Responsável Técnico, NT 2018.005). Deve ser o
// ULTIMO filho de infNFe, dentro do conteúdo assinado. Kill-switch: sem respTec
// o XML fica idêntico ao anterior. CSRT é condicional/off por padrão.
// ──────────────────────────────────────────────────────────────────────────

const builder = new NfeXmlBuilderSefazService();
const FIXED_DH = new Date("2026-05-14T15:00:00-03:00");

const RT: NfeRespTec = {
  cnpj: "51.195.502/0001-56",
  xContato: "Suporte Dexo",
  email: "suporte@usedexo.com.br",
  fone: "(11) 99999-9999",
};

function build(respTec?: NfeRespTec, over: Record<string, any> = {}) {
  return builder.build({
    draft: makeDraft({ ambiente: "PRODUCAO", ...over }),
    config: makeConfig({ ambiente: "PRODUCAO" }),
    numero: 1,
    dhEmi: FIXED_DH,
    cNF: "87654321",
    respTec,
  });
}

describe("NfeXmlBuilderSefazService — <infRespTec>", () => {
  it("KILL-SWITCH: sem respTec, NAO emite <infRespTec>", () => {
    const { xml } = build(undefined);
    expect(xml).not.toContain("infRespTec");
  });

  it("com respTec, emite CNPJ/xContato/email/fone (CNPJ e fone so digitos)", () => {
    const { xml } = build(RT);
    expect(xml).toContain("<infRespTec>");
    expect(xml).toContain("<CNPJ>51195502000156</CNPJ>");
    expect(xml).toContain("<xContato>Suporte Dexo</xContato>");
    expect(xml).toContain("<email>suporte@usedexo.com.br</email>");
    expect(xml).toContain("<fone>11999999999</fone>");
    expect(xml).not.toContain("idCSRT");
    expect(xml).not.toContain("hashCSRT");
  });

  it("<infRespTec> e o ULTIMO filho de infNFe (imediatamente antes de </infNFe>)", () => {
    const { xml } = build(RT, { numeroPedido: "PED-1" }); // tambem gera <infAdic>
    const posInfAdic = xml.indexOf("</infAdic>");
    const posRT = xml.indexOf("<infRespTec>");
    const posFimRT = xml.indexOf("</infRespTec>");
    expect(posInfAdic).toBeGreaterThan(-1);
    expect(posRT).toBeGreaterThan(posInfAdic); // depois de infAdic
    // </infRespTec> e imediatamente seguido de </infNFe> — e o ultimo grupo.
    expect(xml.slice(posFimRT)).toMatch(/^<\/infRespTec><\/infNFe>/);
  });

  it("sem <infAdic>, <infRespTec> vem depois de </pag>", () => {
    const { xml } = build(RT); // sem obs/pedido => sem infAdic
    expect(xml).not.toContain("<infAdic");
    expect(xml.indexOf("<infRespTec>")).toBeGreaterThan(xml.indexOf("</pag>"));
  });

  it("CSRT: idCSRT + hashCSRT = Base64(SHA1(csrt + chaveAcesso)) quando ambos setados", () => {
    const csrt = "G8H2SEGREDOxyz";
    const { xml, chaveAcesso } = build({ ...RT, idCSRT: "01", csrt });
    const expected = createHash("sha1")
      .update(csrt + chaveAcesso, "utf8")
      .digest("base64");
    expect(xml).toContain("<idCSRT>01</idCSRT>");
    expect(xml).toContain(`<hashCSRT>${expected}</hashCSRT>`);
  });

  it("CSRT parcial (so idCSRT, sem csrt) NAO emite idCSRT/hashCSRT", () => {
    const { xml } = build({ ...RT, idCSRT: "01" });
    expect(xml).toContain("<infRespTec>");
    expect(xml).not.toContain("idCSRT");
    expect(xml).not.toContain("hashCSRT");
  });

  it("subcampo faltando (email vazio) → lanca erro claro (nao emite grupo pela metade)", () => {
    expect(() => build({ ...RT, email: "" })).toThrow(/incompleto|email/i);
  });

  it("CNPJ invalido (digitos != 14) → lanca erro claro", () => {
    expect(() => build({ ...RT, cnpj: "123" })).toThrow(/CNPJ/i);
  });

  it("nao afeta o restante do XML (emit/dest/total/NFe intactos)", () => {
    const { xml } = build(RT);
    expect(xml).toContain("<emit>");
    expect(xml).toContain("<dest>");
    expect(xml).toContain("<total>");
    expect(xml).toContain("</NFe>");
  });
});
