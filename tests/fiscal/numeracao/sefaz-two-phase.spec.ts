import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

import {
  SefazDirectProvider,
  type SefazEmitPayload,
  type SefazPrepararEmissaoInput,
} from "../../../app/fiscal/providers/sefaz-direct.provider";
import {
  SoapClientService,
  type SoapResponse,
} from "../../../app/fiscal/sefaz/soap-client.service";
import type { LoadedCertificate } from "../../../app/fiscal/certificate/certificate-loader.service";
import { parsePfx } from "../../../app/fiscal/certificate/certificate-loader.service";
import { extrairDigestValue } from "../../../app/fiscal/sefaz/digest";
import type { NfeRespTec } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { generateTestCertificate } from "../__helpers__/test-certificate";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";

// Numeração V2 — SEFAZ direto em duas fases. prepararEmissao (monta+assina,
// sem rede, LANÇA) + transmitirPreparada (nunca lança) precisam enviar
// EXATAMENTE o que emitir() enviaria. emitir() segue intacto.

type Requisicao = {
  endpointUrl: string;
  envelope: string;
  soapAction?: string;
  timeoutMs?: number;
  retryMax?: number;
};

class FakeSoapClient extends SoapClientService {
  public readonly requests: Requisicao[] = [];
  private fila: Array<SoapResponse | Error> = [];
  private padrao: SoapResponse | Error;

  constructor(padrao: SoapResponse | Error = ok("")) {
    super();
    this.padrao = padrao;
  }

  responder(...r: Array<SoapResponse | Error>): this {
    this.fila.push(...r);
    return this;
  }

  get last(): Requisicao | undefined {
    return this.requests[this.requests.length - 1];
  }

  async send(req: Parameters<SoapClientService["send"]>[0]): Promise<SoapResponse> {
    this.requests.push({
      endpointUrl: req.endpointUrl,
      envelope: req.envelope,
      soapAction: req.soapAction,
      timeoutMs: req.timeoutMs,
      retryMax: req.retryMax,
    });
    const r = this.fila.length > 0 ? this.fila.shift()! : this.padrao;
    if (r instanceof Error) throw r;
    return r;
  }
}

function ok(body: string, status = 200): SoapResponse {
  return { status, body, headers: {}, durationMs: 1 };
}

const DH = new Date("2026-05-14T15:00:00-03:00");
const CNF = "87654321";
const AGORA_MS = 1_789_000_000_123; // idLote = Date.now() nos dois caminhos
const OUTRA_CHAVE = "35260511222333000181550010000000019999999995";

const RT_ENV: Record<string, string> = {
  NFE_RESP_TEC_CNPJ: "11.222.333/0001-81",
  NFE_RESP_TEC_XCONTATO: "Suporte Env",
  NFE_RESP_TEC_EMAIL: "env@example.com",
  NFE_RESP_TEC_FONE: "(11) 3333-4444",
  NFE_RESP_TEC_ID_CSRT: "",
  NFE_RESP_TEC_CSRT: "",
};

const RT_EMPRESA: NfeRespTec = {
  cnpj: "12345678000195",
  xContato: "Contato Empresa",
  email: "rt@empresa.example",
  fone: "41999998888",
};

function ligarRtEnv(): void {
  for (const [k, v] of Object.entries(RT_ENV)) vi.stubEnv(k, v);
}

function desligarRtEnv(): void {
  for (const k of Object.keys(RT_ENV)) vi.stubEnv(k, "");
}

function config55(over: Record<string, unknown> = {}) {
  return makeConfig(over as any);
}

function input55(over: Partial<SefazPrepararEmissaoInput> = {}): SefazPrepararEmissaoInput {
  return {
    draft: makeDraft(),
    config: config55(),
    numero: 101,
    cNF: CNF,
    dhEmi: DH,
    ...over,
  };
}

function payloadEmitir(i: SefazPrepararEmissaoInput): SefazEmitPayload {
  return { draft: i.draft, config: i.config, numero: i.numero, cNF: i.cNF, dhEmi: i.dhEmi };
}

function input65(): SefazPrepararEmissaoInput {
  return {
    draft: makeDraft({
      modelo: "65",
      indPresenca: "PRESENCIAL",
      pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
    }),
    config: makeConfig({
      uf: "SC",
      codMunicipio: "4205407",
      municipio: "FLORIANOPOLIS",
      cscId: "000001",
      cscToken: "CSC-DE-TESTE",
    } as any),
    numero: 55,
    cNF: CNF,
    dhEmi: DH,
  };
}

