/**
 * Provider de NFe que fala diretamente com SEFAZ via SOAP 1.2 + mTLS.
 *
 * Escopo da Fase F-C: somente `consultarStatusServico()` é funcional. Os
 * demais métodos do contrato `INfeProvider` lançam `NotImplementedError`
 * com mensagem clara apontando para a fase onde serão implementados.
 *
 * Construção: depende de um `LoadedCertificate` (já carregado via
 * `CertificateLoaderService`) e de uma UF. Não busca o PFX do disco
 * sozinho — quem invoca é responsável (factory ou use case).
 */

import type {
  INfeProvider,
  NfeProviderEmitInput,
  NfeProviderEmitResult,
  NfeProviderConsultaResult,
  NfeProviderCancelInput,
  NfeProviderCancelResult,
  NfeProviderInutilizacaoInput,
  NfeProviderInutilizacaoResult,
  NfeProviderStatusServicoInput,
  NfeProviderStatusServicoResult,
  NfeProviderCartaCorrecaoInput,
  NfeProviderCartaCorrecaoResult,
} from "./nfe-provider.interface";
import type { LoadedCertificate } from "../certificate/certificate-loader.service";
import {
  SoapClientService,
  type SoapResponse,
} from "../sefaz/soap-client.service";
import {
  getSefazEndpoint,
  getSvcEndpoint,
  getNfceEndpoint,
  COD_UF,
  type SefazAmbiente,
  type UF,
} from "../sefaz/endpoints";
import {
  montarQrCodeNfce,
  buildInfNFeSuplXml,
  injectInfNFeSupl,
} from "../nfce/qr-code";
import { getTpEmisForSvc } from "../sefaz/contingencia.service";
import {
  extractIntValue,
  extractTagValueNs,
  extractDateValue,
} from "../sefaz/xml-extract";
import { isServicoOperacional, lookupCStat } from "../sefaz/cstat-mapper";
import { XmlSignerService } from "../sefaz/xml-signer.service";
import {
  NfeXmlBuilderSefazService,
  type NfeXmlSefazBuildOptions,
} from "../sefaz/nfe-xml-builder-sefaz.service";
import { resolveRespTecFromEnv } from "../sefaz/resp-tec";
import {
  EventoXmlBuilderService,
  type EventoBuildOptions,
} from "../sefaz/evento-xml-builder.service";
import {
  InutilizacaoXmlBuilderService,
  type InutilizacaoBuildOptions,
} from "../sefaz/inutilizacao-xml-builder.service";
import {
  buildEnviNFeEnvelope,
  buildConsSitNFeEnvelope,
  buildConsReciNFeEnvelope,
  buildEnvEventoEnvelope,
  buildInutNFeEnvelope,
  SOAP_ACTIONS,
} from "../sefaz/envelopes";

export class NotImplementedError extends Error {
  constructor(method: string, phase: string) {
    super(
      `SefazDirectProvider.${method}() ainda nao implementado — entra na fase ${phase}.`,
    );
    this.name = "NotImplementedError";
  }
}

export interface SefazDirectProviderOptions {
  ambiente: SefazAmbiente;
  uf: UF;
  certificate: LoadedCertificate;
  soapClient?: SoapClientService;
  signer?: XmlSignerService;
  builder?: NfeXmlBuilderSefazService;
  eventoBuilder?: EventoXmlBuilderService;
  inutilizacaoBuilder?: InutilizacaoXmlBuilderService;
  /** Override de timeout/retry (passa para SoapClientService). */
  timeoutMs?: number;
  retryMax?: number;
}

/**
 * Payload esperado em `NfeProviderEmitInput.nfeData` quando o provider é
 * SEFAZ_DIRECT. Use cases que chamam SefazDirectProvider.emitir() devem
 * passar este shape em vez do JSON Focus.
 */
export interface SefazEmitPayload {
  draft: NfeXmlSefazBuildOptions["draft"];
  config: NfeXmlSefazBuildOptions["config"];
  numero: number;
  /** ID de lote (default: derivado de Date.now()). */
  idLote?: string;
  /** Override dhEmi/cNF/tpEmis (testes determinísticos). */
  dhEmi?: Date;
  cNF?: string;
  tpEmis?: 1 | 6 | 7;
  /**
   * Modo de contingência. Quando definido, o XML é montado com tpEmis
   * correspondente (6=SVC-AN, 7=SVC-RS) e enviado ao endpoint SVC em vez
   * do SEFAZ da UF. Use case detecta SEFAZ-down via ContingenciaService
   * e chama emitir novamente com este modo populado.
   */
  contingencia?: "SVC_AN" | "SVC_RS";
}

const NFE_NS = "http://www.portalfiscal.inf.br/nfe";
const STATUS_SERVICO_WSDL =
  "http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4";

export class SefazDirectProvider implements INfeProvider {
  readonly name = "SEFAZ_DIRECT";

  private readonly ambiente: SefazAmbiente;
  private readonly uf: UF;
  private readonly certificate: LoadedCertificate;
  private readonly soapClient: SoapClientService;
  private readonly signer: XmlSignerService;
  private readonly builder: NfeXmlBuilderSefazService;
  private readonly eventoBuilder: EventoXmlBuilderService;
  private readonly inutilizacaoBuilder: InutilizacaoXmlBuilderService;
  private readonly timeoutMs: number | undefined;
  private readonly retryMax: number | undefined;

