/**
 * Endpoints SEFAZ por UF e ambiente para NFe modelo 55 v4.00.
 *
 * Fonte autoritativa: Portal Nacional NFe (Webservices).
 *   https://www.nfe.fazenda.gov.br/portal/webServices.aspx
 *
 * IMPORTANTE: as UFs migram serviços periodicamente entre SEFAZ próprio,
 * SVRS (Sefaz Virtual do RS) e SVAN (Sefaz Virtual do Ambiente Nacional).
 * Quando uma UF migrar, atualize aqui — não há fallback automático para
 * isso (contingência SVC-AN/SVC-RS é tratada à parte em contingencia.service.ts).
 *
 * Convenções:
 * - Cada UF tem um conjunto independente por ambiente (homologação/produção).
 * - Serviços listados: NFeAutorizacao4, NFeRetAutorizacao4, NfeConsultaProtocolo4,
 *   NfeStatusServico4, NfeInutilizacao4, RecepcaoEvento4.
 * - SOAPAction não é definido por SEFAZ; o cabeçalho HTTP usado é o WS-Addressing
 *   (Action), preenchido por `soap-client.service.ts` com base no serviço.
 *
 * Última conferência: 2026-05-14 (Felipe). Atualize a data ao revisar.
 */

export type SefazServico =
  | "NFeAutorizacao4"
  | "NFeRetAutorizacao4"
  | "NfeConsultaProtocolo4"
  | "NfeStatusServico4"
  | "NfeInutilizacao4"
  | "RecepcaoEvento4";

/**
 * Serviços da NFC-e (modelo 65). Mesmos nomes/versões/SOAP actions da NF-e,
 * porém hospedados em endpoints PRÓPRIOS por UF (autorizador NFC-e).
 * Sem `NfeInutilizacao4`: inutilização de 65 está fora de escopo (Fase 2).
 */
export type NfceServico =
  | "NFeAutorizacao4"
  | "NFeRetAutorizacao4"
  | "NfeConsultaProtocolo4"
  | "NfeStatusServico4"
  | "RecepcaoEvento4";

export type SefazAmbiente = "homologacao" | "producao";

export type UF =
  | "AC" | "AL" | "AM" | "AP" | "BA" | "CE" | "DF" | "ES" | "GO" | "MA"
  | "MG" | "MS" | "MT" | "PA" | "PB" | "PE" | "PI" | "PR" | "RJ" | "RN"
  | "RO" | "RR" | "RS" | "SC" | "SE" | "SP" | "TO";

export type SefazServicosPorAmbiente = Record<SefazServico, string>;

export interface SefazEndpointsUF {
  homologacao: SefazServicosPorAmbiente;
  producao: SefazServicosPorAmbiente;
}

/**
 * Código IBGE da UF. Usado no primeiro par de dígitos da chave de acesso e
 * em campos `cUF` do XML.
 */
export const COD_UF: Record<UF, number> = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
};

// ── SVRS (Sefaz Virtual do RS) — atende muitas UFs ──
const SVRS_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
  NfeStatusServico4:
    "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  NfeInutilizacao4:
    "https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx",
  RecepcaoEvento4:
    "https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
};

const SVRS_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
  NfeStatusServico4:
    "https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  NfeInutilizacao4:
    "https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx",
  RecepcaoEvento4:
    "https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
};

// ── SP (SEFAZ próprio) ──
const SP_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx",
  NfeStatusServico4:
    "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx",
  NfeInutilizacao4:
    "https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx",
  RecepcaoEvento4:
    "https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx",
};

const SP_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx",
  NfeStatusServico4: "https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx",
  NfeInutilizacao4: "https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx",
  RecepcaoEvento4: "https://nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx",
};

// ── MG (SEFAZ próprio) ──
const MG_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4",
  NfeInutilizacao4:
    "https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4",
};

const MG_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4",
  NfeInutilizacao4:
    "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4",
};

// ── PR (SEFAZ próprio) ──
const PR_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4",
  NfeInutilizacao4:
    "https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4",
};

const PR_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4: "https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4",
  NFeRetAutorizacao4: "https://nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4",
  NfeStatusServico4: "https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4",
  NfeInutilizacao4: "https://nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4",
  RecepcaoEvento4: "https://nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4",
};

