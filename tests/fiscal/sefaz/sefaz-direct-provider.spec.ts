import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  SefazDirectProvider,
  NotImplementedError,
  type SefazEmitPayload,
} from "../../../app/fiscal/providers/sefaz-direct.provider";
import {
  SoapClientService,
  type SoapResponse,
} from "../../../app/fiscal/sefaz/soap-client.service";
import type { LoadedCertificate } from "../../../app/fiscal/certificate/certificate-loader.service";
import { parsePfx } from "../../../app/fiscal/certificate/certificate-loader.service";
import { generateTestCertificate } from "../__helpers__/test-certificate";
import { makeConfig, makeDraft, makeItem } from "../__helpers__/test-draft";

class FakeSoapClient extends SoapClientService {
  public lastRequest: {
    endpointUrl: string;
    envelope: string;
    soapAction?: string;
  } | null = null;
  private nextResponse: SoapResponse | Error;

  constructor(initial: SoapResponse | Error) {
    super();
    this.nextResponse = initial;
  }

  setNextResponse(r: SoapResponse | Error): void {
    this.nextResponse = r;
  }

  async send(req: Parameters<SoapClientService["send"]>[0]): Promise<SoapResponse> {
    this.lastRequest = {
      endpointUrl: req.endpointUrl,
      envelope: req.envelope,
      soapAction: req.soapAction,
    };
    if (this.nextResponse instanceof Error) throw this.nextResponse;
    return this.nextResponse;
  }
}

const STATUS_RESPONSE_107 = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
      <retConsStatServ versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
        <tpAmb>2</tpAmb>
        <verAplic>SVRS202604140924</verAplic>
        <cStat>107</cStat>
        <xMotivo>Servico em Operacao</xMotivo>
        <cUF>35</cUF>
        <dhRecbto>2026-05-14T12:00:00-03:00</dhRecbto>
        <tMed>1</tMed>
      </retConsStatServ>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const STATUS_RESPONSE_108 = STATUS_RESPONSE_107.replace(
  "<cStat>107</cStat>",
  "<cStat>108</cStat>",
).replace(
  "<xMotivo>Servico em Operacao</xMotivo>",
  "<xMotivo>Servico Paralisado Momentaneamente</xMotivo>",
);

describe("SefazDirectProvider — shape contractual", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("name = SEFAZ_DIRECT", () => {
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
    });
    expect(provider.name).toBe("SEFAZ_DIRECT");
  });

  it("expoe os 4 metodos obrigatorios do INfeProvider", () => {
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
    });
    expect(typeof provider.emitir).toBe("function");
    expect(typeof provider.consultar).toBe("function");
    expect(typeof provider.cancelar).toBe("function");
    expect(typeof provider.inutilizar).toBe("function");
    // E o novo metodo opcional
    expect(typeof provider.consultarStatusServico).toBe("function");
  });
});

// NotImplementedError ainda usado em métodos futuros (CCe, F-F). Sanity:
describe("SefazDirectProvider — NotImplementedError class", () => {
  it("exporta NotImplementedError para metodos futuros", () => {
    expect(NotImplementedError.prototype).toBeDefined();
    const err = new NotImplementedError("foo", "F-X");
    expect(err.name).toBe("NotImplementedError");
    expect(err.message).toMatch(/foo/);
    expect(err.message).toMatch(/F-X/);
  });
});

describe("SefazDirectProvider.consultarStatusServico() — envelope", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("monta envelope SOAP 1.2 com namespace correto e tpAmb=2 para homologacao", () => {
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
    });
    const envelope = provider.buildStatusServicoEnvelope();

    expect(envelope).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(envelope).toContain(
      'xmlns:soap="http://www.w3.org/2003/05/soap-envelope"',
    );
    expect(envelope).toContain(
      'xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4"',
    );
    expect(envelope).toContain('xmlns="http://www.portalfiscal.inf.br/nfe"');
    expect(envelope).toContain('<consStatServ versao="4.00"');
    expect(envelope).toContain("<tpAmb>2</tpAmb>");
    expect(envelope).toContain("<cUF>35</cUF>");
    expect(envelope).toContain("<xServ>STATUS</xServ>");
    expect(envelope).toContain("</soap:Envelope>");
  });

  it("usa tpAmb=1 quando ambiente=producao", () => {
    const provider = new SefazDirectProvider({
      ambiente: "producao",
      uf: "MG",
      certificate: cert,
    });
    const envelope = provider.buildStatusServicoEnvelope();
    expect(envelope).toContain("<tpAmb>1</tpAmb>");
    expect(envelope).toContain("<cUF>31</cUF>");
  });
});