  constructor(opts: SefazDirectProviderOptions) {
    this.ambiente = opts.ambiente;
    this.uf = opts.uf;
    this.certificate = opts.certificate;
    this.soapClient = opts.soapClient ?? new SoapClientService();
    this.signer = opts.signer ?? new XmlSignerService();
    this.builder = opts.builder ?? new NfeXmlBuilderSefazService();
    this.eventoBuilder = opts.eventoBuilder ?? new EventoXmlBuilderService();
    this.inutilizacaoBuilder =
      opts.inutilizacaoBuilder ?? new InutilizacaoXmlBuilderService();
    this.timeoutMs = opts.timeoutMs;
    this.retryMax = opts.retryMax;
  }

  // ── EMISSÃO ──

  async emitir(input: NfeProviderEmitInput): Promise<NfeProviderEmitResult> {
    const payload = input.nfeData as unknown as SefazEmitPayload;
    if (!payload?.draft || !payload?.config || !payload?.numero) {
      throw new Error(
        "SefazDirectProvider.emitir: nfeData precisa ter shape SefazEmitPayload " +
          "({ draft, config, numero }). O use case deve detectar providerName=SEFAZ_DIRECT " +
          "e enviar este shape em vez do JSON Focus.",
      );
    }

    // NFC-e (Fase 2): modelo vem do draft; ausente ⇒ "55" (fluxo atual intacto).
    const modelo: "55" | "65" =
      (payload.draft as any)?.modelo === "65" ? "65" : "55";
    // NFC-e NAO tem SVC — contingencia dela e offline (tpEmis=9, fora de
    // escopo). Guard defensivo: o use case ja pula o fallback SVC para 65.
    if (modelo === "65" && payload.contingencia) {
      return makeEmitErrorResult(
        "erro",
        "NFC-e (modelo 65) nao suporta contingencia SVC — emissao deve ser online",
        input.ref,
      );
    }

    // 1. Build XML modelo 55 v4.00
    // Se contingencia foi solicitada, força tpEmis correspondente (6 ou 7).
    // Caso contrário, respeita payload.tpEmis (default 1 dentro do builder).
    const effectiveTpEmis: 1 | 6 | 7 = payload.contingencia
      ? getTpEmisForSvc(payload.contingencia)
      : (payload.tpEmis ?? 1);

    let built;
    try {
      built = this.builder.build({
        draft: payload.draft,
        config: payload.config,
        numero: payload.numero,
        dhEmi: payload.dhEmi,
        cNF: payload.cNF,
        tpEmis: effectiveTpEmis,
        // Responsável Técnico (NT 2018.005): resolvido do env aqui (I/O), fora do
        // builder puro. undefined => grupo <infRespTec> omitido (kill-switch).
        respTec: resolveRespTecFromEnv(),
      });
    } catch (error) {
      return makeEmitErrorResult(
        "erro",
        `Falha ao montar XML NFe: ${(error as Error).message}`,
        input.ref,
      );
    }

    // 2. Sign
    let signedXml: string;
    try {
      signedXml = this.signer.sign({
        xml: built.xml,
        privateKeyPem: this.certificate.privateKeyPem,
        certificatePem: this.certificate.certificatePem,
        referenceElement: "infNFe",
      });
    } catch (error) {
      return makeEmitErrorResult(
        "erro",
        `Falha ao assinar XML: ${(error as Error).message}`,
        input.ref,
        built.chaveAcesso,
      );
    }

    // 2b. NFC-e: injeta <infNFeSupl> (QR Code + urlChave) DEPOIS da assinatura
    // (a assinatura cobre apenas o infNFe — posicao valida pelo schema). O
    // nfeProc arquivado carrega o QR, entao o cupom re-renderiza sem recalculo.
    if (modelo === "65") {
      try {
        const cfg = payload.config as any;
        const qr = montarQrCodeNfce({
          chaveAcesso: built.chaveAcesso,
          tpAmb: this.ambiente === "producao" ? "1" : "2",
          cscId: cfg.cscId ?? "",
          cscToken: cfg.cscToken ?? "",
          uf: this.uf,
          ambiente: this.ambiente,
        });
        signedXml = injectInfNFeSupl(
          signedXml,
          buildInfNFeSuplXml(qr.qrCode, qr.urlChave),
        );
      } catch (error) {
        return makeEmitErrorResult(
          "erro",
          `Falha ao montar QR Code da NFC-e: ${(error as Error).message}`,
          input.ref,
          built.chaveAcesso,
        );
      }
    }

    // 3. Wrap in SOAP envelope
    const tpAmb: "1" | "2" = this.ambiente === "producao" ? "1" : "2";
    const idLote = payload.idLote ?? defaultIdLote();
    const envelope = buildEnviNFeEnvelope({
      signedNfeXml: signedXml,
      tpAmb,
      idLote,
      indSinc: "1", // síncrono — recomendado NT 2018.005
    });

    // 4. Send — em contingencia, roteia para SVC; NFC-e vai ao autorizador
    // proprio do modelo 65; senão SEFAZ origem (55, caminho atual intacto)
    const endpoint = payload.contingencia
      ? getSvcEndpoint(this.uf, this.ambiente, "NFeAutorizacao4")
      : modelo === "65"
        ? getNfceEndpoint(this.uf, this.ambiente, "NFeAutorizacao4")
        : getSefazEndpoint(this.uf, this.ambiente, "NFeAutorizacao4");
    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: SOAP_ACTIONS.NFeAutorizacao4,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      // Erro de rede APOS o envio: a SEFAZ pode ou nao ter processado o lote.
      // Carregamos a chave gerada para o use case poder consultar e reconciliar
      // antes de qualquer reenvio (evita dupla emissao — ver PRO-3/USE-1).
      return makeEmitErrorResult(
        "erro",
        `Erro de rede ao enviar NFe: ${(error as Error).message}`,
        input.ref,
        built.chaveAcesso,
      );
    }