// ── Respostas SEFAZ ──

const RET_ENVI = (conteudo: string) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        ${conteudo}
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const LOTE_104 = `<tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>35</cUF><dhRecbto>2026-05-14T15:00:30-03:00</dhRecbto>`;

const PROT = (p: {
  chave: string;
  cStat: number;
  xMotivo: string;
  nProt?: string;
  digVal?: string;
}) =>
  `<protNFe versao="4.00"><infProt${p.nProt ? ` Id="ID${p.nProt}"` : ""}>` +
  `<tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic><chNFe>${p.chave}</chNFe>` +
  `<dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>` +
  (p.nProt ? `<nProt>${p.nProt}</nProt>` : "") +
  (p.digVal ? `<digVal>${p.digVal}</digVal>` : "") +
  `<cStat>${p.cStat}</cStat><xMotivo>${p.xMotivo}</xMotivo></infProt></protNFe>`;

const RET_CONS_SIT = (conteudo: string) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
      <retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        ${conteudo}
      </retConsSitNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const RET_CONS_RECI = (conteudo: string) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4">
      <retConsReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb><verAplic>SP</verAplic><nRec>351000000000001</nRec>
        ${conteudo}
      </retConsReciNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

let cert: LoadedCertificate;

beforeAll(() => {
  const tc = generateTestCertificate();
  cert = parsePfx(tc.pfxBuffer, tc.password);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function provider(
  soap: FakeSoapClient,
  over: { ambiente?: "homologacao" | "producao"; uf?: any; timeoutMs?: number; retryMax?: number } = {},
) {
  return new SefazDirectProvider({
    ambiente: over.ambiente ?? "homologacao",
    uf: over.uf ?? "SP",
    certificate: cert,
    soapClient: soap,
    timeoutMs: over.timeoutMs,
    retryMax: over.retryMax,
  });
}

// ─────────────────────────────── PARIDADE ───────────────────────────────

describe("paridade: emitir() × prepararEmissao + transmitirPreparada", () => {
  async function comparar(
    entrada: SefazPrepararEmissaoInput,
    opts: { ambiente?: "homologacao" | "producao"; uf?: any; timeoutMs?: number; retryMax?: number } = {},
  ) {
    vi.spyOn(Date, "now").mockReturnValue(AGORA_MS);
    const soapV1 = new FakeSoapClient();
    const soapV2 = new FakeSoapClient();

    const r1 = await provider(soapV1, opts).emitir({
      nfeData: payloadEmitir(entrada) as any,
      token: "",
      ref: "nfe-1",
    });
    const pv2 = provider(soapV2, opts);
    const prep = pv2.prepararEmissao(entrada);
    expect(soapV2.requests).toHaveLength(0); // preparar não toca a rede
    await pv2.transmitirPreparada(prep);

    expect(soapV1.requests).toHaveLength(1);
    expect(soapV2.requests).toHaveLength(1);
    const [a] = soapV1.requests;
    const [b] = soapV2.requests;
    return { a, b, prep, r1 };
  }

  it("NF-e 55 homologação sem RT no env: envelope, endpoint, action e opções byte-idênticos", async () => {
    desligarRtEnv();
    const { a, b, prep } = await comparar(input55(), { timeoutMs: 1234, retryMax: 0 });

    expect(b.envelope).toBe(a.envelope);
    expect(b.endpointUrl).toBe(a.endpointUrl);
    expect(b.soapAction).toBe(a.soapAction);
    expect(b.timeoutMs).toBe(1234);
    expect(b.retryMax).toBe(0);
    expect(b).toEqual(a);

    // O XML assinado entra no envelope byte a byte.
    expect(b.envelope).toContain(prep.signedXml);
    expect(b.envelope).toContain(`<idLote>${AGORA_MS}</idLote>`);
    expect(b.envelope).toContain("<indSinc>1</indSinc>");
    expect(b.envelope).not.toContain("infRespTec");
  });

  it("NF-e 55 com RT do env (respTec undefined): idêntico e com <infRespTec> do env", async () => {
    ligarRtEnv();
    const { a, b } = await comparar(input55());
    expect(b).toEqual(a);
    expect(b.envelope).toContain("<infRespTec><CNPJ>11222333000181</CNPJ>");
  });

  it("NF-e 55 em PRODUÇÃO (tpAmb 1): idêntico", async () => {
    desligarRtEnv();
    const { a, b } = await comparar(
      input55({ draft: makeDraft({ ambiente: "PRODUCAO" }), config: config55({ ambiente: "PRODUCAO" }) }),
      { ambiente: "producao" },
    );
    expect(b).toEqual(a);
    expect(b.envelope).toContain("<tpAmb>1</tpAmb>");
  });

  it("NFC-e 65 (QR injetado após assinar, autorizador NFC-e): idêntico", async () => {
    desligarRtEnv();
    const { a, b, prep } = await comparar(input65(), { uf: "SC" });
    expect(b).toEqual(a);
    expect(prep.modelo).toBe("65");
    expect(b.endpointUrl).toContain("nfce-homologacao.svrs.rs.gov.br");
    expect(b.envelope).toContain("<infNFeSupl>");
    // Digest da tentativa continua o do infNFe (infNFeSupl fora da assinatura).
    expect(prep.digestValue).toBe(extrairDigestValue(prep.signedXml));
  });

  it("nfeProc da autorização síncrona é o mesmo que emitir() arquiva (montarNfeProc = builder existente)", async () => {
    desligarRtEnv();
    vi.spyOn(Date, "now").mockReturnValue(AGORA_MS);
    const entrada = input55();
    const pv2 = provider(new FakeSoapClient());
    const prep = pv2.prepararEmissao(entrada);
    const resposta = ok(
      RET_ENVI(
        LOTE_104 +
          PROT({ chave: prep.chaveAcesso, cStat: 100, xMotivo: "Autorizado o uso da NF-e", nProt: "135260000000001", digVal: prep.digestValue }),
      ),
    );

    const soapV1 = new FakeSoapClient(resposta);
    const soapV2 = new FakeSoapClient(resposta);
    const r1 = await provider(soapV1).emitir({ nfeData: payloadEmitir(entrada) as any, token: "", ref: "nfe-1" });
    const pT = provider(soapV2);
    const t = await pT.transmitirPreparada(pT.prepararEmissao(entrada));

    expect(r1.status).toBe("autorizada");
    expect(t.xmlAutorizado).not.toBeNull();
    expect(t.xmlAutorizado).toBe(r1.xmlAutorizado);
    expect(SefazDirectProvider.montarNfeProc(prep.signedXml, t.protNFeXml!)).toBe(r1.xmlAutorizado);
  });
});

// ─────────────────────────────── PREPARAR ───────────────────────────────

describe("prepararEmissao", () => {
  it("é determinística para cNF/dhEmi fixos e devolve chave/cNF/digest coerentes", () => {
    desligarRtEnv();
    const soap = new FakeSoapClient();
    const p = provider(soap);
    const a = p.prepararEmissao(input55());
    const b = p.prepararEmissao(input55());

    expect(a).toEqual(b);
    expect(a.modelo).toBe("55");
    expect(a.tpEmis).toBe(1);
    expect(a.chaveAcesso).toMatch(/^\d{44}$/);
    expect(a.chaveAcesso.slice(20, 22)).toBe("55");
    expect(Number(a.chaveAcesso.slice(25, 34))).toBe(101);
    expect(a.chaveAcesso.slice(34, 35)).toBe("1");
    expect(a.cNF).toBe(CNF);
    expect(a.chaveAcesso.slice(35, 43)).toBe(CNF);
    expect(a.dhEmi.getTime()).toBe(DH.getTime());
    expect(a.signedXml).toContain(`Id="NFe${a.chaveAcesso}"`);
    expect(a.signedXml).toContain("<Signature");
    expect(a.digestValue).toBe(extrairDigestValue(a.signedXml));
    expect(a.signedXml).toContain(`<DigestValue>${a.digestValue}</DigestValue>`);
    expect(soap.requests).toHaveLength(0);
  });

  it("LANÇA quando falta codMunicipio — enquanto emitir() devolve status 'erro' (V1 intacto)", async () => {
    desligarRtEnv();
    const soap = new FakeSoapClient();
    const p = provider(soap);
    const entrada = input55({ config: config55({ codMunicipio: null }) });

    expect(() => p.prepararEmissao(entrada)).toThrow(/Falha ao montar XML NFe: .*codMunicipio/);

    const r = await p.emitir({ nfeData: payloadEmitir(entrada) as any, token: "", ref: "nfe-1" });
    expect(r.status).toBe("erro");
    expect(r.success).toBe(false);
    expect(r.mensagem).toMatch(/codMunicipio/);
    expect(soap.requests).toHaveLength(0);
  });

  it("LANÇA em entrada inválida (numero, cNF, dhEmi, draft/config) sem tocar a rede", () => {
    const soap = new FakeSoapClient();
    const p = provider(soap);
    expect(() => p.prepararEmissao(input55({ numero: 0 }))).toThrow(/numero invalido/);
    expect(() => p.prepararEmissao(input55({ numero: 1.5 }))).toThrow(/numero invalido/);
    expect(() => p.prepararEmissao(input55({ cNF: "" }))).toThrow(/cNF/);
    expect(() => p.prepararEmissao(input55({ cNF: "1234" }))).toThrow(/cNF/);
    expect(() => p.prepararEmissao(input55({ dhEmi: new Date("x") }))).toThrow(/dhEmi/);
    expect(() => p.prepararEmissao(input55({ draft: undefined as any }))).toThrow(/draft e config/);
    expect(() => p.prepararEmissao(input55({ config: undefined as any }))).toThrow(/draft e config/);
    expect(soap.requests).toHaveLength(0);
  });

  it("LANÇA quando o cNF viola a regra 778 (igual ao número)", () => {
    const p = provider(new FakeSoapClient());
    expect(() => p.prepararEmissao(input55({ numero: 87654321 }))).toThrow(/778/);
  });

  it("LANÇA na NFC-e sem CSC (QR)", () => {
    desligarRtEnv();
    const semCsc = input65();
    semCsc.config = { ...semCsc.config, cscToken: null } as any;
    expect(() => provider(new FakeSoapClient(), { uf: "SC" }).prepararEmissao(semCsc)).toThrow(
      /Falha ao montar QR Code da NFC-e/,
    );
  });

  it("LANÇA quando a UF não tem autorizador (falha local ANTES de gravar a tentativa)", () => {
    desligarRtEnv();
    const soap = new FakeSoapClient();
    expect(() => provider(soap, { uf: "ZZ" }).prepararEmissao(input55())).toThrow(/UF nao suportada/);
    expect(soap.requests).toHaveLength(0);
  });

  describe("respTec: undefined ⇒ env; null ⇒ sem grupo; objeto ⇒ objeto", () => {
    it("undefined + env ligado ⇒ <infRespTec> do env (igual a emitir)", () => {
      ligarRtEnv();
      const prep = provider(new FakeSoapClient()).prepararEmissao(input55());
      expect(prep.signedXml).toContain("<infRespTec><CNPJ>11222333000181</CNPJ>");
      expect(prep.signedXml).toContain("<xContato>Suporte Env</xContato>");
    });

    it("undefined + env desligado ⇒ sem <infRespTec>", () => {
      desligarRtEnv();
      const prep = provider(new FakeSoapClient()).prepararEmissao(input55());
      expect(prep.signedXml).not.toContain("infRespTec");
    });

    it("null ⇒ sem <infRespTec> mesmo com env ligado", () => {
      ligarRtEnv();
      const prep = provider(new FakeSoapClient()).prepararEmissao(input55({ respTec: null }));
      expect(prep.signedXml).not.toContain("infRespTec");
    });

    it("objeto ⇒ usa o objeto, nunca o env", () => {
      ligarRtEnv();
      const prep = provider(new FakeSoapClient()).prepararEmissao(input55({ respTec: RT_EMPRESA }));
      expect(prep.signedXml).toContain("<infRespTec><CNPJ>12345678000195</CNPJ>");
      expect(prep.signedXml).toContain("<email>rt@empresa.example</email>");
      expect(prep.signedXml).not.toContain("11222333000181</CNPJ><xContato>Suporte Env");
    });

    it("objeto com CSRT ⇒ idCSRT/hashCSRT dentro da assinatura", () => {
      desligarRtEnv();
      const prep = provider(new FakeSoapClient()).prepararEmissao(
        input55({ respTec: { ...RT_EMPRESA, idCSRT: "01", csrt: "SEGREDO-CSRT" } }),
      );
      expect(prep.signedXml).toContain("<idCSRT>01</idCSRT>");
      expect(prep.signedXml).toContain("<hashCSRT>");
      expect(prep.signedXml).not.toContain("SEGREDO-CSRT");
    });

    it("objeto incompleto ⇒ LANÇA (emitir devolveria 'erro' e queimaria o número)", () => {
      desligarRtEnv();
      expect(() =>
        provider(new FakeSoapClient()).prepararEmissao(
          input55({ respTec: { ...RT_EMPRESA, email: "" } }),
        ),
      ).toThrow(/infRespTec habilitado mas incompleto/);
    });

    it("respTec muda o digest (o grupo está dentro do infNFe assinado)", () => {
      const p = provider(new FakeSoapClient());
      const sem = p.prepararEmissao(input55({ respTec: null }));
      const com = p.prepararEmissao(input55({ respTec: RT_EMPRESA }));
      expect(com.chaveAcesso).toBe(sem.chaveAcesso);
      expect(com.digestValue).not.toBe(sem.digestValue);
    });
  });
});

// ────────────────────────────── TRANSMITIR ──────────────────────────────

describe("transmitirPreparada — parsing bruto (nunca lança)", () => {
  function preparar(soap: FakeSoapClient) {
    desligarRtEnv();
    const p = provider(soap);
    return { p, prep: p.prepararEmissao(input55()) };
  }

  it("100 síncrono: lote 104 + protNFe 100 ⇒ nProt, dhRecbto, chNFe, protNFe e nfeProc", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    const prot = PROT({ chave: prep.chaveAcesso, cStat: 100, xMotivo: "Autorizado o uso da NF-e", nProt: "135260000000001", digVal: prep.digestValue });
    soap.responder(ok(RET_ENVI(LOTE_104 + prot)));

    const t = await p.transmitirPreparada(prep);

    expect(t.transporte).toBeNull();
    expect(t.httpStatus).toBe(200);
    expect(t.loteCStat).toBe(104);
    expect(t.loteXMotivo).toBe("Lote processado");
    expect(t.protCStat).toBe(100);
    expect(t.protXMotivo).toBe("Autorizado o uso da NF-e");
    expect(t.nProt).toBe("135260000000001");
    expect(t.dhRecbto?.toISOString()).toBe(new Date("2026-05-14T15:00:31-03:00").toISOString());
    expect(t.chNFe).toBe(prep.chaveAcesso);
    expect(t.nRec).toBeNull();
    expect(t.protNFeXml).toBe(prot);
    expect(t.xmlAutorizado).toBe(SefazDirectProvider.montarNfeProc(prep.signedXml, prot));
    expect(t.xmlAutorizado).toContain(prep.signedXml);
    expect(soap.last?.soapAction).toMatch(/nfeAutorizacaoLote$/);
  });

  it("150 (autorizada fora de prazo) também monta o nfeProc", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(ok(RET_ENVI(LOTE_104 + PROT({ chave: prep.chaveAcesso, cStat: 150, xMotivo: "Autorizado fora de prazo", nProt: "135260000000002" }))));
    const t = await p.transmitirPreparada(prep);
    expect(t.protCStat).toBe(150);
    expect(t.xmlAutorizado).toContain("<nfeProc");
  });

  it("103 (lote recebido): nRec, sem protNFe, sem nfeProc", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(
      ok(RET_ENVI(`<tpAmb>2</tpAmb><cStat>103</cStat><xMotivo>Lote recebido com sucesso</xMotivo><infRec><nRec>987654321012345</nRec><tMed>3</tMed></infRec>`)),
    );
    const t = await p.transmitirPreparada(prep);
    expect(t.loteCStat).toBe(103);
    expect(t.loteXMotivo).toBe("Lote recebido com sucesso");
    expect(t.nRec).toBe("987654321012345");
    expect(t.protCStat).toBeNull();
    expect(t.nProt).toBeNull();
    expect(t.protNFeXml).toBeNull();
    expect(t.xmlAutorizado).toBeNull();
  });

  it("225 no protNFe: rejeição com nProt null e sem nfeProc", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(ok(RET_ENVI(LOTE_104 + PROT({ chave: prep.chaveAcesso, cStat: 225, xMotivo: "Rejeicao: Falha no Schema XML da NFe" }))));
    const t = await p.transmitirPreparada(prep);
    expect(t.loteCStat).toBe(104);
    expect(t.protCStat).toBe(225);
    expect(t.protXMotivo).toBe("Rejeicao: Falha no Schema XML da NFe");
    expect(t.nProt).toBeNull();
    expect(t.chNFe).toBe(prep.chaveAcesso);
    expect(t.xmlAutorizado).toBeNull();
  });

  it("225 no LOTE (sem protNFe): loteCStat 225 e protCStat null", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(ok(RET_ENVI(`<tpAmb>2</tpAmb><cStat>225</cStat><xMotivo>Rejeicao: Falha no Schema XML do lote de NFe</xMotivo>`)));
    const t = await p.transmitirPreparada(prep);
    expect(t.loteCStat).toBe(225);
    expect(t.loteXMotivo).toMatch(/Schema/);
    expect(t.protCStat).toBeNull();
    expect(t.protXMotivo).toBe("");
  });

  it("539 com [chNFe:...] no xMotivo: preserva o xMotivo com a outra chave", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    const xMotivo = `Rejeicao: Duplicidade de NF-e, com diferenca na Chave de Acesso [chNFe:${OUTRA_CHAVE}][nRec:351000000000001]`;
    soap.responder(ok(RET_ENVI(LOTE_104 + PROT({ chave: prep.chaveAcesso, cStat: 539, xMotivo }))));
    const t = await p.transmitirPreparada(prep);
    expect(t.protCStat).toBe(539);
    expect(t.protXMotivo).toBe(xMotivo);
    expect(t.protXMotivo).toContain(OUTRA_CHAVE);
    expect(t.nProt).toBeNull();
    expect(t.xmlAutorizado).toBeNull();
  });

  it("protNFe de OUTRA chave nunca é atribuído a esta tentativa", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(ok(RET_ENVI(LOTE_104 + PROT({ chave: OUTRA_CHAVE, cStat: 100, xMotivo: "Autorizado", nProt: "1" }))));
    const t = await p.transmitirPreparada(prep);
    expect(t.loteCStat).toBe(104);
    expect(t.protCStat).toBeNull();
    expect(t.nProt).toBeNull();
    expect(t.protNFeXml).toBeNull();
    expect(t.xmlAutorizado).toBeNull();
  });

  it("timeout de transporte ⇒ TIMEOUT, sem cStat, não lança", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    const erro = Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ETIMEDOUT" });
    soap.responder(erro, new Error("ETIMEDOUT"));

    const t1 = await p.transmitirPreparada(prep);
    expect(t1.transporte).toBe("TIMEOUT");
    expect(t1.httpStatus).toBeNull();
    expect(t1.loteCStat).toBeNull();
    expect(t1.protCStat).toBeNull();
    expect(t1.nProt).toBeNull();
    expect(t1.xmlAutorizado).toBeNull();
    expect(t1.loteXMotivo).toMatch(/Erro de rede ao enviar NFe/);

    const t2 = await p.transmitirPreparada(prep);
    expect(t2.transporte).toBe("TIMEOUT");
  });

  it("erro de rede (ECONNRESET) ⇒ REDE, não lança", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const t = await p.transmitirPreparada(prep);
    expect(t.transporte).toBe("REDE");
    expect(t.httpStatus).toBeNull();
  });

  it("HTTP 500 ⇒ httpStatus 500, sem cStat (mesmo que o corpo tenha)", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder(ok(RET_ENVI(LOTE_104 + PROT({ chave: prep.chaveAcesso, cStat: 100, xMotivo: "x", nProt: "1" })), 500));
    const t = await p.transmitirPreparada(prep);
    expect(t.transporte).toBeNull();
    expect(t.httpStatus).toBe(500);
    expect(t.loteCStat).toBeNull();
    expect(t.protCStat).toBeNull();
    expect(t.xmlAutorizado).toBeNull();
    expect(t.loteXMotivo).toBe("HTTP 500 ao enviar NFe");
  });

  it("corpo ausente/ilegível ⇒ não lança, sem cStat", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    soap.responder({ status: 200, headers: {} } as any, ok("<html>gateway</html>"));
    const t1 = await p.transmitirPreparada(prep);
    expect(t1.transporte).toBeNull();
    expect(t1.loteCStat).toBeNull();
    const t2 = await p.transmitirPreparada(prep);
    expect(t2.loteCStat).toBeNull();
    expect(t2.protCStat).toBeNull();
  });

  it("reenvio do MESMO preparado: XML assinado idêntico, só o idLote muda", async () => {
    const soap = new FakeSoapClient();
    const { p, prep } = preparar(soap);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000_000_001);
    await p.transmitirPreparada(prep);
    now.mockReturnValue(1_000_000_000_002);
    await p.transmitirPreparada(prep);
    const [e1, e2] = soap.requests.map((r) => r.envelope);
    expect(e1).not.toBe(e2);
    expect(e1.replace(/<idLote>\d+<\/idLote>/, "")).toBe(e2.replace(/<idLote>\d+<\/idLote>/, ""));
    expect(e2).toContain(prep.signedXml);
  });
});