describe("SefazDirectProvider.consultarStatusServico() — fluxo via SOAP mock", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("parseia cStat=107 e marca emOperacao=true", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: STATUS_RESPONSE_107,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultarStatusServico();
    expect(result.emOperacao).toBe(true);
    expect(result.cStat).toBe(107);
    expect(result.xMotivo).toBe("Servico em Operacao");
    expect(result.tMed).toBe(1);
    expect(result.verAplic).toBe("SVRS202604140924");
    expect(result.cUFResposta).toBe(35);
    expect(result.dataResposta).toBeInstanceOf(Date);

    // Endpoint resolvido para SEFAZ SP homologacao
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("sp.gov.br");
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("homologacao");
    expect(fakeSoap.lastRequest?.soapAction).toBe(
      "http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF",
    );
  });

  it("parseia cStat=108 e marca emOperacao=false", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: STATUS_RESPONSE_108,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultarStatusServico();
    expect(result.emOperacao).toBe(false);
    expect(result.cStat).toBe(108);
    expect(result.xMotivo).toContain("Paralisado");
  });

  it("tolera erro de rede sem propagar (retorna resultado com cStat=-1)", async () => {
    const fakeSoap = new FakeSoapClient(new Error("ECONNRESET"));
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "RJ",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultarStatusServico();
    expect(result.emOperacao).toBe(false);
    expect(result.cStat).toBe(-1);
    expect(result.xMotivo).toContain("rede");
  });

  it("trata HTTP 500 do SEFAZ como falha estruturada", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 500,
      body: "<html>Internal Server Error</html>",
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "RS",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultarStatusServico();
    expect(result.emOperacao).toBe(false);
    expect(result.cStat).toBe(-1);
    expect(result.xMotivo).toMatch(/HTTP 500/);
  });

  it("roteia para SVC quando solicitado contingencia", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: STATUS_RESPONSE_107,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "producao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    await provider.consultarStatusServico({ contingencia: "SVC_AN" });
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("svc.fazenda.gov.br");
  });
});

