import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SefazDirectProvider,
  type SefazEmitPayload,
} from "../../../app/fiscal/providers/sefaz-direct.provider";
import {
  SoapClientService,
  type SoapResponse,
} from "../../../app/fiscal/sefaz/soap-client.service";
import {
  parsePfx,
  type LoadedCertificate,
} from "../../../app/fiscal/certificate/certificate-loader.service";
import { NfeXmlBuilderSefazService } from "../../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { generateTestCertificate } from "../__helpers__/test-certificate";
import { makeConfig, makeDraft } from "../__helpers__/test-draft";

// GOLDEN F0 — resultados de SefazDirectProvider.emitir() em 1549bc4 para os
// caminhos de erro/transporte que a numeração V2 reclassifica (build, assinatura,
// QR, rede, HTTP, lote 103/104/225, duplicidade 539). Só o método EXISTENTE
// `emitir` é exercitado (F4 adiciona métodos novos sem tocar neste).
//
// Máscaras: a assinatura e o certificado mudam a cada chave RSA gerada — viram
// {{ASSINATURA}}/{{CERTIFICADO}}. Chave, cNF e dhEmi são FIXOS (entrada) e
// trocados por marcadores só pelo VALOR EXATO esperado: se o provider passar a
// gerar outra chave, o valor cru aparece no diff (drift detectado).

const DH = new Date("2026-05-14T15:00:00-03:00");
const DH_TEXTO = "2026-05-14T15:00:00-03:00";
const CNF = "87654321";

class FakeSoapClient extends SoapClientService {
  public requisicoes: Array<{ endpointUrl: string; soapAction?: string }> = [];
  constructor(private resposta: SoapResponse | Error) {
    super();
  }
  async send(req: Parameters<SoapClientService["send"]>[0]): Promise<SoapResponse> {
    this.requisicoes.push({ endpointUrl: req.endpointUrl, soapAction: req.soapAction });
    if (this.resposta instanceof Error) throw this.resposta;
    return this.resposta;
  }
}

const soap = (body: string, status = 200): SoapResponse => ({ status, body, headers: {}, durationMs: 1 });

const RET_ENVI = (conteudo: string) => `
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Body>
    <nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>2</tpAmb>
        <verAplic>SVRS202604</verAplic>
${conteudo}
      </retEnviNFe>
    </nfeResultMsg>
  </soap:Body>
</soap:Envelope>`;

const PROT = (chave: string, cStat: number, xMotivo: string, nProt?: string) => `
        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>
        <cUF>35</cUF>
        <dhRecbto>2026-05-14T15:00:30-03:00</dhRecbto>
        <protNFe versao="4.00">
          <infProt${nProt ? ` Id="ID${nProt}"` : ""}>
            <tpAmb>2</tpAmb>
            <verAplic>SVRS202604</verAplic>
            <chNFe>${chave}</chNFe>
            <dhRecbto>2026-05-14T15:00:31-03:00</dhRecbto>
            ${nProt ? `<nProt>${nProt}</nProt>` : ""}
            <digVal>abc==</digVal>
            <cStat>${cStat}</cStat>
            <xMotivo>${xMotivo}</xMotivo>
          </infProt>
        </protNFe>`;

function payload(over: Partial<SefazEmitPayload> = {}): SefazEmitPayload {
  return {
    draft: makeDraft(),
    config: makeConfig(),
    numero: 101,
    dhEmi: DH,
    cNF: CNF,
    ...over,
  };
}

function chaveEsperada(p: SefazEmitPayload): string {
  return new NfeXmlBuilderSefazService().build({
    draft: p.draft,
    config: p.config,
    numero: p.numero,
    dhEmi: p.dhEmi,
    cNF: p.cNF,
    tpEmis: p.tpEmis ?? 1,
  }).chaveAcesso;
}