    if (response.status >= 400) {
      return makeEmitErrorResult(
        "erro",
        `HTTP ${response.status} ao enviar NFe`,
        input.ref,
        built.chaveAcesso,
      );
    }

    // 5. Parse retEnviNFe (síncrono) ou retorno de lote (com nRec)
    return parseRetEnviNFe(response.body, built.chaveAcesso, signedXml, input.ref);
  }

  async consultar(
    ref: string,
    _token: string,
  ): Promise<NfeProviderConsultaResult> {
    void _token;
    // Para SEFAZ direto: o ref é interpretado como chave de acesso (44 dígitos).
    const chave = (ref ?? "").replace(/\D/g, "");
    if (chave.length !== 44) {
      throw new Error(
        "SefazDirectProvider.consultar: ref deve ser a chave de acesso (44 digitos). " +
          "Use cases que armazenam nfeId devem traduzir para chave antes de chamar.",
      );
    }

    const tpAmb: "1" | "2" = this.ambiente === "producao" ? "1" : "2";
    const envelope = buildConsSitNFeEnvelope({ tpAmb, chNFe: chave });
    // Modelo derivado da propria chave (posicoes 20-21): 65 consulta no
    // autorizador NFC-e; 55 segue no endpoint atual (intacto).
    const endpoint =
      chave.slice(20, 22) === "65"
        ? getNfceEndpoint(this.uf, this.ambiente, "NfeConsultaProtocolo4")
        : getSefazEndpoint(this.uf, this.ambiente, "NfeConsultaProtocolo4");

    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: SOAP_ACTIONS.NfeConsultaProtocolo4,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      return {
        status: "erro",
        chaveAcesso: chave,
        protocolo: null,
        dataAutorizacao: null,
        codigoStatus: null,
        mensagem:
          error instanceof Error
            ? `Erro de rede: ${error.message}`
            : "Erro de rede ao consultar NFe",
        xmlAutorizado: null,
      };
    }

    if (response.status >= 400) {
      return {
        status: "erro",
        chaveAcesso: chave,
        protocolo: null,
        dataAutorizacao: null,
        codigoStatus: null,
        mensagem: `HTTP ${response.status} ao consultar NFe`,
        xmlAutorizado: null,
      };
    }

    return parseRetConsSitNFe(response.body, chave);
  }

  /**
   * Consulta o resultado de um lote ASSINCRONO pelo recibo (nRec), via
   * NFeRetAutorizacao4. Usado pelo use case quando emitir() devolve cStat=103
   * (lote recebido). NAO confundir com consultar(), que consulta por chave.
   *
   * @param nRec recibo retornado pela SEFAZ no envio do lote
   * @param chaveAcesso chave da NFe enviada (para preencher o resultado)
   */
  async consultarRecibo(
    nRec: string,
    chaveAcesso: string,
  ): Promise<NfeProviderConsultaResult> {
    const tpAmb: "1" | "2" = this.ambiente === "producao" ? "1" : "2";
    const envelope = buildConsReciNFeEnvelope({ tpAmb, nRec });
    // Recibo de lote NFC-e deve ser consultado no autorizador NFC-e (modelo
    // derivado da chave). 55 segue no endpoint atual (intacto).
    const endpoint =
      (chaveAcesso ?? "").replace(/\D/g, "").slice(20, 22) === "65"
        ? getNfceEndpoint(this.uf, this.ambiente, "NFeRetAutorizacao4")
        : getSefazEndpoint(this.uf, this.ambiente, "NFeRetAutorizacao4");

    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: SOAP_ACTIONS.NFeRetAutorizacao4,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      return {
        status: "erro",
        chaveAcesso,
        protocolo: nRec,
        dataAutorizacao: null,
        codigoStatus: null,
        mensagem:
          error instanceof Error
            ? `Erro de rede ao consultar recibo: ${error.message}`
            : "Erro de rede ao consultar recibo",
        xmlAutorizado: null,
      };
    }

    if (response.status >= 400) {
      return {
        status: "erro",
        chaveAcesso,
        protocolo: nRec,
        dataAutorizacao: null,
        codigoStatus: null,
        mensagem: `HTTP ${response.status} ao consultar recibo`,
        xmlAutorizado: null,
      };
    }

    // retConsReciNFe traz cStat do LOTE; o resultado por NFe vem em protNFe.
    return parseRetConsReciNFe(response.body, chaveAcesso);
  }

  // ── CANCELAMENTO (evento 110111) ──

  async cancelar(
    input: NfeProviderCancelInput,
  ): Promise<NfeProviderCancelResult> {
    const chave = (input.chaveAcesso ?? "").replace(/\D/g, "");
    if (chave.length !== 44) {
      return {
        success: false,
        protocolo: null,
        mensagem: "SefazDirectProvider.cancelar: chaveAcesso invalida (44 digitos)",
      };
    }
    if (!input.protocolo) {
      return {
        success: false,
        protocolo: null,
        mensagem: "SefazDirectProvider.cancelar: protocolo obrigatorio",
      };
    }
    if (!input.justificativa || input.justificativa.length < 15) {
      return {
        success: false,
        protocolo: null,
        mensagem:
          "SefazDirectProvider.cancelar: justificativa precisa de >= 15 caracteres",
      };
    }

    // CNPJ do emitente extraido da própria chave (posicoes 6..19)
    const cnpjFromChave = chave.slice(6, 20);

    let built;
    try {
      built = this.eventoBuilder.build({
        chNFe: chave,
        uf: this.uf,
        ambiente: this.ambiente,
        cnpj: cnpjFromChave,
        tpEvento: "110111",
        nSeqEvento: 1,
        detalhe: {
          kind: "cancelamento",
          nProt: input.protocolo,
          xJust: input.justificativa,
        },
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem: `Falha ao montar evento: ${(error as Error).message}`,
      };
    }

    let signedXml: string;
    try {
      signedXml = this.signer.sign({
        xml: built.xml,
        privateKeyPem: this.certificate.privateKeyPem,
        certificatePem: this.certificate.certificatePem,
        referenceElement: "infEvento",
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem: `Falha ao assinar evento: ${(error as Error).message}`,
      };
    }

    const envelope = buildEnvEventoEnvelope({
      signedEventoXml: signedXml,
      idLote: defaultIdLote(),
    });

    // Cancelamento de NFC-e vai ao RecepcaoEvento4 do autorizador NFC-e
    // (modelo derivado da chave). 55 segue no endpoint atual (intacto).
    const endpoint =
      chave.slice(20, 22) === "65"
        ? getNfceEndpoint(this.uf, this.ambiente, "RecepcaoEvento4")
        : getSefazEndpoint(this.uf, this.ambiente, "RecepcaoEvento4");
    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: SOAP_ACTIONS.RecepcaoEvento4,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem: `Erro de rede ao enviar cancelamento: ${(error as Error).message}`,
      };
    }

    if (response.status >= 400) {
      return {
        success: false,
        protocolo: null,
        mensagem: `HTTP ${response.status} ao enviar cancelamento`,
      };
    }

    return parseRetEnvEvento(response.body);
  }

  // ── INUTILIZAÇÃO (NfeInutilizacao4) ──

  async inutilizar(
    input: NfeProviderInutilizacaoInput,
  ): Promise<NfeProviderInutilizacaoResult> {
    const ano = new Date().getFullYear();
    let built;
    try {
      built = this.inutilizacaoBuilder.build({
        uf: this.uf,
        ambiente: this.ambiente,
        cnpj: input.cnpj,
        ano,
        // Inutilizacao de NFC-e (65) esta FORA de escopo da Fase 2 — este
        // fluxo segue exclusivo do modelo 55.
        modelo: "55",
        serie: input.serie,
        nNFIni: input.numeroInicial,
        nNFFin: input.numeroFinal,
        xJust: input.justificativa,
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem: `Falha ao montar inutilizacao: ${(error as Error).message}`,
      };
    }

    let signedXml: string;
    try {
      signedXml = this.signer.sign({
        xml: built.xml,
        privateKeyPem: this.certificate.privateKeyPem,
        certificatePem: this.certificate.certificatePem,
        referenceElement: "infInut",
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem: `Falha ao assinar inutilizacao: ${(error as Error).message}`,
      };
    }

    const envelope = buildInutNFeEnvelope({ signedInutNFeXml: signedXml });
    const endpoint = getSefazEndpoint(this.uf, this.ambiente, "NfeInutilizacao4");

    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: SOAP_ACTIONS.NfeInutilizacao4,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        mensagem: `Erro de rede ao inutilizar: ${(error as Error).message}`,
      };
    }

    if (response.status >= 400) {
      return {
        success: false,
        protocolo: null,
        mensagem: `HTTP ${response.status} ao inutilizar`,
      };
    }

    return parseRetInutNFe(response.body);
  }

  // ── CARTA DE CORREÇÃO (CCe, evento 110110) ──

  async cartaCorrecao(
    input: NfeProviderCartaCorrecaoInput,
  ): Promise<NfeProviderCartaCorrecaoResult> {
    const chave = (input.chaveAcesso ?? "").replace(/\D/g, "");
    if (chave.length !== 44) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: "chaveAcesso invalida (44 digitos)",
        xmlEvento: null,
      };
    }
    if (input.sequencia < 1 || input.sequencia > 20) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: `Sequencia de CCe fora do range 1..20 (recebido: ${input.sequencia})`,
        xmlEvento: null,
      };
    }
    if (!input.correcao || input.correcao.length < 15 || input.correcao.length > 1000) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: "Texto da CCe deve ter 15..1000 caracteres",
        xmlEvento: null,
      };
    }

    const cnpjFromChave = chave.slice(6, 20);

    let built;
    try {
      built = this.eventoBuilder.build({
        chNFe: chave,
        uf: this.uf,
        ambiente: this.ambiente,
        cnpj: cnpjFromChave,
        tpEvento: "110110",
        nSeqEvento: input.sequencia,
        detalhe: {
          kind: "cce",
          xCorrecao: input.correcao,
        },
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: `Falha ao montar CCe: ${(error as Error).message}`,
        xmlEvento: null,
      };
    }

    let signedXml: string;
    try {
      signedXml = this.signer.sign({
        xml: built.xml,
        privateKeyPem: this.certificate.privateKeyPem,
        certificatePem: this.certificate.certificatePem,
        referenceElement: "infEvento",
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: `Falha ao assinar CCe: ${(error as Error).message}`,
        xmlEvento: null,
      };
    }

    const envelope = buildEnvEventoEnvelope({
      signedEventoXml: signedXml,
      idLote: defaultIdLote(),
    });

    const endpoint = getSefazEndpoint(this.uf, this.ambiente, "RecepcaoEvento4");
    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: SOAP_ACTIONS.RecepcaoEvento4,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: `Erro de rede ao enviar CCe: ${(error as Error).message}`,
        xmlEvento: signedXml,
      };
    }

    if (response.status >= 400) {
      return {
        success: false,
        protocolo: null,
        cStat: null,
        mensagem: `HTTP ${response.status} ao enviar CCe`,
        xmlEvento: signedXml,
      };
    }

    return parseRetCce(response.body, signedXml);
  }

  // ── IMPLEMENTADO NESTA FASE ──

  async consultarStatusServico(
    input?: NfeProviderStatusServicoInput,
  ): Promise<NfeProviderStatusServicoResult> {
    const envelope = this.buildStatusServicoEnvelope();
    const endpoint = this.resolveEndpoint(
      "NfeStatusServico4",
      input?.contingencia,
    );

    let response: SoapResponse;
    try {
      response = await this.soapClient.send({
        endpointUrl: endpoint,
        envelope,
        soapAction: `${STATUS_SERVICO_WSDL}/nfeStatusServicoNF`,
        certificate: this.certificate,
        timeoutMs: this.timeoutMs,
        retryMax: this.retryMax,
      });
    } catch (error) {
      return {
        emOperacao: false,
        cStat: -1,
        xMotivo:
          error instanceof Error
            ? `Erro de rede: ${error.message}`
            : "Erro de rede ao consultar status do servico",
        dataResposta: null,
        tMed: null,
        verAplic: null,
        cUFResposta: null,
      };
    }

    if (response.status >= 400) {
      return {
        emOperacao: false,
        cStat: -1,
        xMotivo: `HTTP ${response.status} ao consultar status do servico`,
        dataResposta: null,
        tMed: null,
        verAplic: null,
        cUFResposta: null,
      };
    }

    return parseStatusServicoResponse(response.body);
  }

  // ── Helpers privados (visíveis a testes via build envelope público abaixo) ──

  buildStatusServicoEnvelope(): string {
    const tpAmb = this.ambiente === "producao" ? "1" : "2";
    const cUF = COD_UF[this.uf];
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"',
      ` xmlns:nfe="${STATUS_SERVICO_WSDL}">`,
      "<soap:Body>",
      "<nfe:nfeDadosMsg>",
      `<consStatServ versao="4.00" xmlns="${NFE_NS}">`,
      `<tpAmb>${tpAmb}</tpAmb>`,
      `<cUF>${cUF}</cUF>`,
      "<xServ>STATUS</xServ>",
      "</consStatServ>",
      "</nfe:nfeDadosMsg>",
      "</soap:Body>",
      "</soap:Envelope>",
    ].join("");
  }

  private resolveEndpoint(
    servico: "NfeStatusServico4",
    contingencia?: "SVC_AN" | "SVC_RS",
  ): string {
    if (contingencia) {
      // getSvcEndpoint usa SVC_FALLBACK; quando o usuário força contingencia
      // específica diferente do default, usamos a tabela contrária.
      // Por enquanto (F-G refina isso): respeitamos o default mas registramos
      // override se for o mesmo tipo do default. Forçar o "outro" tipo é um
      // refinamento da F-G.
      return getSvcEndpoint(this.uf, this.ambiente, servico);
    }
    return getSefazEndpoint(this.uf, this.ambiente, servico);
  }
}