// ─────────────────────────────── CONSULTAS ───────────────────────────────

describe("consultarDetalhado (mesmo SOAP de consultar)", () => {
  let chave: string;
  let digest: string;

  beforeAll(() => {
    const prep = provider(new FakeSoapClient()).prepararEmissao(input55({ respTec: null }));
    chave = prep.chaveAcesso;
    digest = prep.digestValue;
  });

  it("envelope, endpoint e action idênticos aos de consultar()", async () => {
    const soap = new FakeSoapClient(ok(RET_CONS_SIT(`<cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo>`)));
    const p = provider(soap, { timeoutMs: 999, retryMax: 1 });
    await p.consultar(chave, "");
    await p.consultarDetalhado(chave);
    expect(soap.requests).toHaveLength(2);
    expect(soap.requests[1]).toEqual(soap.requests[0]);
  });

  it("100 com digVal ⇒ cStat, nProt, dhRecbto, digVal, chNFe e protNFe", async () => {
    const prot = PROT({ chave, cStat: 100, xMotivo: "Autorizado o uso da NF-e", nProt: "135260000000077", digVal: digest });
    const soap = new FakeSoapClient(
      ok(RET_CONS_SIT(`<tpAmb>2</tpAmb><verAplic>SP</verAplic><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><cUF>35</cUF><dhRecbto>2026-06-01T10:00:00-03:00</dhRecbto><chNFe>${chave}</chNFe>${prot}`)),
    );
    const c = await provider(soap).consultarDetalhado(chave);
    expect(c.transporte).toBeNull();
    expect(c.httpStatus).toBe(200);
    expect(c.cStat).toBe(100);
    expect(c.xMotivo).toBe("Autorizado o uso da NF-e");
    expect(c.nProt).toBe("135260000000077");
    // dhRecbto da AUTORIZAÇÃO (protNFe), não o horário da consulta.
    expect(c.dhRecbto?.toISOString()).toBe(new Date("2026-05-14T15:00:31-03:00").toISOString());
    expect(c.digVal).toBe(digest);
    expect(c.chNFe).toBe(chave);
    expect(c.protNFeXml).toBe(prot);
  });

  it("217 (não consta) ⇒ cStat 217, sem prot", async () => {
    const soap = new FakeSoapClient(ok(RET_CONS_SIT(`<tpAmb>2</tpAmb><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo><dhRecbto>2026-06-01T10:00:00-03:00</dhRecbto>`)));
    const c = await provider(soap).consultarDetalhado(chave);
    expect(c.cStat).toBe(217);
    expect(c.xMotivo).toMatch(/nao consta/);
    expect(c.nProt).toBeNull();
    expect(c.dhRecbto).toBeNull();
    expect(c.digVal).toBeNull();
    expect(c.protNFeXml).toBeNull();
  });

  it("110 (denegada) ⇒ cStat 110 com nProt do protNFe", async () => {
    const prot = PROT({ chave, cStat: 110, xMotivo: "Uso Denegado", nProt: "135260000000110", digVal: digest });
    const soap = new FakeSoapClient(ok(RET_CONS_SIT(`<cStat>110</cStat><xMotivo>Uso Denegado</xMotivo><chNFe>${chave}</chNFe>${prot}`)));
    const c = await provider(soap).consultarDetalhado(chave);
    expect(c.cStat).toBe(110);
    expect(c.nProt).toBe("135260000000110");
    expect(c.digVal).toBe(digest);
  });

  it("101 (cancelada): nProt é o da autorização, nunca o do evento de cancelamento", async () => {
    const prot = PROT({ chave, cStat: 100, xMotivo: "Autorizado o uso da NF-e", nProt: "135260000000100" });
    const evento =
      `<procEventoNFe versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${chave}01"><cStat>135</cStat><chNFe>${chave}</chNFe><nProt>135260000000999</nProt></infEvento></evento>` +
      `<retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo><nProt>135260000000999</nProt></infEvento></retEvento></procEventoNFe>`;
    const soap = new FakeSoapClient(ok(RET_CONS_SIT(`<cStat>101</cStat><xMotivo>Cancelamento de NF-e homologado</xMotivo><chNFe>${chave}</chNFe>${prot}${evento}`)));
    const c = await provider(soap).consultarDetalhado(chave);
    expect(c.cStat).toBe(101);
    expect(c.xMotivo).toBe("Cancelamento de NF-e homologado");
    expect(c.nProt).toBe("135260000000100");
  });

  it("chave de NFC-e (mod 65) consulta no autorizador NFC-e, igual a consultar()", async () => {
    const soap = new FakeSoapClient(ok(RET_CONS_SIT(`<cStat>217</cStat><xMotivo>x</xMotivo>`)));
    const p = provider(soap, { uf: "SC" });
    const prep65 = p.prepararEmissao({ ...input65(), respTec: null });
    await p.consultar(prep65.chaveAcesso, "");
    await p.consultarDetalhado(prep65.chaveAcesso);
    expect(soap.requests[1]).toEqual(soap.requests[0]);
    expect(soap.requests[1].endpointUrl).toContain("nfce-homologacao.svrs.rs.gov.br");
  });

  it("chave inválida ⇒ nada enviado, inconclusivo, não lança", async () => {
    const soap = new FakeSoapClient();
    const c = await provider(soap).consultarDetalhado("nfe-id-123");
    expect(soap.requests).toHaveLength(0);
    expect(c.cStat).toBeNull();
    expect(c.transporte).toBeNull();
    expect(c.httpStatus).toBeNull();
  });

  it("rede ⇒ REDE; timeout ⇒ TIMEOUT; HTTP 503 ⇒ httpStatus; nunca lança", async () => {
    const soap = new FakeSoapClient();
    soap.responder(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ETIMEDOUT" }),
      ok("<html>503</html>", 503),
    );
    const p = provider(soap);
    const r1 = await p.consultarDetalhado(chave);
    const r2 = await p.consultarDetalhado(chave);
    const r3 = await p.consultarDetalhado(chave);
    expect([r1.transporte, r1.httpStatus, r1.cStat]).toEqual(["REDE", null, null]);
    expect([r2.transporte, r2.httpStatus, r2.cStat]).toEqual(["TIMEOUT", null, null]);
    expect([r3.transporte, r3.httpStatus, r3.cStat]).toEqual([null, 503, null]);
  });
});