function mascarar(texto: string, chave: string | null): string {
  let t = texto;
  if (chave) t = t.split(chave).join("{{CHAVE_ESPERADA}}");
  return t
    .split(`<cNF>${CNF}</cNF>`).join("<cNF>{{CNF_FIXO}}</cNF>")
    .split(DH_TEXTO).join("{{DHEMI_FIXO}}")
    .replace(/<SignatureValue>[^<]*<\/SignatureValue>/g, "<SignatureValue>{{ASSINATURA}}</SignatureValue>")
    .replace(/<X509Certificate>[^<]*<\/X509Certificate>/g, "<X509Certificate>{{CERTIFICADO}}</X509Certificate>")
    // Texto do erro vem do OpenSSL da versão do Node (muda entre runtimes);
    // o que é nosso — o prefixo e o formato do resultado — continua travado.
    .replace(/(Falha ao assinar XML: )[^"]*/g, "$1{{ERRO_DO_OPENSSL}}");
}

function serializar(v: unknown, chave: string | null): string {
  const json = JSON.stringify(
    v,
    (_k, valor) => (valor instanceof Date ? valor.toISOString() : valor),
    2,
  );
  return mascarar(json, chave);
}

describe("golden F0 — SefazDirectProvider.emitir (erros, transporte e lote)", () => {
  let cert: LoadedCertificate;

  beforeAll(() => {
    const tc = generateTestCertificate({ keyBits: 1024 });
    cert = parsePfx(tc.pfxBuffer, tc.password);
  });

  beforeEach(() => {
    // Kill-switch do RT (resolveRespTecFromEnv): determinístico independente do .env.
    vi.stubEnv("NFE_RESP_TEC_CNPJ", "");
    vi.stubEnv("NFE_RESP_TEC_ID_CSRT", "");
    vi.stubEnv("NFE_RESP_TEC_CSRT", "");
    vi.stubEnv("NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function rodar(
    nome: string,
    p: SefazEmitPayload,
    resposta: SoapResponse | Error | ((chave: string) => SoapResponse),
    opts: { certificado?: LoadedCertificate } = {},
  ): Promise<void> {
    let chave: string | null = null;
    try {
      chave = chaveEsperada(p);
    } catch {
      chave = null; // build inválido: não há chave esperada
    }
    const fake = new FakeSoapClient(typeof resposta === "function" ? resposta(chave ?? "") : resposta);
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: opts.certificado ?? cert,
      soapClient: fake,
    });
    const resultado = await provider.emitir({ nfeData: p as any, token: "", ref: "nfe-golden-1" });
    await expect(
      serializar({ resultado, envios: fake.requisicoes }, chave),
    ).toMatchFileSnapshot(`./__snapshots__/sefaz-emitir-${nome}.json`);
  }

  it("build falha: config sem codMunicipio (nada é enviado)", async () => {
    await rodar("build-sem-codmunicipio", payload({ config: makeConfig({ codMunicipio: null }) }), soap(""));
  });

  it("build falha: RT do env incompleto (sem xContato/email/fone)", async () => {
    vi.stubEnv("NFE_RESP_TEC_CNPJ", "11222333000181");
    vi.stubEnv("NFE_RESP_TEC_XCONTATO", "");
    vi.stubEnv("NFE_RESP_TEC_EMAIL", "");
    vi.stubEnv("NFE_RESP_TEC_FONE", "");
    await rodar("build-resptec-env-incompleto", payload(), soap(""));
  });

  it("assinatura falha: chave privada ilegível", async () => {
    const quebrado: LoadedCertificate = {
      ...cert,
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nNAOEUMACHAVE\n-----END PRIVATE KEY-----",
    };
    await rodar("assinatura-falha", payload(), soap(""), { certificado: quebrado });
  });

  it("NFC-e 65 com contingência SVC pedida (recusa local)", async () => {
    await rodar(
      "nfce-contingencia-svc",
      payload({ draft: makeDraft({ modelo: "65", pagamentosJson: [{ meio: "PIX", valor: 100 }] as any }), contingencia: "SVC_AN" }),
      soap(""),
    );
  });

  it("NFC-e 65 sem CSC: falha ao montar QR Code (depois de assinar)", async () => {
    await rodar(
      "nfce-qrcode-sem-csc",
      payload({ draft: makeDraft({ modelo: "65", pagamentosJson: [{ meio: "PIX", valor: 100 }] as any }) }),
      soap(""),
    );
  });

  it("rede: SOAP lança ECONNRESET", async () => {
    await rodar("rede-econnreset", payload(), new Error("socket hang up ECONNRESET"));
  });

  it("HTTP 500 da SEFAZ", async () => {
    await rodar("http-500", payload(), soap("<html>Internal Server Error</html>", 500));
  });

  it("lote 103 (assíncrono, nRec)", async () => {
    await rodar(
      "lote-103",
      payload(),
      soap(RET_ENVI(`        <cStat>103</cStat>
        <xMotivo>Lote recebido com sucesso</xMotivo>
        <infRec><nRec>351000000000123</nRec><tMed>1</tMed></infRec>`)),
    );
  });

  it("lote 104 com protNFe 100 (autorizada síncrona)", async () => {
    await rodar("lote-104-prot-100", payload(), (chave) =>
      soap(RET_ENVI(PROT(chave, 100, "Autorizado o uso da NF-e", "135260000000001"))),
    );
  });

  it("lote 104 com protNFe 100 e RT do env (infRespTec dentro do XML assinado)", async () => {
    vi.stubEnv("NFE_RESP_TEC_CNPJ", "11.222.333/0001-81");
    vi.stubEnv("NFE_RESP_TEC_XCONTATO", "Suporte Teste");
    vi.stubEnv("NFE_RESP_TEC_EMAIL", "suporte@resptec.test");
    vi.stubEnv("NFE_RESP_TEC_FONE", "1140000000");
    await rodar("lote-104-prot-100-resptec-env", payload(), (chave) =>
      soap(RET_ENVI(PROT(chave, 100, "Autorizado o uso da NF-e", "135260000000002"))),
    );
  });

  it("lote 104 sem protNFe legível", async () => {
    await rodar(
      "lote-104-sem-prot",
      payload(),
      soap(RET_ENVI(`        <cStat>104</cStat>
        <xMotivo>Lote processado</xMotivo>`)),
    );
  });

  it("rejeição 225 no lote (schema)", async () => {
    await rodar(
      "lote-225",
      payload(),
      soap(RET_ENVI(`        <cStat>225</cStat>
        <xMotivo>Rejeicao: Falha no Schema XML da NFe</xMotivo>`)),
    );
  });

  it("protNFe 225 (rejeição da nota dentro do lote 104)", async () => {
    await rodar("prot-225", payload(), (chave) =>
      soap(RET_ENVI(PROT(chave, 225, "Rejeicao: Falha no Schema XML da NFe"))),
    );
  });

  it("protNFe 539 (duplicidade com diferença na chave)", async () => {
    await rodar("prot-539", payload(), (chave) =>
      soap(
        RET_ENVI(
          PROT(
            chave,
            539,
            "Rejeicao: Duplicidade de NF-e, com diferenca na Chave de Acesso [chNFe: 35260511222333000181550010000001011000000019]",
          ),
        ),
      ),
    );
  });

  it("protNFe 974 (rejeição fora da faixa 200–599)", async () => {
    await rodar("prot-974", payload(), (chave) =>
      soap(RET_ENVI(PROT(chave, 974, "Rejeicao: CNPJ do responsavel tecnico nao autorizado"))),
    );
  });

  it("payload sem shape SefazEmitPayload lança (não devolve resultado)", async () => {
    const provider = new SefazDirectProvider({
      ambiente: "homologacao",
      uf: "SP",
      certificate: cert,
      soapClient: new FakeSoapClient(soap("")),
    });
    let mensagem = "(não lançou)";
    try {
      await provider.emitir({ nfeData: { config: makeConfig(), numero: 1 } as any, token: "", ref: "r" });
    } catch (e) {
      mensagem = (e as Error).message;
    }
    await expect(serializar({ lancou: mensagem }, null)).toMatchFileSnapshot(
      "./__snapshots__/sefaz-emitir-payload-invalido.json",
    );
  });
});