function parseStatusServicoResponse(
  responseBody: string,
): NfeProviderStatusServicoResult {
  const cStat = extractIntValue(responseBody, "cStat");
  const xMotivo = extractTagValueNs(responseBody, "xMotivo") ?? "";
  const dataResposta = extractDateValue(responseBody, "dhRecbto");
  const tMed = extractIntValue(responseBody, "tMed");
  const verAplic = extractTagValueNs(responseBody, "verAplic");
  const cUFResposta = extractIntValue(responseBody, "cUF");

  return {
    emOperacao: isServicoOperacional(cStat),
    cStat: cStat ?? -1,
    xMotivo,
    dataResposta,
    tMed,
    verAplic,
    cUFResposta,
  };
}

// ── Parsing de retorno de emissão ──

/**
 * Parseia o retorno do NFeAutorizacao4. Cobre 3 cenários:
 *
 *  1. cStat=104 (lote processado) + protNFe inline → autorizada/rejeitada
 *     conforme cStat interno do protNFe (síncrono indSinc=1).
 *  2. cStat=103 (lote recebido) + infRec/nRec → processando (assíncrono).
 *  3. Outros cStats no lote → erro/rejeição direta sem protNFe.
 */
function parseRetEnviNFe(
  responseBody: string,
  chaveAcessoEnviada: string,
  signedNfeXml: string,
  ref: string,
): NfeProviderEmitResult {
  const loteCstat = extractIntValue(responseBody, "cStat");
  const loteXMotivo = extractTagValueNs(responseBody, "xMotivo") ?? "";

  // Caso 1: lote processado → procurar protNFe
  if (loteCstat === 104) {
    const protNfeBlock = extractTagBlock(responseBody, "protNFe");
    if (protNfeBlock) {
      const protCstat = extractIntValue(protNfeBlock, "cStat");
      const protXMotivo = extractTagValueNs(protNfeBlock, "xMotivo") ?? "";
      const nProt = extractTagValueNs(protNfeBlock, "nProt");
      const chNFe = extractTagValueNs(protNfeBlock, "chNFe") ?? chaveAcessoEnviada;
      const dhRecbto = extractDateValue(protNfeBlock, "dhRecbto");

      const lookup = lookupCStat(protCstat);
      // 100 = autorizada normal, 150 = autorizada fora de prazo
      if (lookup.categoria === "autorizada") {
        return {
          success: true,
          chaveAcesso: chNFe,
          protocolo: nProt,
          dataAutorizacao: dhRecbto,
          status: "autorizada",
          codigoStatus: protCstat,
          mensagem: protXMotivo,
          xmlAutorizado: buildNfeProc(signedNfeXml, protNfeBlock),
          providerRef: ref,
        };
      }

      // 110 = denegada → rejeição final.
      // DUPLICIDADE (204/218/539): NAO marcar autorizada aqui. A resposta de
      // rejeicao por duplicidade NAO traz nProt/dhRecbto/XML validos da NF-e ja
      // autorizada (e no 539 a chave correta e OUTRA). Marcar AUTHORIZED com
      // protocolo null corromperia o registro (DANFE/cancelamento/arquivamento
      // quebrariam). Devolvemos "processando" para o use case RECONCILIAR via
      // consulta por chave e obter chave/protocolo/XML reais — ou deixar pendente
      // se nao encontrar (caso 539). Ver PRO-2 da revisao.
      if (lookup.categoria === "duplicidade") {
        return {
          success: false,
          chaveAcesso: chNFe,
          protocolo: null,
          dataAutorizacao: null,
          status: "processando",
          codigoStatus: protCstat,
          mensagem: `Duplicidade (cStat ${protCstat}) — reconciliar por consulta: ${protXMotivo}`,
          xmlAutorizado: null,
          providerRef: ref,
        };
      }

      return {
        success: false,
        chaveAcesso: chNFe,
        protocolo: nProt,
        dataAutorizacao: null,
        status: "rejeitada",
        codigoStatus: protCstat,
        mensagem: protXMotivo || `Rejeicao cStat ${protCstat}`,
        xmlAutorizado: null,
        providerRef: ref,
      };
    }

    // 104 (lote processado) SEM protNFe extraivel: NAO e rejeicao. cStat 104 e
    // status do LOTE, nunca da NF-e. Pode ter autorizado mas o protNFe nao foi
    // extraido (namespace prefixado, XML truncado). Devolvemos "processando"
    // para o use case reconciliar por consulta. Ver PRO-4 da revisao.
    return {
      success: false,
      chaveAcesso: chaveAcessoEnviada,
      protocolo: null,
      dataAutorizacao: null,
      status: "processando",
      codigoStatus: 104,
      mensagem:
        loteXMotivo ||
        "Lote processado (104) sem protNFe legivel — reconciliar por consulta",
      xmlAutorizado: null,
      providerRef: ref,
    };
  }

  // Caso 2: lote recebido (assíncrono). Use case deve consultar via nRec
  // (consultarRecibo). codigoStatus=103 sinaliza o caminho de recibo.
  if (loteCstat === 103) {
    const nRec = extractTagValueNs(responseBody, "nRec");
    return {
      success: true,
      chaveAcesso: chaveAcessoEnviada,
      protocolo: nRec,
      dataAutorizacao: null,
      status: "processando",
      codigoStatus: 103,
      mensagem: loteXMotivo || "Lote recebido — consultar via nRec",
      xmlAutorizado: null,
      providerRef: ref,
    };
  }

  // Caso 3: duplicidade de LOTE (sem protNFe). Mesmo tratamento do PRO-2:
  // nao marcar autorizada; reconciliar por consulta.
  const lookup = lookupCStat(loteCstat);
  if (lookup.categoria === "duplicidade") {
    return {
      success: false,
      chaveAcesso: chaveAcessoEnviada,
      protocolo: null,
      dataAutorizacao: null,
      status: "processando",
      codigoStatus: loteCstat,
      mensagem: `Duplicidade (cStat ${loteCstat}) — reconciliar por consulta: ${loteXMotivo}`,
      xmlAutorizado: null,
      providerRef: ref,
    };
  }

  return {
    success: false,
    chaveAcesso: chaveAcessoEnviada,
    protocolo: null,
    dataAutorizacao: null,
    status: loteCstat === null ? "erro" : "rejeitada",
    codigoStatus: loteCstat,
    mensagem: loteXMotivo || "Retorno de lote sem cStat reconhecivel",
    xmlAutorizado: null,
    providerRef: ref,
  };
}