describe("consultarReciboDetalhado (mesmo SOAP de consultarRecibo)", () => {
  let chave: string;

  beforeAll(() => {
    chave = provider(new FakeSoapClient()).prepararEmissao(input55({ respTec: null })).chaveAcesso;
  });

  it("envelope, endpoint e action idênticos aos de consultarRecibo()", async () => {
    const soap = new FakeSoapClient(ok(RET_CONS_RECI(`<cStat>105</cStat><xMotivo>Lote em processamento</xMotivo>`)));
    const p = provider(soap);
    await p.consultarRecibo("351000000000001", chave);
    await p.consultarReciboDetalhado("351000000000001", chave);
    expect(soap.requests).toHaveLength(2);
    expect(soap.requests[1]).toEqual(soap.requests[0]);
    expect(soap.requests[1].soapAction).toMatch(/nfeRetAutorizacaoLote$/);
  });

  it("protNFe 100 desta chave ⇒ cStat/nProt/digVal da NF-e", async () => {
    const prot = PROT({ chave, cStat: 100, xMotivo: "Autorizado o uso da NF-e", nProt: "135260000000555", digVal: "DIG=" });
    const soap = new FakeSoapClient(ok(RET_CONS_RECI(`<cStat>104</cStat><xMotivo>Lote processado</xMotivo>${prot}`)));
    const c = await provider(soap).consultarReciboDetalhado("351000000000001", chave);
    expect(c.cStat).toBe(100);
    expect(c.nProt).toBe("135260000000555");
    expect(c.digVal).toBe("DIG=");
    expect(c.chNFe).toBe(chave);
    expect(c.protNFeXml).toBe(prot);
  });

  it("105 sem protNFe ⇒ cStat do lote", async () => {
    const soap = new FakeSoapClient(ok(RET_CONS_RECI(`<cStat>105</cStat><xMotivo>Lote em processamento</xMotivo>`)));
    const c = await provider(soap).consultarReciboDetalhado("351000000000001", chave);
    expect(c.cStat).toBe(105);
    expect(c.xMotivo).toBe("Lote em processamento");
    expect(c.protNFeXml).toBeNull();
  });

  it("nRec vazio ⇒ nada enviado; rede ⇒ REDE; nunca lança", async () => {
    const soap = new FakeSoapClient(new Error("ECONNRESET"));
    const p = provider(soap);
    const vazio = await p.consultarReciboDetalhado("  ", chave);
    expect(soap.requests).toHaveLength(0);
    expect(vazio.cStat).toBeNull();
    const rede = await p.consultarReciboDetalhado("351000000000001", chave);
    expect(rede.transporte).toBe("REDE");
  });
});

describe("montarNfeProc", () => {
  it("formato canônico idêntico ao builder de emitir()", () => {
    const nfe = "<NFe><infNFe/></NFe>";
    const prot = "<protNFe versao=\"4.00\"><infProt/></protNFe>";
    expect(SefazDirectProvider.montarNfeProc(nfe, prot)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
        nfe +
        prot +
        "</nfeProc>",
    );
  });
});
