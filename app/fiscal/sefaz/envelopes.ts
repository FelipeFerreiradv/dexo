/**
 * Helpers para envelopar payloads SEFAZ em SOAP 1.2.
 *
 * IMPORTANTE: usamos concatenação de string para preservar BYTE-A-BYTE o XML
 * já assinado. Qualquer re-canonização (parse + re-serialize) quebra a
 * assinatura XML-DSig. Os envelopes embarcam o `<NFe>...signed...</NFe>` ou
 * outros payloads assinados como string crua dentro do template.
 *
 * O conteúdo do `<nfeDadosMsg>` deve seguir o schema XSD do serviço — esta
 * camada apenas embrulha, sem validar.
 */

const NFE_NS = "http://www.portalfiscal.inf.br/nfe";

const WSDL_AUTORIZACAO = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4";
const WSDL_RET_AUTORIZACAO =
  "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4";
const WSDL_CONSULTA_PROTOCOLO =
  "http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4";
const WSDL_RECEPCAO_EVENTO =
  "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4";
const WSDL_INUTILIZACAO =
  "http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4";

export const SOAP_ACTIONS = {
  NFeAutorizacao4: `${WSDL_AUTORIZACAO}/nfeAutorizacaoLote`,
  NFeRetAutorizacao4: `${WSDL_RET_AUTORIZACAO}/nfeRetAutorizacaoLote`,
  NfeConsultaProtocolo4: `${WSDL_CONSULTA_PROTOCOLO}/nfeConsultaNF`,
  RecepcaoEvento4: `${WSDL_RECEPCAO_EVENTO}/nfeRecepcaoEvento`,
  NfeInutilizacao4: `${WSDL_INUTILIZACAO}/nfeInutilizacaoNF`,
} as const;

function wrapSoap12(payload: string, wsdlNs: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"',
    ` xmlns:nfe="${wsdlNs}">`,
    "<soap:Body>",
    "<nfe:nfeDadosMsg>",
    payload,
    "</nfe:nfeDadosMsg>",
    "</soap:Body>",
    "</soap:Envelope>",
  ].join("");
}

/**
 * Envelope para NFeAutorizacao4.
 *
 * @param signedNfeXml string `<NFe>...<Signature>...</Signature></NFe>` já assinada
 * @param tpAmb 1=produção, 2=homologação
 * @param idLote identificador do lote (1..15 dígitos)
 * @param indSinc "1" = síncrono (default — recomendado pela SEFAZ NT 2018.005),
 *                "0" = assíncrono (legado)
 */
export function buildEnviNFeEnvelope(opts: {
  signedNfeXml: string;
  tpAmb: "1" | "2";
  idLote: string;
  indSinc?: "0" | "1";
}): string {
  const indSinc = opts.indSinc ?? "1";
  const enviNFe =
    `<enviNFe xmlns="${NFE_NS}" versao="4.00">` +
    `<idLote>${escapeXmlText(opts.idLote)}</idLote>` +
    `<indSinc>${indSinc}</indSinc>` +
    opts.signedNfeXml +
    "</enviNFe>";
  return wrapSoap12(enviNFe, WSDL_AUTORIZACAO);
}

/**
 * Envelope para NFeRetAutorizacao4 — usado quando emissão é assíncrona e
 * a SEFAZ retornou um nRec (recibo do lote). Consulta o resultado do
 * processamento.
 */
export function buildConsReciNFeEnvelope(opts: {
  tpAmb: "1" | "2";
  nRec: string;
}): string {
  const payload =
    `<consReciNFe xmlns="${NFE_NS}" versao="4.00">` +
    `<tpAmb>${opts.tpAmb}</tpAmb>` +
    `<nRec>${escapeXmlText(opts.nRec)}</nRec>` +
    "</consReciNFe>";
  return wrapSoap12(payload, WSDL_RET_AUTORIZACAO);
}

/**
 * Envelope para NfeConsultaProtocolo4 — consulta de NFe pela chave de acesso.
 */
export function buildConsSitNFeEnvelope(opts: {
  tpAmb: "1" | "2";
  chNFe: string;
}): string {
  const payload =
    `<consSitNFe xmlns="${NFE_NS}" versao="4.00">` +
    `<tpAmb>${opts.tpAmb}</tpAmb>` +
    `<xServ>CONSULTAR</xServ>` +
    `<chNFe>${escapeXmlText(opts.chNFe)}</chNFe>` +
    "</consSitNFe>";
  return wrapSoap12(payload, WSDL_CONSULTA_PROTOCOLO);
}

/**
 * Envelope para RecepcaoEvento4 (cancelamento / CCe). Recebe o `<evento>`
 * JÁ ASSINADO como string crua para preservar a assinatura.
 */
export function buildEnvEventoEnvelope(opts: {
  signedEventoXml: string;
  idLote: string;
}): string {
  const envEvento =
    `<envEvento xmlns="${NFE_NS}" versao="1.00">` +
    `<idLote>${escapeXmlText(opts.idLote)}</idLote>` +
    opts.signedEventoXml +
    "</envEvento>";
  return wrapSoap12(envEvento, WSDL_RECEPCAO_EVENTO);
}

/**
 * Envelope para NfeInutilizacao4. Recebe o `<inutNFe>` JÁ ASSINADO como
 * string crua para preservar a assinatura.
 */
export function buildInutNFeEnvelope(opts: {
  signedInutNFeXml: string;
}): string {
  return wrapSoap12(opts.signedInutNFeXml, WSDL_INUTILIZACAO);
}

function escapeXmlText(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