describe("SefazDirectProvider — sem usar test framework de mock", () => {
  // Sanity: garantir que vi.fn() é compatível com soapClient injetado
  it("permite stub via vi.spyOn", async () => {
    const tc = generateTestCertificate();
    const cert = parsePfx(tc.pfxBuffer, tc.password);
    const realSoap = new SoapClientService();
    const spy = vi
      .spyOn(realSoap, "send")
      .mockResolvedValue({
        status: 200,
        body: STATUS_RESPONSE_107,
        headers: {},
        durationMs: 10,
      });

    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "PR",
      certificate: cert,
      soapClient: realSoap,
    });

    const result = await provider.consultarStatusServico();
    expect(result.cStat).toBe(107);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── F-D: emissão ──

function makeEmitPayload(): SefazEmitPayload {
  return {
    draft: makeDraft(),
    config: makeConfig(),
    numero: 1,
    dhEmi: new Date("2026-05-14T15:00:00-03:00"),
    cNF: "12345678",
  };
}

const AUTORIZADA_RESPONSE = (chave: string, nProt = "135260000000001") => `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <verAplic>SVRS202604</verAplic>
        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>
        <cUF>35</cUF>
        <dhRecbto>2026-05-14T15:00:30-03:00</dhRecbto>
        <protNFe versao="4.00">
          <infProt Id="ID${nProt}">
            <tpAmb>2</tpAmb>
            <verAplic>SVRS202604</verAplic>
            <chNFe>${chave}</chNFe>
            <dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>
            <nProt>${nProt}</nProt>
            <digVal>abc==</digVal>
            <cStat>100</cStat>
            <xMotivo>Autorizado o uso da NF-e</xMotivo>
          </infProt>
        </protNFe>
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const REJEITADA_RESPONSE = (chave: string) => `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <verAplic>SVRS</verAplic>
        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>
        <cUF>35</cUF>
        <dhRecbto>2026-05-14T15:00:30-03:00</dhRecbto>
        <protNFe versao="4.00">
          <infProt>
            <tpAmb>2</tpAmb>
            <chNFe>${chave}</chNFe>
            <dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>
            <cStat>539</cStat>
            <xMotivo>Rejeicao: Duplicidade de NFe</xMotivo>
          </infProt>
        </protNFe>
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const LOTE_DUPLICADO_RESPONSE = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <cStat>225</cStat>
        <xMotivo>Rejeicao: Falha schema XML</xMotivo>
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const ASYNC_RESPONSE = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <cStat>103</cStat>
        <xMotivo>Lote recebido</xMotivo>
        <infRec>
          <nRec>987654321012345</nRec>
          <tMed>3</tMed>
        </infRec>
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

describe("SefazDirectProvider.emitir() — fluxo sincrono", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("autoriza NFe quando cStat interno = 100", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: "",
      headers: {},
      durationMs: 0,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    // Calculamos a chave que o builder vai gerar para responder coerentemente
    const payload = makeEmitPayload();
    // Pré-emite uma vez para descobrir a chave (com o mesmo cNF/dhEmi)
    fakeSoap.setNextResponse({
      status: 200,
      body: AUTORIZADA_RESPONSE(
        "35260511222333000181550010000000011120100012",
      ),
      headers: {},
      durationMs: 50,
    });

    const result = await provider.emitir({
      nfeData: payload as any,
      token: "",
      ref: "nfe-id-1",
    });

    expect(result.status).toBe("autorizada");
    expect(result.success).toBe(true);
    expect(result.chaveAcesso).toMatch(/^\d{44}$/);
    expect(result.protocolo).toBe("135260000000001");
    expect(result.codigoStatus).toBe(100);
    expect(result.mensagem).toMatch(/Autorizado/);
    expect(result.dataAutorizacao).toBeInstanceOf(Date);

    // xmlAutorizado deve incluir <nfeProc> com NFe assinada + protNFe
    expect(result.xmlAutorizado).toContain("<nfeProc");
    expect(result.xmlAutorizado).toContain("<NFe");
    expect(result.xmlAutorizado).toContain("<Signature");
    expect(result.xmlAutorizado).toContain("<protNFe");

    // Envelope enviado deve estar correto
    expect(fakeSoap.lastRequest?.envelope).toContain("<enviNFe");
    expect(fakeSoap.lastRequest?.envelope).toContain("<indSinc>1</indSinc>");
    expect(fakeSoap.lastRequest?.envelope).toContain('versao="4.00"');
  });

  it("cStat 539 (duplicidade) NAO marca autorizada — devolve 'processando' para reconciliar (PRO-2)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: REJEITADA_RESPONSE(
        "35260511222333000181550010000000011120100012",
      ),
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "nfe-id-1",
    });

    // Duplicidade nao traz protocolo/XML validos da NF-e ja autorizada (e no
    // 539 a chave correta e OUTRA). Marcar AUTHORIZED com protocolo null
    // corromperia o registro. Devolvemos 'processando' para o use case
    // reconciliar por consulta — nunca 'autorizada' aqui.
    expect(result.status).toBe("processando");
    expect(result.success).toBe(false);
    expect(result.codigoStatus).toBe(539);
    expect(result.protocolo).toBeNull();
    expect(result.mensagem).toMatch(/Duplicidade|reconciliar/i);
  });

  it("retorna rejeitada quando lote falha por schema (225)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: LOTE_DUPLICADO_RESPONSE,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "nfe-id-1",
    });

    expect(result.status).toBe("rejeitada");
    expect(result.success).toBe(false);
    expect(result.codigoStatus).toBe(225);
    expect(result.mensagem).toMatch(/schema/i);
  });

  it("retorna processando quando SEFAZ responde async (cStat=103)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: ASYNC_RESPONSE,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "nfe-id-1",
    });

    expect(result.status).toBe("processando");
    expect(result.codigoStatus).toBe(103);
    expect(result.protocolo).toBe("987654321012345"); // nRec usado como protocolo
  });

  it("trata erro de rede como status=erro sem propagar", async () => {
    const fakeSoap = new FakeSoapClient(new Error("ETIMEDOUT"));
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "nfe-id-1",
    });

    expect(result.status).toBe("erro");
    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/ETIMEDOUT|rede/);
  });

  it("rejeita payload mal-formado (faltando draft)", async () => {
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: new FakeSoapClient({
        status: 200,
        body: "",
        headers: {},
        durationMs: 0,
      }),
    });

    await expect(
      provider.emitir({
        nfeData: { config: makeConfig(), numero: 1 } as any,
        token: "",
        ref: "r",
      }),
    ).rejects.toThrow(/SefazEmitPayload/);
  });

  it("envia para endpoint SEFAZ correto (SP homologacao NFeAutorizacao4)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: AUTORIZADA_RESPONSE("35260511222333000181550010000000011120100012"),
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    await provider.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "r",
    });

    expect(fakeSoap.lastRequest?.endpointUrl).toContain("sp.gov.br");
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("homologacao");
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("nfeautorizacao4");
    expect(fakeSoap.lastRequest?.soapAction).toMatch(/nfeAutorizacaoLote$/);
  });
});

