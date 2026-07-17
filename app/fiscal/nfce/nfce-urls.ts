/**
 * URLs de consulta do QR Code e de consulta por chave da NFC-e (modelo 65),
 * por UF e ambiente.
 *
 * Fonte autoritativa: Portal Nacional NF-e → "Consulta NFC-e" (tabela por UF)
 * e Manual de Padrões Técnicos do DANFE NFC-e e QR Code.
 *
 * ADITIVO e conservador: só listamos UFs CONFERIDAS. UF ausente → erro claro
 * na emissão (fail-fast ANTES de reservar número), nunca URL errada no QR.
 * Tenants atuais do Dexo são SC — conferida em primeiro lugar.
 *
 * Última conferência: 2026-07-17 (SC/RS). Atualize a data ao revisar.
 */

import type { SefazAmbiente, UF } from "../sefaz/endpoints";

export interface NfceUrlsAmbiente {
  /** Base do QR Code (recebe `?p=...`). */
  qr: string;
  /** URL "consulta por chave" exibida no DANFE NFC-e (urlChave). */
  chave: string;
}

export interface NfceUrlsUF {
  homologacao: NfceUrlsAmbiente;
  producao: NfceUrlsAmbiente;
}

export const NFCE_QR_URLS: Partial<Record<UF, NfceUrlsUF>> = {
  SC: {
    homologacao: {
      qr: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
      chave: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
    },
    producao: {
      qr: "https://sat.sef.sc.gov.br/nfce/consulta",
      chave: "https://sat.sef.sc.gov.br/nfce/consulta",
    },
  },
  RS: {
    homologacao: {
      qr: "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx",
      chave: "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx",
    },
    producao: {
      qr: "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx",
      chave: "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx",
    },
  },
};

export function getNfceQrUrls(
  uf: UF,
  ambiente: SefazAmbiente,
): NfceUrlsAmbiente {
  const urls = NFCE_QR_URLS[uf];
  if (!urls) {
    throw new Error(
      `UF ${uf} sem URLs de QR Code NFC-e cadastradas — confira o Portal Nacional e adicione em nfce-urls.ts`,
    );
  }
  return urls[ambiente];
}