// ── RS (SEFAZ próprio — diferente do SVRS) ──
const RS_HOM = SVRS_HOM;
const RS_PROD = SVRS_PROD;

// ── BA, GO, MS, MT, PE (SEFAZ próprio) ──
const BA_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://hnfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx",
  NfeStatusServico4:
    "https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx",
  NfeInutilizacao4:
    "https://hnfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx",
  RecepcaoEvento4:
    "https://hnfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
};

const BA_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://nfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx",
  NfeStatusServico4:
    "https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx",
  NfeInutilizacao4:
    "https://nfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx",
  RecepcaoEvento4:
    "https://nfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
};

const GO_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4",
  NfeInutilizacao4:
    "https://homolog.sefaz.go.gov.br/nfe/services/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://homolog.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4",
};

const GO_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4: "https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://nfe.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4",
  NfeInutilizacao4:
    "https://nfe.sefaz.go.gov.br/nfe/services/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://nfe.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4",
};

const MS_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4: "https://hom.nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4",
  NFeRetAutorizacao4: "https://hom.nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://hom.nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4",
  NfeStatusServico4: "https://hom.nfe.sefaz.ms.gov.br/ws/NFeStatusServico4",
  NfeInutilizacao4: "https://hom.nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4",
  RecepcaoEvento4: "https://hom.nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4",
};

const MS_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4: "https://nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4",
  NFeRetAutorizacao4: "https://nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4",
  NfeStatusServico4: "https://nfe.sefaz.ms.gov.br/ws/NFeStatusServico4",
  NfeInutilizacao4: "https://nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4",
  RecepcaoEvento4: "https://nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4",
};

const MT_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4",
  NFeRetAutorizacao4:
    "https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4",
  NfeStatusServico4:
    "https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4",
  NfeInutilizacao4:
    "https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4",
  RecepcaoEvento4:
    "https://homologacao.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4",
};

const MT_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4",
  NFeRetAutorizacao4:
    "https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4",
  NfeStatusServico4:
    "https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4",
  NfeInutilizacao4:
    "https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4",
  RecepcaoEvento4:
    "https://nfe.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4",
};

const PE_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4",
  NfeInutilizacao4:
    "https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4",
};

const PE_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4",
  NFeRetAutorizacao4:
    "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4",
  NfeStatusServico4:
    "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4",
  NfeInutilizacao4:
    "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4",
  RecepcaoEvento4:
    "https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4",
};

const AM_HOM: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://homnfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4",
  NFeRetAutorizacao4:
    "https://homnfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4",
  NfeStatusServico4:
    "https://homnfe.sefaz.am.gov.br/services2/services/NfeStatusServico4",
  NfeInutilizacao4:
    "https://homnfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4",
  RecepcaoEvento4:
    "https://homnfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4",
};

const AM_PROD: SefazServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4",
  NFeRetAutorizacao4:
    "https://nfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4",
  NfeConsultaProtocolo4:
    "https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4",
  NfeStatusServico4:
    "https://nfe.sefaz.am.gov.br/services2/services/NfeStatusServico4",
  NfeInutilizacao4:
    "https://nfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4",
  RecepcaoEvento4:
    "https://nfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4",
};

// NOTA: o Ceara (CE) NAO tem mais autorizador proprio de NF-e modelo 55.
// Desde 10/01/2022 a autorizacao e feita pela SVRS (Comunicado SEFAZ-CE
// "Migracao para SVRS"). Os antigos endpoints nfe(h).sefaz.ce.gov.br foram
// desativados como autorizador. CE entra no bloco SVRS abaixo. A contingencia
// do CE permanece SVC-AN (ver SVC_FALLBACK).

/**
 * Tabela mestre: UF → endpoints por ambiente.
 *
 * UFs que usam SVRS: AC, AL, AP, CE, DF, ES, MA, PA, PB, PI, RJ, RN, RO, RR,
 * SC, SE, TO. (Reaproveitamos a referência SVRS_HOM/PROD.)
 */