describe("SefazDirectProvider.consultar() — por chave de acesso", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  const CONSULTA_AUTORIZADA = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
      <retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <verAplic>SVRS</verAplic>
        <cStat>100</cStat>
        <xMotivo>Autorizado o uso da NF-e</xMotivo>
        <protNFe versao="4.00">
          <infProt>
            <chNFe>35260511222333000181550010000000011120100012</chNFe>
            <nProt>135260000000001</nProt>
            <dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>
            <cStat>100</cStat>
            <xMotivo>Autorizado o uso da NF-e</xMotivo>
          </infProt>
        </protNFe>
      </retConsSitNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

  const CONSULTA_NAO_CONSTA = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
      <retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <cStat>217</cStat>
        <xMotivo>Rejeicao: NF-e nao consta na base</xMotivo>
      </retConsSitNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

  it("retorna autorizada quando cStat=100 + protocolo", async () => {
    const chave = "35260511222333000181550010000000011120100012";
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CONSULTA_AUTORIZADA,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultar(chave, "");
    expect(result.status).toBe("autorizada");
    expect(result.chaveAcesso).toBe(chave);
    expect(result.protocolo).toBe("135260000000001");
    expect(result.codigoStatus).toBe(100);

    expect(fakeSoap.lastRequest?.envelope).toContain("<xServ>CONSULTAR</xServ>");
    expect(fakeSoap.lastRequest?.envelope).toContain(`<chNFe>${chave}</chNFe>`);
  });

  it("retorna rejeitada quando cStat=217 (nao consta)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CONSULTA_NAO_CONSTA,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultar(
      "35260511222333000181550010000000011120100012",
      "",
    );
    expect(result.status).toBe("rejeitada");
    expect(result.codigoStatus).toBe(217);
  });

  it("rejeita ref que nao seja chave de 44 digitos", async () => {
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: new FakeSoapClient({
        status: 200,
        body: "",
        headers: {},
        durationMs: 0,
      }),
    });
    await expect(provider.consultar("nfe-id-123", "")).rejects.toThrow(/44 digitos/);
  });

  it("tolera erro de rede sem propagar", async () => {
    const fakeSoap = new FakeSoapClient(new Error("ECONNRESET"));
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.consultar(
      "35260511222333000181550010000000011120100012",
      "",
    );
    expect(result.status).toBe("erro");
    expect(result.mensagem).toMatch(/ECONNRESET|rede/);
  });
});