/**
 * Parseia retConsReciNFe (resposta de NFeRetAutorizacao4 ao consultar um lote
 * assincrono pelo nRec). O cStat do nivel raiz e do LOTE; o resultado da NF-e
 * esta no protNFe interno.
 */
function parseRetConsReciNFe(
  responseBody: string,
  chaveAcesso: string,
): NfeProviderConsultaResult {
  const protBlock = extractTagBlock(responseBody, "protNFe");
  if (protBlock) {
    const protCstat = extractIntValue(protBlock, "cStat");
    const protXMotivo = extractTagValueNs(protBlock, "xMotivo") ?? "";
    const nProt = extractTagValueNs(protBlock, "nProt");
    const chNFe = extractTagValueNs(protBlock, "chNFe") ?? chaveAcesso;
    const dhRecbto = extractDateValue(protBlock, "dhRecbto");
    const lookup = lookupCStat(protCstat);

    let status: NfeProviderConsultaResult["status"];
    if (lookup.categoria === "autorizada") status = "autorizada";
    else if (lookup.categoria === "denegada" || lookup.categoria === "rejeitada")
      status = "rejeitada";
    else status = "processando";

    return {
      status,
      chaveAcesso: chNFe,
      protocolo: nProt,
      dataAutorizacao: dhRecbto,
      codigoStatus: protCstat,
      mensagem: protXMotivo,
      xmlAutorizado: null,
    };
  }

  // Sem protNFe → ainda em processamento (cStat 105) ou erro de lote.
  const loteCstat = extractIntValue(responseBody, "cStat");
  const loteXMotivo = extractTagValueNs(responseBody, "xMotivo") ?? "";
  const lookup = lookupCStat(loteCstat);
  const status: NfeProviderConsultaResult["status"] =
    lookup.categoria === "lote_em_processamento" ||
    lookup.categoria === "lote_recebido"
      ? "processando"
      : loteCstat === null
        ? "erro"
        : "rejeitada";
  return {
    status,
    chaveAcesso,
    protocolo: null,
    dataAutorizacao: null,
    codigoStatus: loteCstat,
    mensagem: loteXMotivo || "Lote em processamento",
    xmlAutorizado: null,
  };
}