export const SEFAZ_ENDPOINTS: Record<UF, SefazEndpointsUF> = {
  // SEFAZ próprios
  SP: { homologacao: SP_HOM, producao: SP_PROD },
  MG: { homologacao: MG_HOM, producao: MG_PROD },
  PR: { homologacao: PR_HOM, producao: PR_PROD },
  RS: { homologacao: RS_HOM, producao: RS_PROD },
  BA: { homologacao: BA_HOM, producao: BA_PROD },
  GO: { homologacao: GO_HOM, producao: GO_PROD },
  MS: { homologacao: MS_HOM, producao: MS_PROD },
  MT: { homologacao: MT_HOM, producao: MT_PROD },
  PE: { homologacao: PE_HOM, producao: PE_PROD },
  AM: { homologacao: AM_HOM, producao: AM_PROD },
  // Atendidas pelo SVRS
  CE: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  AC: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  AL: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  AP: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  DF: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  ES: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  MA: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  PA: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  PB: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  PI: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  RJ: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  RN: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  RO: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  RR: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  SC: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  SE: { homologacao: SVRS_HOM, producao: SVRS_PROD },
  TO: { homologacao: SVRS_HOM, producao: SVRS_PROD },
};

// ── Ambiente Nacional (AN) — usado por inutilização e eventos centrais ──
export const AN_ENDPOINTS = {
  homologacao: {
    NfeInutilizacao4:
      "https://hom.nfe.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx",
    RecepcaoEvento4:
      "https://hom.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
    NFeDistribuicaoDFe:
      "https://hom.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
  },
  producao: {
    NfeInutilizacao4:
      "https://www.nfe.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx",
    RecepcaoEvento4:
      "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
    NFeDistribuicaoDFe:
      "https://www.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
  },
};