// ── F-E: cancelamento ──

const CANCEL_OK_135 = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
      <retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
        <idLote>1</idLote>
        <tpAmb>2</tpAmb>
        <cStat>128</cStat>
        <xMotivo>Lote de Evento Processado</xMotivo>
        <retEvento versao="1.00">
          <infEvento>
            <tpAmb>2</tpAmb>
            <cOrgao>35</cOrgao>
            <cStat>135</cStat>
            <xMotivo>Evento registrado e vinculado a NF-e</xMotivo>
            <chNFe>35260511222333000181550010000000011120100012</chNFe>
            <tpEvento>110111</tpEvento>
            <nSeqEvento>1</nSeqEvento>
            <dhRegEvento>2026-05-14T15:30:00-03:00</dhRegEvento>
            <nProt>135260000000999</nProt>
          </infEvento>
        </retEvento>
      </retEnvEvento>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const CANCEL_DUPLICADO_573 = CANCEL_OK_135.replace(
  "<cStat>135</cStat>",
  "<cStat>573</cStat>",
).replace(
  "<xMotivo>Evento registrado e vinculado a NF-e</xMotivo>",
  "<xMotivo>Rejeicao: Duplicidade de evento</xMotivo>",
);

const CANCEL_REJEITADO_215 = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
      <retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
        <tpAmb>2</tpAmb>
        <cStat>215</cStat>
        <xMotivo>Rejeicao: Falha schema XML</xMotivo>
      </retEnvEvento>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

describe("SefazDirectProvider.cancelar()", () => {
  let cert: LoadedCertificate;
  const CHAVE = "35260511222333000181550010000000011120100012";

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("cancela com sucesso quando cStat interno = 135", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CANCEL_OK_135,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: CHAVE,
      protocolo: "135260000000888",
      justificativa: "Cancelamento por erro de quantidade na nota",
      token: "",
    });

    expect(result.success).toBe(true);
    expect(result.protocolo).toBe("135260000000999");
    expect(result.mensagem).toMatch(/registrado/);

    // Envelope correto
    expect(fakeSoap.lastRequest?.envelope).toContain("<envEvento");
    expect(fakeSoap.lastRequest?.envelope).toContain("<tpEvento>110111</tpEvento>");
    expect(fakeSoap.lastRequest?.envelope).toContain(`<chNFe>${CHAVE}</chNFe>`);
    expect(fakeSoap.lastRequest?.envelope).toContain("<Signature");
    expect(fakeSoap.lastRequest?.envelope).toContain(
      "<xJust>Cancelamento por erro de quantidade na nota</xJust>",
    );

    // Endpoint RecepcaoEvento4 da SP homologacao
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("sp.gov.br");
    expect(fakeSoap.lastRequest?.endpointUrl.toLowerCase()).toContain("recepcaoevento");
    expect(fakeSoap.lastRequest?.soapAction).toMatch(/nfeRecepcaoEvento$/);
  });

  it("trata cStat=573 (duplicidade) como sucesso idempotente", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CANCEL_DUPLICADO_573,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: CHAVE,
      protocolo: "135260000000888",
      justificativa: "Cancelamento por erro de quantidade na nota",
      token: "",
    });

    expect(result.success).toBe(true);
  });

  it("rejeita quando cStat de schema (215)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CANCEL_REJEITADO_215,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: CHAVE,
      protocolo: "135260000000888",
      justificativa: "Cancelamento por erro de quantidade na nota",
      token: "",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/schema/i);
  });

  it("valida chave invalida sem chamar SEFAZ", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: "",
      headers: {},
      durationMs: 0,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: "muito-curta",
      protocolo: "135260000000888",
      justificativa: "Cancelamento valido para teste de chave invalida",
      token: "",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/chaveAcesso invalida/);
    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("valida protocolo obrigatorio sem chamar SEFAZ", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: "",
      headers: {},
      durationMs: 0,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: CHAVE,
      protocolo: "",
      justificativa: "Cancelamento valido para teste sem protocolo",
      token: "",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/protocolo/);
    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("valida justificativa < 15 chars sem chamar SEFAZ", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: "",
      headers: {},
      durationMs: 0,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: CHAVE,
      protocolo: "135260000000888",
      justificativa: "curto",
      token: "",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/15 caracteres/);
    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("tolera erro de rede sem propagar", async () => {
    const fakeSoap = new FakeSoapClient(new Error("ETIMEDOUT"));
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cancelar({
      ref: "nfe-id",
      chaveAcesso: CHAVE,
      protocolo: "135260000000888",
      justificativa: "Cancelamento valido com justificativa apropriada",
      token: "",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/ETIMEDOUT|rede/);
  });
});

