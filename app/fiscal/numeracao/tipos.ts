/**
 * Numeração V2 — contratos de tipo compartilhados entre:
 *  - provedores em duas fases (SEFAZ direto: prepararEmissao/transmitirPreparada;
 *    Focus: focus-nfe-v2.client),
 *  - classificação pura dos resultados (classificacao.ts),
 *  - serviço/orquestrador da numeração.
 *
 * Arquivo SÓ de tipos (sem runtime). Ver docs/fiscal-numeracao-v2.md.
 */

export type ProvedorFiscal = "SEFAZ_DIRECT" | "FOCUS_NFE";

export type ModeloFiscal = "55" | "65";

export type AmbienteFiscal = "HOMOLOGACAO" | "PRODUCAO";

/** Estados de um número na reserva (NfeNumeroReserva.estado). */
export type EstadoReserva =
  | "RESERVADO" // vinculado ao documento; nunca transmitido ou confirmado não recebido
  | "REJEITADO" // rejeição conclusiva da SEFAZ — mesmo número pode ser reenviado
  | "EM_TRANSMISSAO" // tentativa gravada, requisição em voo (lease)
  | "INCERTO" // enviado, resultado desconhecido — só sai por consulta
  | "BLOQUEADO" // anomalia — conferência manual
  | "AUTORIZADO" // consumido
  | "CANCELADO" // consumido
  | "DENEGADO" // consumido
  | "INUTILIZADO" // consumido
  | "CONSUMIDO_EXTERNO" // número já existe na SEFAZ com chave que não é nossa
  | "ABANDONADO"; // descartado por ação explícita (sem reuso)

/** Estados em que o documento pode reusar o próprio número. */
export const ESTADOS_REUSAVEIS: readonly EstadoReserva[] = [
  "RESERVADO",
  "REJEITADO",
];

/** Estados "vivos" (reserva ainda pertence ao documento). */
export const ESTADOS_VIVOS: readonly EstadoReserva[] = [
  "RESERVADO",
  "REJEITADO",
  "EM_TRANSMISSAO",
  "INCERTO",
  "BLOQUEADO",
  "AUTORIZADO",
  "CANCELADO",
];

/** Estados em que o número está fiscalmente consumido ou definitivamente fora de uso. */
export const ESTADOS_CONSUMIDOS: readonly EstadoReserva[] = [
  "AUTORIZADO",
  "CANCELADO",
  "DENEGADO",
  "INUTILIZADO",
  "CONSUMIDO_EXTERNO",
];

export type FaseTentativa = "TRANSMITINDO" | "RESPONDIDA" | "FECHADA";

/** Falha de transporte (null = houve resposta HTTP/SOAP legível). */
export type Transporte = null | "TIMEOUT" | "REDE" | "SEM_CREDENCIAL";

// ─────────────────────────── SEFAZ direto (duas fases) ───────────────────────────

/** Resultado de `SefazDirectProvider.prepararEmissao` (sem rede). */
export interface SefazNfePreparada {
  modelo: ModeloFiscal;
  tpEmis: 1;
  chaveAcesso: string; // 44 dígitos
  cNF: string; // 8 dígitos
  dhEmi: Date;
  signedXml: string;
  digestValue: string;
}

/** Resultado bruto de `SefazDirectProvider.transmitirPreparada` (nunca lança). */
export interface SefazTransmissao {
  transporte: Transporte;
  httpStatus: number | null;
  loteCStat: number | null;
  loteXMotivo: string;
  protCStat: number | null;
  protXMotivo: string;
  nProt: string | null;
  dhRecbto: Date | null;
  nRec: string | null;
  chNFe: string | null;
  protNFeXml: string | null;
  /** nfeProc completo quando a autorização veio síncrona. */
  xmlAutorizado: string | null;
}

/** Resultado bruto de consulta por chave (NfeConsultaProtocolo) ou por recibo. */
export interface SefazConsultaDetalhada {
  transporte: Transporte;
  httpStatus: number | null;
  cStat: number | null;
  xMotivo: string;
  nProt: string | null;
  dhRecbto: Date | null;
  digVal: string | null;
  chNFe: string | null;
  protNFeXml: string | null;
}

// ─────────────────────────────── Focus NFe (V2) ───────────────────────────────

/** Subconjunto do corpo JSON do Focus que a V2 lê (strings, como o Focus devolve). */
export interface FocusV2Corpo {
  status?: string;
  status_sefaz?: string | number | null;
  mensagem_sefaz?: string | null;
  codigo?: string | null;
  mensagem?: string | null;
  /** Sempre normalizada para 44 dígitos (prefixo "NFe" removido). */
  chave_nfe?: string | null;
  numero?: string | number | null;
  serie?: string | number | null;
  protocolo?: string | null;
  protocolo_sefaz?: string | null;
  data_evento?: string | null;
  caminho_xml_nota_fiscal?: string | null;
  erros?: Array<{ mensagem?: string; campo?: string; codigo?: string }>;
}

/** Resposta bruta do cliente Focus V2 (nunca lança; nunca carrega token). */
export interface FocusV2Resposta {
  httpStatus: number | null;
  transporte: Transporte;
  corpo: FocusV2Corpo | null;
  retryAfterMs: number | null;
}

// ───────────────────────────── Classificação ─────────────────────────────

export type ClasseResultado =
  | "AUTORIZADA"
  | "REJEICAO"
  | "PRE_ENVIO_PROVEDOR"
  | "SERVICO_INDISPONIVEL"
  | "CONSUMO_INDEVIDO"
  | "RATE_LIMIT"
  | "EM_PROCESSAMENTO"
  | "EM_PROCESSAMENTO_NA_SEFAZ"
  | "INCERTO_TRANSPORTE"
  | "DENEGADA"
  | "DENEGACAO_A_CONFIRMAR"
  | "DUPLICIDADE_MESMA_CHAVE"
  | "DUPLICIDADE_OUTRA_CHAVE"
  | "DENEGADA_NA_BASE"
  | "INUTILIZADA_NA_BASE"
  | "CANCELADA_NA_BASE"
  | "CANCELADA_FORA_DO_FLUXO"
  | "NAO_CONSTA"
  | "CONSULTA_INCONCLUSIVA"
  | "DESCONHECIDO";

/** Próximo passo pedido pela classificação (executado pelo orquestrador). */
export type AcaoSeguimento =
  | "NENHUMA"
  | "CONSULTAR_CHAVE"
  | "POLL_RECIBO"
  | "POLL_CHAVE"
  | "GET_REF"
  | "POLL_REF"
  | "RECONCILIAR_539";

export interface Classificacao {
  classe: ClasseResultado;
  /** Estado final da reserva, quando a resposta já decide; null quando depende de `acao`. */
  estadoAlvo: EstadoReserva | null;
  acao: AcaoSeguimento;
  /** cStat inteiro normalizado (ou null). */
  cStat: number | null;
  /** Código textual do provedor, quando não numérico. */
  codigoProvedor: string | null;
  /** A resposta prova que ESTA tentativa terminou sem autorização? */
  conclusiva: boolean;
  /** Chave de 44 dígitos citada no xMotivo/mensagem (539/562/613), se houver. */
  chaveReferida: string | null;
  /** Espera mínima antes de nova tentativa (429/656). */
  retryAposMs: number | null;
  /** Mensagem legível para o usuário (sem segredo). */
  mensagem: string;
}
