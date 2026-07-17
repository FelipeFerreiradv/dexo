import { describe, it, expect, beforeAll } from "vitest";

import {
  SefazDirectProvider,
  type SefazEmitPayload,
} from "../../../app/fiscal/providers/sefaz-direct.provider";
import {
  SoapClientService,
  type SoapResponse,
} from "../../../app/fiscal/sefaz/soap-client.service";
import type { LoadedCertificate } from "../../../app/fiscal/certificate/certificate-loader.service";
import { parsePfx } from "../../../app/fiscal/certificate/certificate-loader.service";
import { generateTestCertificate } from "../__helpers__/test-certificate";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";

// NFC-e no provider SEFAZ direto: endpoint do autorizador 65, infNFeSupl
// injetado APÓS a assinatura, e guard de contingência (65 não tem SVC).

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

  async send(
    req: Parameters<SoapClientService["send"]>[0],
  ): Promise<SoapResponse> {
    this.lastRequest = {
      endpointUrl: req.endpointUrl,
      envelope: req.envelope,
      soapAction: req.soapAction,
    };
    if (this.nextResponse instanceof Error) throw this.nextResponse;
    return this.nextResponse;
  }
}

// retEnviNFe síncrono autorizado (cStat lote 104 + protNFe 100).
const RET_ENVI_AUTORIZADA = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
        <tpAmb>2</tpAmb>
        <verAplic>SVRS1.0</verAplic>
        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>
        <cUF>42</cUF>
        <protNFe versao="4.00">
          <infProt>
            <tpAmb>2</tpAmb>
            <verAplic>SVRS1.0</verAplic>
            <chNFe>00000000000000000000000000000000000000000000</chNFe>
            <dhRecbto>2026-07-17T12:00:00-03:00</dhRecbto>
            <nProt>342260000000001</nProt>
            <digVal>x</digVal>
            <cStat>100</cStat>
            <xMotivo>Autorizado o uso da NF-e</xMotivo>
          </infProt>
        </protNFe>
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

function payload65(cert: LoadedCertificate) {
  const draft = makeDraft({
    modelo: "65",
    indPresenca: "PRESENCIAL",
    pagamentosJson: [{ meio: "PIX", valor: 100 }] as any,
  });
  const config = makeConfig({
    uf: "SC",
    codMunicipio: "4205407",
    municipio: "FLORIANOPOLIS",
    cscId: "000001",
    cscToken: "CSC-DE-TESTE",
  });
  const payload: SefazEmitPayload = { draft, config, numero: 123 };
  return payload;
}

describe("SefazDirectProvider — NFC-e (modelo 65)", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate();
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  it("emitir 65: endpoint do autorizador NFC-e + infNFeSupl (CDATA) no envelope", async () => {
    const soap = new FakeSoapClient({
      status: 200,
      body: RET_ENVI_AUTORIZADA,
      headers: {},
    } as any);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SC",
      certificate: cert,
      soapClient: soap,
    });

    await provider.emitir({
      nfeData: payload65(cert) as any,
      token: "",
      ref: "nfe-65-test",
    });

    expect(soap.lastRequest).not.toBeNull();
    expect(soap.lastRequest!.endpointUrl).toContain(
      "nfce-homologacao.svrs.rs.gov.br",
    );
    const env = soap.lastRequest!.envelope;
    expect(env).toContain("<infNFeSupl>");
    expect(env).toContain("<qrCode><![CDATA[");
    expect(env).toContain("hom.sat.sef.sc.gov.br");
    expect(env).toContain("<urlChave>");
    // infNFeSupl injetado DEPOIS do infNFe assinado e ANTES da Signature.
    const idxSupl = env.indexOf("<infNFeSupl>");
    const idxSig = env.indexOf("<Signature");
    expect(idxSupl).toBeGreaterThan(-1);
    expect(idxSig).toBeGreaterThan(idxSupl);
  });

  it("emitir 65 + contingencia SVC → erro claro (NFC-e nao tem SVC)", async () => {
    const soap = new FakeSoapClient({ status: 200, body: "", headers: {} } as any);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SC",
      certificate: cert,
      soapClient: soap,
    });

    const res = await provider.emitir({
      nfeData: { ...payload65(cert), contingencia: "SVC_AN" } as any,
      token: "",
      ref: "nfe-65-svc",
    });
    expect(res.status).toBe("erro");
    expect(res.mensagem).toMatch(/nao suporta contingencia SVC/);
    // Nada foi enviado à SEFAZ.
    expect(soap.lastRequest).toBeNull();
  });

  it("emitir 65 SEM CSC → erro de montagem do QR, sem envio", async () => {
    const soap = new FakeSoapClient({ status: 200, body: "", headers: {} } as any);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SC",
      certificate: cert,
      soapClient: soap,
    });

    const p = payload65(cert);
    (p.config as any).cscToken = null;
    const res = await provider.emitir({
      nfeData: p as any,
      token: "",
      ref: "nfe-65-sem-csc",
    });
    expect(res.status).toBe("erro");
    expect(res.mensagem).toMatch(/QR Code/);
    expect(soap.lastRequest).toBeNull();
  });

  it("REGRESSAO: emitir 55 segue no endpoint NF-e (sem infNFeSupl)", async () => {
    const soap = new FakeSoapClient({
      status: 200,
      body: RET_ENVI_AUTORIZADA,
      headers: {},
    } as any);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SC",
      certificate: cert,
      soapClient: soap,
    });

    await provider.emitir({
      nfeData: {
        draft: makeDraft(),
        config: makeConfig({ uf: "SC", codMunicipio: "4205407" }),
        numero: 124,
      } as any,
      token: "",
      ref: "nfe-55-test",
    });

    expect(soap.lastRequest!.endpointUrl).toContain(
      "nfe-homologacao.svrs.rs.gov.br",
    );
    expect(soap.lastRequest!.endpointUrl).not.toContain("nfce");
    expect(soap.lastRequest!.envelope).not.toContain("<infNFeSupl>");
  });

  it("consultar deriva o modelo da chave: 65 → autorizador NFC-e; 55 → NF-e", async () => {
    const soap = new FakeSoapClient({ status: 200, body: "<x/>", headers: {} } as any);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SC",
      certificate: cert,
      soapClient: soap,
    });

    const chave65 =
      "42260711222333000181650010000001231100000079".slice(0, 44);
    await provider.consultar(chave65, "").catch(() => null);
    expect(soap.lastRequest!.endpointUrl).toContain("nfce-homologacao");

    const chave55 = chave65.slice(0, 20) + "55" + chave65.slice(22);
    await provider.consultar(chave55, "").catch(() => null);
    expect(soap.lastRequest!.endpointUrl).not.toContain("nfce");
  });
});