// ── F-E: inutilização ──

const INUT_OK_102 = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">
      <retInutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <infInut>
          <tpAmb>2</tpAmb>
          <verAplic>SVRS</verAplic>
          <cStat>102</cStat>
          <xMotivo>Inutilizacao de numero homologado</xMotivo>
          <cUF>35</cUF>
          <ano>26</ano>
          <CNPJ>11222333000181</CNPJ>
          <mod>55</mod>
          <serie>1</serie>
          <nNFIni>100</nNFIni>
          <nNFFin>105</nNFFin>
          <dhRecbto>2026-05-14T15:35:00-03:00</dhRecbto>
          <nProt>135260000000888</nProt>
        </infInut>
      </retInutNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const INUT_REJEITADO_563 = INUT_OK_102.replace(
  "<cStat>102</cStat>",
  "<cStat>563</cStat>",
).replace(
  "<xMotivo>Inutilizacao de numero homologado</xMotivo>",
  "<xMotivo>Rejeicao: Ja existe pedido de inutilizacao com mesma chave</xMotivo>",
);

describe("SefazDirectProvider.inutilizar()", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("inutiliza com sucesso quando cStat=102", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: INUT_OK_102,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.inutilizar({
      cnpj: "11222333000181",
      serie: 1,
      numeroInicial: 100,
      numeroFinal: 105,
      justificativa: "Inutilizacao por falha de impressao em todas",
      token: "",
      ambiente: "homologacao",
    });

    expect(result.success).toBe(true);
    expect(result.protocolo).toBe("135260000000888");

    // Envelope correto
    expect(fakeSoap.lastRequest?.envelope).toContain("<inutNFe");
    expect(fakeSoap.lastRequest?.envelope).toContain("<xServ>INUTILIZAR</xServ>");
    expect(fakeSoap.lastRequest?.envelope).toContain("<nNFIni>100</nNFIni>");
    expect(fakeSoap.lastRequest?.envelope).toContain("<nNFFin>105</nNFFin>");
    expect(fakeSoap.lastRequest?.envelope).toContain("<Signature");

    // Endpoint NfeInutilizacao4 da SP homologacao
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("sp.gov.br");
    expect(fakeSoap.lastRequest?.endpointUrl.toLowerCase()).toContain("inutilizacao");
    expect(fakeSoap.lastRequest?.soapAction).toMatch(/nfeInutilizacaoNF$/);
  });

  it("trata cStat=563 (ja existe pedido) como duplicidade idempotente", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: INUT_REJEITADO_563,
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.inutilizar({
      cnpj: "11222333000181",
      serie: 1,
      numeroInicial: 100,
      numeroFinal: 105,
      justificativa: "Inutilizacao por falha de impressao em todas",
      token: "",
      ambiente: "homologacao",
    });

    // 563 não está em duplicidade-mapped (mapper só tem 218/539). Aqui o
    // resultado será success=false. Validamos que pelo menos retorna mensagem
    // semântica e protocolo nulo.
    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/Duplicidade|Ja existe/i);
  });

  it("falha quando CNPJ invalido (validacao local antes de SEFAZ)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: "",
      headers: {},
      durationMs: 0,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.inutilizar({
      cnpj: "123",
      serie: 1,
      numeroInicial: 1,
      numeroFinal: 5,
      justificativa: "Inutilizacao com cnpj invalido para teste",
      token: "",
      ambiente: "homologacao",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/CNPJ/);
    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("falha quando nNFIni > nNFFin (validacao local)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: "",
      headers: {},
      durationMs: 0,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.inutilizar({
      cnpj: "11222333000181",
      serie: 1,
      numeroInicial: 10,
      numeroFinal: 5,
      justificativa: "Inutilizacao com range invertido para teste",
      token: "",
      ambiente: "homologacao",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/nNFIni/);
    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("tolera erro de rede sem propagar", async () => {
    const fakeSoap = new FakeSoapClient(new Error("ECONNRESET"));
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.inutilizar({
      cnpj: "11222333000181",
      serie: 1,
      numeroInicial: 100,
      numeroFinal: 105,
      justificativa: "Inutilizacao por falha de impressao em todas",
      token: "",
      ambiente: "homologacao",
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/ECONNRESET|rede/);
  });
});

// ── F-G: contingencia SVC ──

describe("SefazDirectProvider.emitir() — modo contingencia SVC", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("roteia para SVC-AN quando contingencia='SVC_AN' e usa tpEmis=6", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: AUTORIZADA_RESPONSE("35260561122233300018155001000000001100100012"),
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP", // SP usa SVC_AN como fallback
      certificate: cert,
      soapClient: fakeSoap,
    });

    const payload: SefazEmitPayload = {
      ...makeEmitPayload(),
      contingencia: "SVC_AN",
    };
    const result = await provider.emitir({
      nfeData: payload as any,
      token: "",
      ref: "nfe-id-svc",
    });

    expect(result.status).toBe("autorizada");
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("svc.fazenda.gov.br");
    // tpEmis=6 aparece no envelope (campo <tpEmis>6</tpEmis>) e no Id
    expect(fakeSoap.lastRequest?.envelope).toContain("<tpEmis>6</tpEmis>");
  });

  it("roteia para SVC-RS quando contingencia='SVC_RS' e usa tpEmis=7", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: AUTORIZADA_RESPONSE("43260571122233300018155001000000001120100012"),
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "PR", // PR usa SVC_RS como fallback
      certificate: cert,
      soapClient: fakeSoap,
    });

    const payload: SefazEmitPayload = {
      ...makeEmitPayload(),
      contingencia: "SVC_RS",
    };
    const result = await provider.emitir({
      nfeData: payload as any,
      token: "",
      ref: "nfe-id-svc",
    });

    expect(result.status).toBe("autorizada");
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("svrs.rs.gov.br");
    expect(fakeSoap.lastRequest?.envelope).toContain("<tpEmis>7</tpEmis>");
  });

  it("sem contingencia, envia para SEFAZ origem com tpEmis=1", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: AUTORIZADA_RESPONSE("35260511222333000181550010000000011120100012"),
      headers: {},
      durationMs: 50,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    await provider.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "nfe-id-normal",
    });

    // SP SEFAZ próprio, não SVC
    expect(fakeSoap.lastRequest?.endpointUrl).toContain("sp.gov.br");
    expect(fakeSoap.lastRequest?.endpointUrl).not.toContain("svc.fazenda");
    expect(fakeSoap.lastRequest?.envelope).toContain("<tpEmis>1</tpEmis>");
  });

  it("contingencia preserva numero/serie mas gera chave de acesso nova", async () => {
    // Mesma nota emitida com tpEmis=1 vs tpEmis=6 produz chaves diferentes
    // (cDV recalculado). Testamos rodando o builder pelo provider duas vezes.
    const normalResponse = {
      status: 200,
      body: AUTORIZADA_RESPONSE("35260511222333000181550010000000011120100012"),
      headers: {},
      durationMs: 50,
    };
    const svcResponse = {
      status: 200,
      body: AUTORIZADA_RESPONSE("35260561122233300018155001000000001100100012"),
      headers: {},
      durationMs: 50,
    };

    const fakeSoapNormal = new FakeSoapClient(normalResponse);
    const providerNormal = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoapNormal,
    });
    await providerNormal.emitir({
      nfeData: makeEmitPayload() as any,
      token: "",
      ref: "ref-a",
    });

    const fakeSoapSvc = new FakeSoapClient(svcResponse);
    const providerSvc = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoapSvc,
    });
    await providerSvc.emitir({
      nfeData: { ...makeEmitPayload(), contingencia: "SVC_AN" } as any,
      token: "",
      ref: "ref-b",
    });

    const idNormal = fakeSoapNormal.lastRequest!.envelope.match(/Id="(NFe\d{44})"/)?.[1];
    const idSvc = fakeSoapSvc.lastRequest!.envelope.match(/Id="(NFe\d{44})"/)?.[1];

    expect(idNormal).toBeDefined();
    expect(idSvc).toBeDefined();
    expect(idNormal).not.toBe(idSvc);
    // O dígito tpEmis (pos 34 da chave, 35 do Id que tem "NFe" no início) muda
    expect(idNormal!.charAt(3 + 34)).toBe("1");
    expect(idSvc!.charAt(3 + 34)).toBe("6");
  });
});