// ── Contingência: SVC-AN e SVC-RS ──
// SVC-AN é o backup primário para: AC, AL, AP, CE, DF, ES, MG, PA, PB, PI, RJ,
// RN, RO, RR, SC, SE, SP, TO. (Reservado para indisponibilidade SEFAZ origem.)
// SVC-RS é o backup primário para: AM, BA, GO, MA, MS, MT, PE, PR, RS.
export const SVC_AN_ENDPOINTS = {
  homologacao: {
    NFeAutorizacao4:
      "https://hom.svc.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx",
    NFeRetAutorizacao4:
      "https://hom.svc.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx",
    NfeConsultaProtocolo4:
      "https://hom.svc.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx",
    NfeStatusServico4:
      "https://hom.svc.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx",
    RecepcaoEvento4:
      "https://hom.svc.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  },
  producao: {
    NFeAutorizacao4:
      "https://www.svc.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx",
    NFeRetAutorizacao4:
      "https://www.svc.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx",
    NfeConsultaProtocolo4:
      "https://www.svc.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx",
    NfeStatusServico4:
      "https://www.svc.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx",
    RecepcaoEvento4:
      "https://www.svc.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  },
};

export const SVC_RS_ENDPOINTS = {
  homologacao: {
    NFeAutorizacao4:
      "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
    NFeRetAutorizacao4:
      "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
    NfeConsultaProtocolo4:
      "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
    NfeStatusServico4:
      "https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
    RecepcaoEvento4:
      "https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
  },
  producao: {
    NFeAutorizacao4:
      "https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
    NFeRetAutorizacao4:
      "https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
    NfeConsultaProtocolo4:
      "https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
    NfeStatusServico4:
      "https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
    RecepcaoEvento4:
      "https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
  },
};

/**
 * Mapa UF → SVC primário a usar em contingência.
 */
export const SVC_FALLBACK: Record<UF, "SVC_AN" | "SVC_RS"> = {
  AC: "SVC_AN", AL: "SVC_AN", AP: "SVC_AN", CE: "SVC_AN", DF: "SVC_AN",
  ES: "SVC_AN", MG: "SVC_AN", PA: "SVC_AN", PB: "SVC_AN", PI: "SVC_AN",
  RJ: "SVC_AN", RN: "SVC_AN", RO: "SVC_AN", RR: "SVC_AN", SC: "SVC_AN",
  SE: "SVC_AN", SP: "SVC_AN", TO: "SVC_AN",
  AM: "SVC_RS", BA: "SVC_RS", GO: "SVC_RS", MA: "SVC_RS", MS: "SVC_RS",
  MT: "SVC_RS", PE: "SVC_RS", PR: "SVC_RS", RS: "SVC_RS",
};

/**
 * Retorna a URL do serviço SEFAZ para uma UF + ambiente.
 *
 * Lança erro se o serviço não existir para a UF (caso comum: NfeInutilizacao4
 * em UFs que delegam ao Ambiente Nacional — use `getAnEndpoint()` para esses).
 */
export function getSefazEndpoint(
  uf: UF,
  ambiente: SefazAmbiente,
  servico: SefazServico,
): string {
  const cfg = SEFAZ_ENDPOINTS[uf];
  if (!cfg) throw new Error(`UF nao suportada: ${uf}`);
  const url = cfg[ambiente][servico];
  if (!url) {
    throw new Error(
      `Servico ${servico} indisponivel para UF=${uf} ambiente=${ambiente}`,
    );
  }
  return url;
}

export function getAnEndpoint(
  ambiente: SefazAmbiente,
  servico: keyof (typeof AN_ENDPOINTS)["producao"],
): string {
  return AN_ENDPOINTS[ambiente][servico];
}

export function getSvcEndpoint(
  uf: UF,
  ambiente: SefazAmbiente,
  servico: keyof (typeof SVC_AN_ENDPOINTS)["producao"],
): string {
  const which = SVC_FALLBACK[uf];
  const table = which === "SVC_AN" ? SVC_AN_ENDPOINTS : SVC_RS_ENDPOINTS;
  return table[ambiente][servico];
}

// ═══════════════════════════════════════════════════════════════════════════
// NFC-e (modelo 65) — Fase 2 do PDV. Bloco 100% ADITIVO: nada acima muda.
//
// A NFC-e tem autorizadores PRÓPRIOS por UF (hosts distintos dos da NF-e 55) e
// NÃO possui SVC — a contingência dela é offline (tpEmis=9, fora de escopo).
//
// Conservador de propósito: só listamos UFs cujo autorizador NFC-e foi
// conferido (tenants atuais = SC, atendida pelo SVRS-NFC-e). UF ausente →
// erro claro no fail-fast da emissão, nunca um host errado.
//
// Última conferência: 2026-07-17 (SVRS). Atualize a data ao revisar.
// ═══════════════════════════════════════════════════════════════════════════

export type NfceServicosPorAmbiente = Record<NfceServico, string>;

const SVRS_NFCE_HOM: NfceServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
  NfeStatusServico4:
    "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  RecepcaoEvento4:
    "https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
};

const SVRS_NFCE_PROD: NfceServicosPorAmbiente = {
  NFeAutorizacao4:
    "https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
  NFeRetAutorizacao4:
    "https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx",
  NfeConsultaProtocolo4:
    "https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
  NfeStatusServico4:
    "https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  RecepcaoEvento4:
    "https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
};

export interface NfceEndpointsUF {
  homologacao: NfceServicosPorAmbiente;
  producao: NfceServicosPorAmbiente;
}

/**
 * UFs atendidas pelo SVRS-NFC-e (conferir Portal Nacional ao expandir):
 * inclui SC (tenant base). UFs com autorizador NFC-e próprio (SP, MG, PR, MS,
 * MT, GO, AM, BA, PE...) serão adicionadas sob demanda.
 */
export const NFCE_ENDPOINTS: Partial<Record<UF, NfceEndpointsUF>> = {
  AC: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  AL: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  AP: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  DF: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  ES: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  MA: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  PB: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  PI: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  RJ: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  RN: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  RO: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  RR: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  RS: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  SC: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  SE: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
  TO: { homologacao: SVRS_NFCE_HOM, producao: SVRS_NFCE_PROD },
};

/**
 * Retorna a URL do serviço do AUTORIZADOR NFC-e para uma UF + ambiente.
 * UF sem tabela conferida → erro claro (fail-fast pré-numeração na emissão).
 */
export function getNfceEndpoint(
  uf: UF,
  ambiente: SefazAmbiente,
  servico: NfceServico,
): string {
  const cfg = NFCE_ENDPOINTS[uf];
  if (!cfg) {
    throw new Error(
      `UF ${uf} nao suportada para NFC-e — adicione o autorizador em endpoints.ts (NFCE_ENDPOINTS)`,
    );
  }
  const url = cfg[ambiente][servico];
  if (!url) {
    throw new Error(
      `Servico ${servico} indisponivel para NFC-e UF=${uf} ambiente=${ambiente}`,
    );
  }
  return url;
}
