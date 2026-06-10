import { describe, it, expect, beforeAll } from "vitest";
import { SefazDirectProvider } from "../../../app/fiscal/providers/sefaz-direct.provider";
import {
  SoapClientService,
  type SoapResponse,
} from "../../../app/fiscal/sefaz/soap-client.service";
import {
  parsePfx,
  type LoadedCertificate,
} from "../../../app/fiscal/certificate/certificate-loader.service";
import { generateTestCertificate } from "../__helpers__/test-certificate";

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

const CHAVE = "35260511222333000181550010000000011120100012";

const CCE_OK_135 = `
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
            <chNFe>${CHAVE}</chNFe>
            <tpEvento>110110</tpEvento>
            <nSeqEvento>1</nSeqEvento>
            <dhRegEvento>2026-05-14T16:00:00-03:00</dhRegEvento>
            <nProt>135260000000777</nProt>
          </infEvento>
        </retEvento>
      </retEnvEvento>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const CCE_DUPLICADO_573 = CCE_OK_135.replace(
  "<cStat>135</cStat>",
  "<cStat>573</cStat>",
).replace(
  "<xMotivo>Evento registrado e vinculado a NF-e</xMotivo>",
  "<xMotivo>Rejeicao: Duplicidade de evento</xMotivo>",
);

const CCE_REJEITADO_240 = `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
      <retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
        <tpAmb>2</tpAmb>
        <cStat>240</cStat>
        <xMotivo>Rejeicao: Justificativa de cancelamento nao informada</xMotivo>
      </retEnvEvento>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

describe("SefazDirectProvider.cartaCorrecao()", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("envia CCe com sucesso quando cStat=135 e retorna procEventoNFe", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CCE_OK_135,
      headers: {},
      durationMs: 60,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao na natureza da operacao para VENDA INTERNA",
      sequencia: 1,
    });

    expect(result.success).toBe(true);
    expect(result.cStat).toBe(135);
    expect(result.protocolo).toBe("135260000000777");
    expect(result.xmlEvento).toContain("<procEventoNFe");
    expect(result.xmlEvento).toContain("<evento");
    expect(result.xmlEvento).toContain("<retEvento");

    // Envelope correto
    expect(fakeSoap.lastRequest?.envelope).toContain("<envEvento");
    expect(fakeSoap.lastRequest?.envelope).toContain("<tpEvento>110110</tpEvento>");
    expect(fakeSoap.lastRequest?.envelope).toContain("<xCondUso>");
    expect(fakeSoap.lastRequest?.envelope).toContain("<Signature");
    expect(fakeSoap.lastRequest?.soapAction).toMatch(/nfeRecepcaoEvento$/);
  });

  it("trata cStat=573 como duplicidade idempotente", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CCE_DUPLICADO_573,
      headers: {},
      durationMs: 60,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao na natureza da operacao para VENDA INTERNA",
      sequencia: 1,
    });

    expect(result.success).toBe(true);
    expect(result.cStat).toBe(573);
  });

  it("rejeita resposta com cStat de schema (240)", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CCE_REJEITADO_240,
      headers: {},
      durationMs: 60,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    const result = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao na natureza da operacao para VENDA INTERNA",
      sequencia: 1,
    });

    expect(result.success).toBe(false);
    expect(result.cStat).toBe(240);
  });

  it("valida chaveAcesso localmente (sem chamar SEFAZ)", async () => {
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

    const result = await provider.cartaCorrecao!({
      chaveAcesso: "muito-curta",
      correcao: "Correcao na natureza da operacao para VENDA INTERNA",
      sequencia: 1,
    });

    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/chaveAcesso invalida/);
    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("valida sequencia 1..20 localmente", async () => {
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

    const tooHigh = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao valida com 15+ chars no minimo",
      sequencia: 21,
    });
    expect(tooHigh.success).toBe(false);
    expect(tooHigh.mensagem).toMatch(/Sequencia/);

    const tooLow = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao valida com 15+ chars no minimo",
      sequencia: 0,
    });
    expect(tooLow.success).toBe(false);
    expect(tooLow.mensagem).toMatch(/Sequencia/);

    expect(fakeSoap.lastRequest).toBeNull();
  });

  it("valida texto da CCe 15..1000 chars", async () => {
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

    const tooShort = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "curto",
      sequencia: 1,
    });
    expect(tooShort.success).toBe(false);
    expect(tooShort.mensagem).toMatch(/15\.\.1000/);

    const tooLong = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "x".repeat(1001),
      sequencia: 1,
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.mensagem).toMatch(/15\.\.1000/);

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

    const result = await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao na natureza da operacao para VENDA INTERNA",
      sequencia: 1,
    });
    expect(result.success).toBe(false);
    expect(result.mensagem).toMatch(/ECONNRESET|rede/);
    // xmlEvento deve estar preservado mesmo no erro de rede (assinado, util para reenvio)
    expect(result.xmlEvento).toContain("<evento");
    expect(result.xmlEvento).toContain("<Signature");
  });

  it("passa o nSeqEvento corretamente para o Id do infEvento", async () => {
    const fakeSoap = new FakeSoapClient({
      status: 200,
      body: CCE_OK_135,
      headers: {},
      durationMs: 60,
    });
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: fakeSoap,
    });

    await provider.cartaCorrecao!({
      chaveAcesso: CHAVE,
      correcao: "Correcao na natureza da operacao para VENDA INTERNA",
      sequencia: 7,
    });

    expect(fakeSoap.lastRequest?.envelope).toMatch(/Id="ID110110\d{44}07"/);
    expect(fakeSoap.lastRequest?.envelope).toContain("<nSeqEvento>7</nSeqEvento>");
  });
});