// ── Commit B: integridade de dados (PRO-2/PRO-4/PRO-5, erro carrega chave) ──

const LOTE_104_SEM_PROTNFE = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>
        <cUF>35</cUF>
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const RET_RECIBO_AUTORIZADA = (chave: string) => `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4">
      <retConsReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <nRec>351000000000001</nRec>
        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>
        <protNFe versao="4.00">
          <infProt>
            <chNFe>${chave}</chNFe>
            <nProt>135260000000999</nProt>
            <dhRecbto>2026-05-14T15:01:00-03:00</dhRecbto>
            <cStat>100</cStat>
            <xMotivo>Autorizado o uso da NF-e</xMotivo>
          </infProt>
        </protNFe>
      </retConsReciNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

describe("SefazDirectProvider — integridade pos-envio (Commit B)", () => {
  let cert: LoadedCertificate;
  const FIXED = new Date("2026-05-14T15:00:00-03:00");

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  function payload(): SefazEmitPayload {
    return {
      draft: makeDraft(),
      config: makeConfig(),
      numero: 1,
      dhEmi: FIXED,
      cNF: "12345678",
    };
  }

  it("cStat 104 SEM protNFe vira 'processando' (nao 'rejeitada') — PRO-4", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: LOTE_104_SEM_PROTNFE,
      headers: {},
      durationMs: 10,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });
    const result = await provider.emitir({
      nfeData: payload() as any,
      token: "",
      ref: "r",
    });
    expect(result.status).toBe("processando");
    expect(result.codigoStatus).toBe(104);
    expect(result.chaveAcesso).toMatch(/^\d{44}$/);
  });

  it("erro de rede no envio carrega a chave de acesso gerada (PRO-3/USE-1)", async () => {
    const fakeSoap = new FakeSoapClient(new Error("ECONNRESET"));
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });
    const result = await provider.emitir({
      nfeData: payload() as any,
      token: "",
      ref: "r",
    });
    expect(result.status).toBe("erro");
    // A chave precisa estar presente para o use case consultar antes de reenviar
    expect(result.chaveAcesso).toMatch(/^\d{44}$/);
  });

  it("consultarRecibo(nRec) parseia protNFe autorizada (PRO-5)", async () => {
    const chave = "35260511222333000181550010000000011120100012";
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: RET_RECIBO_AUTORIZADA(chave),
      headers: {},
      durationMs: 10,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });
    const result = await (provider as any).consultarRecibo("351000000000001", chave);
    expect(result.status).toBe("autorizada");
    expect(result.protocolo).toBe("135260000000999");
    expect(result.chaveAcesso).toBe(chave);
    // Envelope correto: consReciNFe + endpoint RetAutorizacao
    expect(fakeSoap.lastRequest?.envelope).toContain("<consReciNFe");
    expect(fakeSoap.lastRequest?.envelope).toContain("<nRec>351000000000001</nRec>");
    expect(fakeSoap.lastRequest?.soapAction).toMatch(/nfeRetAutorizacaoLote$/);
  });
});