function parseRetConsSitNFe(
  responseBody: string,
  chaveAcesso: string,
): NfeProviderConsultaResult {
  const cStat = extractIntValue(responseBody, "cStat");
  const xMotivo = extractTagValueNs(responseBody, "xMotivo") ?? "";
  const lookup = lookupCStat(cStat);

  // protNFe pode estar presente quando autorizada/denegada (já registrada).
  const protBlock = extractTagBlock(responseBody, "protNFe");
  const nProt = protBlock
    ? extractTagValueNs(protBlock, "nProt")
    : extractTagValueNs(responseBody, "nProt");
  const dhAuthor = protBlock
    ? extractDateValue(protBlock, "dhRecbto")
    : extractDateValue(responseBody, "dhRecbto");

  let status: NfeProviderConsultaResult["status"];
  if (lookup.categoria === "autorizada") status = "autorizada";
  else if (lookup.categoria === "cancelada") status = "cancelada";
  else if (lookup.categoria === "rejeitada" || lookup.categoria === "denegada")
    status = "rejeitada";
  else if (
    lookup.categoria === "lote_em_processamento" ||
    lookup.categoria === "lote_recebido"
  )
    status = "processando";
  else if (lookup.categoria === "nao_consta") status = "rejeitada";
  else status = "erro";

  return {
    status,
    chaveAcesso,
    protocolo: nProt,
    dataAutorizacao: dhAuthor,
    codigoStatus: cStat,
    mensagem: xMotivo,
    xmlAutorizado: null, // protNFe sozinho não é a NFe completa
  };
}

