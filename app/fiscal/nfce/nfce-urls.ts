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
 * Última conferência: 2026-07-17 — cruzamento ACBrNFeServicos.ini
 * (URL-QRCode/_2.00 + URL-ConsultaNFCe_2.00) × sped-nfe (wsnfe_4.00_mod65 +
 * uri_consulta_nfce.json); divergências desempatadas com probe HTTP na
 * página pública (RJ hom → www4 redireciona p/ consultadfe; RN → host
 * sefaz.rn vivo, set.rn 403; PB hom → sefaz.pb vivo, receita.pb morto;
 * BA/SP v2 confirmadas com 200).
 *
 * FORA (sem desempate — adicionar sob demanda conferindo na SEFAZ da UF):
 * AM (fontes divergem também no autorizador), PE (duas URLs de QR vivas e
 * diferentes), RR (ambas candidatas 404), SE (ambas candidatas 403).
 *
 * `chave` é o texto canônico do <urlChave> — várias UFs publicam SEM
 * esquema (ex.: "www.sefaz.al.gov.br/nfce/consulta"); manter verbatim.
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
  AC: {
    homologacao: {
      qr: "http://www.hml.sefaznet.ac.gov.br/nfce/qrcode",
      chave: "www.sefaznet.ac.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.sefaznet.ac.gov.br/nfce/qrcode",
      chave: "www.sefaznet.ac.gov.br/nfce/consulta",
    },
  },
  AL: {
    homologacao: {
      qr: "http://nfce.sefaz.al.gov.br/QRCode/consultarNFCe.jsp",
      chave: "www.sefaz.al.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://nfce.sefaz.al.gov.br/QRCode/consultarNFCe.jsp",
      chave: "www.sefaz.al.gov.br/nfce/consulta",
    },
  },
  AP: {
    homologacao: {
      qr: "https://www.sefaz.ap.gov.br/nfcehml/nfce.php",
      chave: "www.sefaz.ap.gov.br/nfce/consulta",
    },
    producao: {
      qr: "https://www.sefaz.ap.gov.br/nfce/nfcep.php",
      chave: "www.sefaz.ap.gov.br/nfce/consulta",
    },
  },
  BA: {
    homologacao: {
      qr: "http://hnfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx",
      chave: "http://hinternet.sefaz.ba.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://nfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx",
      chave: "http://www.sefaz.ba.gov.br/nfce/consulta",
    },
  },
  CE: {
    homologacao: {
      qr: "http://nfceh.sefaz.ce.gov.br/pages/ShowNFCe.html",
      chave: "www.sefaz.ce.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html",
      chave: "www.sefaz.ce.gov.br/nfce/consulta",
    },
  },
  DF: {
    homologacao: {
      qr: "http://dec.fazenda.df.gov.br/ConsultarNFCe.aspx",
      chave: "www.fazenda.df.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.fazenda.df.gov.br/nfce/qrcode",
      chave: "www.fazenda.df.gov.br/nfce/consulta",
    },
  },
  ES: {
    homologacao: {
      qr: "http://homologacao.sefaz.es.gov.br/ConsultaNFCe/qrcode.aspx",
      chave: "www.sefaz.es.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://app.sefaz.es.gov.br/ConsultaNFCe/qrcode.aspx",
      chave: "www.sefaz.es.gov.br/nfce/consulta",
    },
  },
  GO: {
    homologacao: {
      qr: "https://nfewebhomolog.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe",
      chave:
        "http://www.nfce.go.gov.br/post/ver/214413/consulta-nfc-e-homologacao",
    },
    producao: {
      qr: "https://nfeweb.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe",
      chave: "http://www.sefaz.go.gov.br/nfce/consulta",
    },
  },
  MA: {
    homologacao: {
      qr: "http://www.hom.nfce.sefaz.ma.gov.br/portal/consultarNFCe.jsp",
      chave: "www.sefaz.ma.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.nfce.sefaz.ma.gov.br/portal/consultarNFCe.jsp",
      chave: "www.sefaz.ma.gov.br/nfce/consulta",
    },
  },
  // MG publica o MESMO host de QR para os dois ambientes (só a consulta
  // por chave tem host de homologação próprio) — as duas fontes coincidem.
  MG: {
    homologacao: {
      qr: "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml",
      chave: "https://hportalsped.fazenda.mg.gov.br/portalnfce",
    },
    producao: {
      qr: "https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml",
      chave: "https://portalsped.fazenda.mg.gov.br/portalnfce",
    },
  },
  MS: {
    homologacao: {
      qr: "http://www.dfe.ms.gov.br/nfce/qrcode",
      chave: "http://www.dfe.ms.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.dfe.ms.gov.br/nfce/qrcode",
      chave: "http://www.dfe.ms.gov.br/nfce/consulta",
    },
  },
  MT: {
    homologacao: {
      qr: "http://homologacao.sefaz.mt.gov.br/nfce/consultanfce",
      chave: "http://homologacao.sefaz.mt.gov.br/nfce/consultanfce",
    },
    producao: {
      qr: "http://www.sefaz.mt.gov.br/nfce/consultanfce",
      chave: "http://www.sefaz.mt.gov.br/nfce/consultanfce",
    },
  },
  PA: {
    homologacao: {
      qr: "https://appnfc.sefa.pa.gov.br/portal-homologacao/view/consultas/nfce/nfceForm.seam",
      chave: "www.sefa.pa.gov.br/nfce/consulta",
    },
    producao: {
      qr: "https://appnfc.sefa.pa.gov.br/portal/view/consultas/nfce/nfceForm.seam",
      chave: "www.sefa.pa.gov.br/nfce/consulta",
    },
  },
  PB: {
    homologacao: {
      qr: "http://www.sefaz.pb.gov.br/nfcehom",
      chave: "www.sefaz.pb.gov.br/nfcehom",
    },
    producao: {
      qr: "http://www.sefaz.pb.gov.br/nfce",
      chave: "www.sefaz.pb.gov.br/nfce/consulta",
    },
  },
  PI: {
    homologacao: {
      qr: "http://www.sefaz.pi.gov.br/nfce/qrcode",
      chave: "www.sefaz.pi.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.sefaz.pi.gov.br/nfce/qrcode",
      chave: "www.sefaz.pi.gov.br/nfce/consulta",
    },
  },
  PR: {
    homologacao: {
      qr: "http://www.fazenda.pr.gov.br/nfce/qrcode",
      chave: "http://www.fazenda.pr.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.fazenda.pr.gov.br/nfce/qrcode",
      chave: "http://www.fazenda.pr.gov.br/nfce/consulta",
    },
  },
  RJ: {
    homologacao: {
      qr: "https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode",
      chave: "www.fazenda.rj.gov.br/nfce/consulta",
    },
    producao: {
      qr: "https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode",
      chave: "www.fazenda.rj.gov.br/nfce/consulta",
    },
  },
  RN: {
    homologacao: {
      qr: "https://hom.nfce.sefaz.rn.gov.br/consultarNFCe.aspx",
      chave: "https://hom.nfce.sefaz.rn.gov.br/portalDFE/NFCe/ConsultaNFCe.aspx",
    },
    producao: {
      qr: "https://nfce.sefaz.rn.gov.br/consultarNFCe.aspx",
      chave: "https://nfce.sefaz.rn.gov.br/portalDFE/NFCe/ConsultaNFCe.aspx",
    },
  },
  RO: {
    homologacao: {
      qr: "http://www.nfce.sefin.ro.gov.br/consultanfce/consulta.jsp",
      chave: "www.sefin.ro.gov.br/nfce/consulta",
    },
    producao: {
      qr: "http://www.nfce.sefin.ro.gov.br/consultanfce/consulta.jsp",
      chave: "www.sefin.ro.gov.br/nfce/consulta",
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
  SP: {
    homologacao: {
      qr: "https://www.homologacao.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx",
      chave:
        "https://www.homologacao.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx",
    },
    producao: {
      qr: "https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx",
      chave:
        "https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx",
    },
  },
  TO: {
    homologacao: {
      qr: "http://homologacao.sefaz.to.gov.br/nfce/qrcode",
      chave: "http://homologacao.sefaz.to.gov.br/nfce/consulta.jsf",
    },
    producao: {
      qr: "http://www.sefaz.to.gov.br/nfce/qrcode",
      chave: "www.sefaz.to.gov.br/nfce/consulta",
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
