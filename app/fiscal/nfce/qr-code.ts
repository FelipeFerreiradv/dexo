/**
 * QR Code da NFC-e (modelo 65) — versão 2, emissão ONLINE (tpEmis=1).
 *
 * Manual de Padrões Técnicos do DANFE NFC-e e QR Code:
 *   p = chNFe|nVersao|tpAmb|cIdToken|cHashQRCode
 *   - nVersao = "2"
 *   - cIdToken = idCSC SEM zeros à esquerda ("000001" → "1")
 *   - cHashQRCode = SHA-1( "chNFe|2|tpAmb|cIdToken" + CSC ) em HEX MAIÚSCULO
 *     (o CSC é concatenado SEM separador e NÃO aparece no QR)
 *   qrCode = <urlQr>?p=<p>
 *
 * O grupo <infNFeSupl> (qrCode + urlChave) fica ENTRE </infNFe> e <Signature>
 * dentro de <NFe>. A assinatura cobre APENAS o infNFe (referenceElement), então
 * a injeção acontece DEPOIS do sign sem invalidar a assinatura.
 *
 * Contingência offline (tpEmis=9, QR com dhEmi/vNF) está FORA de escopo na
 * Fase 2 (decisão registrada) — só emissão online.
 *
 * Módulo puro: sem I/O; determinístico.
 */

import { createHash } from "crypto";

import type { SefazAmbiente, UF } from "../sefaz/endpoints";
import { getNfceQrUrls } from "./nfce-urls";

export const NFCE_QR_VERSAO = "2";

export interface QrCodeNfceInput {
  /** Chave de acesso (44 dígitos, mod=65). */
  chaveAcesso: string;
  /** 1 = produção, 2 = homologação. */
  tpAmb: "1" | "2";
  /** idCSC (cIdToken) como cadastrado na SEFAZ — aceita zeros à esquerda. */
  cscId: string;
  /** CSC (Código de Segurança do Contribuinte) — segredo, não vai no QR. */
  cscToken: string;
  uf: UF;
  ambiente: SefazAmbiente;
}

export interface QrCodeNfceResult {
  /** Conteúdo do <qrCode> (URL completa com ?p=...). */
  qrCode: string;
  /** Conteúdo do <urlChave> (consulta por chave). */
  urlChave: string;
}

export function montarQrCodeNfce(input: QrCodeNfceInput): QrCodeNfceResult {
  const chave = (input.chaveAcesso ?? "").replace(/\D/g, "");
  if (chave.length !== 44) {
    throw new Error(
      `QR NFC-e: chave de acesso deve ter 44 dígitos (recebido: ${chave.length})`,
    );
  }
  if (input.tpAmb !== "1" && input.tpAmb !== "2") {
    throw new Error(`QR NFC-e: tpAmb inválido (${input.tpAmb})`);
  }
  const idDigits = (input.cscId ?? "").replace(/\D/g, "");
  const cIdToken = String(Number(idDigits));
  if (!idDigits || !Number.isFinite(Number(idDigits)) || Number(idDigits) < 1) {
    throw new Error("QR NFC-e: idCSC (cscId) inválido — configure na configuração fiscal");
  }
  const csc = (input.cscToken ?? "").trim();
  if (!csc) {
    throw new Error("QR NFC-e: CSC (cscToken) ausente — configure na configuração fiscal");
  }

  const pParcial = `${chave}|${NFCE_QR_VERSAO}|${input.tpAmb}|${cIdToken}`;
  const hash = createHash("sha1")
    .update(pParcial + csc, "utf8")
    .digest("hex")
    .toUpperCase();

  const urls = getNfceQrUrls(input.uf, input.ambiente);
  return {
    qrCode: `${urls.qr}?p=${pParcial}|${hash}`,
    urlChave: urls.chave,
  };
}

/** Monta o grupo `<infNFeSupl>` (qrCode em CDATA + urlChave). */
export function buildInfNFeSuplXml(qrCode: string, urlChave: string): string {
  return `<infNFeSupl><qrCode><![CDATA[${qrCode}]]></qrCode><urlChave>${urlChave}</urlChave></infNFeSupl>`;
}

/**
 * Injeta o `<infNFeSupl>` no XML JÁ ASSINADO, imediatamente antes do primeiro
 * `<Signature` (posição exigida pelo schema: entre infNFe e Signature).
 */
export function injectInfNFeSupl(
  signedNfeXml: string,
  infNFeSuplXml: string,
): string {
  const idx = signedNfeXml.indexOf("<Signature");
  if (idx === -1) {
    throw new Error(
      "injectInfNFeSupl: XML sem <Signature> — assine o infNFe antes de injetar o infNFeSupl",
    );
  }
  return (
    signedNfeXml.slice(0, idx) + infNFeSuplXml + signedNfeXml.slice(idx)
  );
}

/** Extrai qrCode/urlChave de um XML autorizado (p/ DANFE cupom re-render). */
export function extractQrCodeFromXml(xml: string): {
  qrCode: string | null;
  urlChave: string | null;
} {
  const qrMatch = xml.match(
    /<qrCode>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/qrCode>/,
  );
  const urlMatch = xml.match(/<urlChave>([\s\S]*?)<\/urlChave>/);
  return {
    qrCode: qrMatch ? qrMatch[1].trim() : null,
    urlChave: urlMatch ? urlMatch[1].trim() : null,
  };
}