function makeEmitErrorResult(
  status: NfeProviderEmitResult["status"],
  mensagem: string,
  ref: string,
  chaveAcesso: string | null = null,
): NfeProviderEmitResult {
  return {
    success: false,
    chaveAcesso,
    protocolo: null,
    dataAutorizacao: null,
    status,
    codigoStatus: null,
    mensagem,
    xmlAutorizado: null,
    providerRef: ref,
  };
}

function defaultIdLote(): string {
  // Até 15 dígitos. Timestamp em ms tem 13 dígitos, encaixa.
  return String(Date.now());
}

/**
 * Monta o XML autorizado final `<nfeProc>` combinando a NFe assinada e o
 * protNFe retornado pela SEFAZ. Este é o formato canônico de arquivamento.
 */
function buildNfeProc(signedNfeXml: string, protNfeBlock: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`,
    signedNfeXml,
    protNfeBlock,
    "</nfeProc>",
  ].join("");
}

/**
 * Extrai o bloco completo `<tag>...</tag>` incluindo as tags. Suporta atributos
 * na tag de abertura.
 */
function extractTagBlock(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
  );
  const match = xml.match(re);
  if (!match) return null;
  return match[0];
}

// ── Parsing de retorno de cancelamento / CCe ──

/**
 * Parseia o retorno de RecepcaoEvento4. Estrutura típica:
 *
 *   <retEnvEvento versao="1.00" xmlns="...">
 *     <idLote>...</idLote>
 *     <tpAmb>2</tpAmb>
 *     <verAplic>...</verAplic>
 *     <cOrgao>35</cOrgao>
 *     <cStat>128</cStat>  <!-- 128 = lote processado -->
 *     <xMotivo>Lote de Evento Processado</xMotivo>
 *     <retEvento versao="1.00">
 *       <infEvento>
 *         <tpAmb>2</tpAmb>
 *         <verAplic>...</verAplic>
 *         <cOrgao>35</cOrgao>
 *         <cStat>135</cStat>  <!-- 135 = evento registrado e vinculado -->
 *         <xMotivo>Evento registrado e vinculado a NF-e</xMotivo>
 *         <chNFe>...</chNFe>
 *         <tpEvento>110111</tpEvento>
 *         <nSeqEvento>1</nSeqEvento>
 *         <dhRegEvento>...</dhRegEvento>
 *         <nProt>135260000000999</nProt>
 *       </infEvento>
 *     </retEvento>
 *   </retEnvEvento>
 */
function parseRetEnvEvento(body: string): NfeProviderCancelResult {
  const retEvento = extractTagBlock(body, "retEvento");
  if (retEvento) {
    const infEvento = extractTagBlock(retEvento, "infEvento");
    if (infEvento) {
      const cStat = extractIntValue(infEvento, "cStat");
      const xMotivo = extractTagValueNs(infEvento, "xMotivo") ?? "";
      const nProt = extractTagValueNs(infEvento, "nProt");
      const lookup = lookupCStat(cStat);

      // 135 = registrado e vinculado, 136 = registrado mas não vinculado
      // (ambos sucesso). 573 = duplicidade (idempotente). Demais = falha.
      const isOk =
        lookup.categoria === "evento_registrado" ||
        cStat === 135 ||
        cStat === 136 ||
        lookup.categoria === "duplicidade";

      return {
        success: isOk,
        protocolo: nProt,
        mensagem: xMotivo || `cStat ${cStat}`,
      };
    }
  }

  // Sem retEvento — provavelmente erro do lote
  const cStat = extractIntValue(body, "cStat");
  const xMotivo = extractTagValueNs(body, "xMotivo") ?? "";
  return {
    success: false,
    protocolo: null,
    mensagem: xMotivo || `cStat ${cStat ?? "?"}`,
  };
}

// ── Parsing de retorno de inutilização ──

/**
 * Parseia o retorno de NfeInutilizacao4. Estrutura típica:
 *
 *   <retInutNFe versao="4.00" xmlns="...">
 *     <infInut>
 *       <tpAmb>2</tpAmb>
 *       <verAplic>...</verAplic>
 *       <cStat>102</cStat>  <!-- 102 = inutilização homologada -->
 *       <xMotivo>Inutilizacao de numero homologado</xMotivo>
 *       <cUF>35</cUF>
 *       <ano>26</ano>
 *       <CNPJ>...</CNPJ>
 *       <mod>55</mod>
 *       <serie>1</serie>
 *       <nNFIni>100</nNFIni>
 *       <nNFFin>105</nNFFin>
 *       <dhRecbto>...</dhRecbto>
 *       <nProt>135260000000888</nProt>
 *     </infInut>
 *   </retInutNFe>
 */
function parseRetInutNFe(body: string): NfeProviderInutilizacaoResult {
  const infInut = extractTagBlock(body, "infInut");
  const source = infInut ?? body;

  const cStat = extractIntValue(source, "cStat");
  const xMotivo = extractTagValueNs(source, "xMotivo") ?? "";
  const nProt = extractTagValueNs(source, "nProt");
  const lookup = lookupCStat(cStat);

  // 102 = homologada. Demais cStats = falha; duplicidade entra como sucesso
  // idempotente quando a faixa já estava inutilizada antes.
  const isOk =
    lookup.categoria === "inutilizada" ||
    cStat === 102 ||
    lookup.categoria === "duplicidade";

  return {
    success: isOk,
    protocolo: nProt,
    mensagem: xMotivo || `cStat ${cStat ?? "?"}`,
  };
}

/**
 * Parseia o retorno de RecepcaoEvento4 para Carta de Correção. Estrutura é
 * análoga ao cancelamento — mesmo envelope retEvento/infEvento — mas o cStat
 * de sucesso é 135 (vinculada) ou 136 (registrada).
 */
function parseRetCce(
  body: string,
  signedEventoXml: string,
): NfeProviderCartaCorrecaoResult {
  const retEvento = extractTagBlock(body, "retEvento");
  if (retEvento) {
    const infEvento = extractTagBlock(retEvento, "infEvento");
    if (infEvento) {
      const cStat = extractIntValue(infEvento, "cStat");
      const xMotivo = extractTagValueNs(infEvento, "xMotivo") ?? "";
      const nProt = extractTagValueNs(infEvento, "nProt");
      const lookup = lookupCStat(cStat);

      const isOk =
        lookup.categoria === "evento_registrado" ||
        cStat === 135 ||
        cStat === 136 ||
        lookup.categoria === "duplicidade";

      // Em caso de sucesso, montamos `procEventoNFe` = evento assinado +
      // retEvento. Esse é o XML canônico de arquivamento da CCe.
      const xmlEvento = isOk
        ? buildProcEventoCce(signedEventoXml, retEvento)
        : signedEventoXml;

      return {
        success: isOk,
        protocolo: nProt,
        cStat,
        mensagem: xMotivo || `cStat ${cStat}`,
        xmlEvento,
      };
    }
  }

  const cStat = extractIntValue(body, "cStat");
  const xMotivo = extractTagValueNs(body, "xMotivo") ?? "";
  return {
    success: false,
    protocolo: null,
    cStat,
    mensagem: xMotivo || `cStat ${cStat ?? "?"}`,
    xmlEvento: signedEventoXml,
  };
}

function buildProcEventoCce(signedEventoXml: string, retEvento: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">',
    signedEventoXml,
    retEvento,
    "</procEventoNFe>",
  ].join("");
}
