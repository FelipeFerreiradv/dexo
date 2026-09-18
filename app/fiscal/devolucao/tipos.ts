/**
 * NF-e de DEVOLUÇÃO (finNFe=4) — tipos do domínio puro.
 *
 * Compartilhados por: validação/saldo/tributação/montagem (este diretório),
 * repositório e use case de devolução (backend) e o wizard (front).
 * Contrato HTTP (corpos, respostas, códigos de erro) fica em `contrato.ts`.
 *
 * Arquivo SÓ de tipos (sem runtime). Ver docs/fiscal-devolucao.md.
 */

import type { NfeStatus } from "../domain/nfe.types";
import type {
  MapeamentoCfopDevolucao,
  StatusMapeamentoCfop,
} from "../domain/devolucao-cfop";

export type { MapeamentoCfopDevolucao, StatusMapeamentoCfop };

/** VENDA_ENTRADA: o vendedor recebe de volta (tpNF=0). COMPRA_SAIDA: devolve ao fornecedor (tpNF=1). */
export type TipoDevolucao = "VENDA_ENTRADA" | "COMPRA_SAIDA";
export type FonteDevolucao = "DEXO" | "XML_IMPORTADO" | "MANUAL";
export type EscopoDevolucao = "TOTAL" | "PARCIAL";
/** ITEM = det/DFeReferenciado; NOTA = ide/NFref/refNFe. Nunca os dois (rejeição 1010). */
export type ModoReferenciaDevolucao = "ITEM" | "NOTA";
export type IdDest = 1 | 2 | 3;
/** 1=Simples; 2=Simples excesso de sublimite (usa CST); 3=Normal; 4=MEI (usa CSOSN). */
export type CrtEmitente = "1" | "2" | "3" | "4";
export type IndFinalDevolucao = "0" | "1";

// ─────────────────────────────── Issues ───────────────────────────────

export type SeveridadeIssue = "ERRO" | "AVISO";

export type DevolucaoIssueCode =
  // cabeçalho
  | "NAO_GERENCIADA"
  | "ESCOLHA_PENDENTE"
  | "RECUSA_NAO_E_DEVOLUCAO"
  | "FINALIDADE_NAO_DEVOLUCAO"
  | "MODELO_NAO_PERMITIDO"
  | "TIPO_OPERACAO_INCOERENTE"
  | "NFREF_PROIBIDA"
  | "PAGAMENTO_SERA_90"
  | "COBRANCA_NAO_ENVIADA"
  | "SEM_ITENS"
  | "ITENS_DESALINHADOS"
  | "IDDEST_DIVERGENTE_ORIGINAL"
  // referência por item
  | "REFERENCIA_AUSENTE"
  | "CHAVE_INVALIDA"
  | "MODELO_ORIGINAL_NAO_SUPORTADO"
  | "NITEM_INVALIDO"
  | "REFERENCIA_DUPLICADA"
  | "EMITENTES_DIVERSOS"
  | "EMITENTE_ORIGINAL_DIVERGENTE"
  | "DESTINATARIO_NAO_E_EMITENTE_ORIGINAL"
  // CFOP
  | "CFOP_ESCOLHA_PENDENTE"
  | "CFOP_NAO_DEVOLUCAO"
  | "CFOP_SENTIDO_INVALIDO"
  | "CFOP_IDDEST_DIVERGENTE"
  | "CFOP_MEI_NAO_PERMITIDO"
  // quantidade / saldo / original
  | "QUANTIDADE_INVALIDA"
  | "SALDO_EXCEDIDO"
  | "SALDO_NAO_VERIFICAVEL"
  | "ORIGINAL_CANCELADA"
  | "ORIGINAL_NAO_AUTORIZADA"
  | "AMBIENTE_DIVERGENTE"
  // tributação
  | "TRIBUTACAO_AUSENTE"
  | "TRIBUTACAO_REVISAO_PENDENTE"
  | "TRIBUTACAO_NAO_SUPORTADA"
  | "TRIBUTACAO_REGIME_INCOMPATIVEL"
  | "IPI_DEVOL_INVALIDO"
  | "PIS_CST_SAIDA_EM_ENTRADA"
  | "IBS_CBS_NAO_ENVIADO"
  // montagem do rascunho
  | "TOTALMENTE_DEVOLVIDA"
  | "PARCIALMENTE_DEVOLVIDA"
  | "JA_E_DEVOLUCAO"
  | "ORIGINAL_ENTRADA"
  | "CHAVE_DIVERGENTE"
  | "XML_SEM_AUTORIZACAO"
  | "EMISSAO_EM_ANDAMENTO"
  | "DESTINATARIO_AUSENTE";

export interface DevolucaoIssue {
  code: DevolucaoIssueCode;
  /** ERRO bloqueia a emissão; AVISO só informa. */
  severidade: SeveridadeIssue;
  /** Posição do item da devolução (1..990), quando a issue é de item. */
  ordem?: number;
  /** pt-BR; cita a rejeição SEFAZ equivalente quando há uma (rastreabilidade). */
  mensagem: string;
}

// ─────────────────────────── Imposto original (XML) ───────────────────────────

export interface IcmsOriginal {
  /** Tag do XML original: "ICMS00", "ICMSSN102"… */
  grupo: string;
  orig: number | null;
  cst?: string;
  csosn?: string;
  modBC?: string;
  vBC?: number;
  pRedBC?: number;
  pICMS?: number;
  vICMS?: number;
  vBCST?: number;
  vICMSST?: number;
  pCredSN?: number;
  vCredICMSSN?: number;
}

export interface IpiOriginal {
  /** "IPITrib" | "IPINT" */
  grupo: string;
  cEnq?: string;
  cst: string;
  vBC?: number;
  pIPI?: number;
  vIPI?: number;
}

export interface PisOriginal {
  /** "PISAliq" | "PISQtde" | "PISNT" | "PISOutr" */
  grupo: string;
  cst: string;
  vBC?: number;
  pPIS?: number;
  vPIS?: number;
  qBCProd?: number;
  vAliqProd?: number;
}

export interface CofinsOriginal {
  /** "COFINSAliq" | "COFINSQtde" | "COFINSNT" | "COFINSOutr" */
  grupo: string;
  cst: string;
  vBC?: number;
  pCOFINS?: number;
  vCOFINS?: number;
  qBCProd?: number;
  vAliqProd?: number;
}

/** `imposto` do det original normalizado (gravado em NfeDevolucaoItem.impostoOriginalJson). */
export interface ImpostoOriginal {
  icms: IcmsOriginal | null;
  ipi: IpiOriginal | null;
  pis: PisOriginal | null;
  cofins: CofinsOriginal | null;
  /** Grupo IBSCBS presente (não é emitido na devolução; gera aviso). */
  temIbsCbs: boolean;
}

// ─────────────────────────── Tributação da devolução ───────────────────────────

/** Allowlist v1 de tags ICMS na devolução (plano §6.4). */
export type TagIcmsDevolucao =
  | "ICMSSN102"
  | "ICMSSN500"
  | "ICMSSN900"
  | "ICMS00"
  | "ICMS40"
  | "ICMS60"
  | "ICMS90";

export type MotivoRevisaoTributacao =
  | "SEM_XML"
  | "QUANTIDADE_ORIGINAL_DESCONHECIDA"
  | "REGIME_DIVERGENTE"
  | "ICMS_AUSENTE"
  | "ICMS_ORIGEM_AUSENTE"
  | "ICMS_GRUPO_NAO_SUPORTADO"
  | "ICMS_ST_NAO_SUPORTADO"
  | "ICMS_BASE_REDUZIDA"
  | "ICMS_MODBC_NAO_SUPORTADO"
  | "ICMS_VALORES_AUSENTES"
  | "IPI_DESTACADO"
  | "PIS_AUSENTE"
  | "PIS_NAO_SUPORTADO"
  | "PIS_VALORES_AUSENTES"
  | "COFINS_AUSENTE"
  | "COFINS_NAO_SUPORTADO"
  | "COFINS_VALORES_AUSENTES"
  | "PIS_CST_SAIDA_EM_ENTRADA"
  | "ALTERADA_PELO_USUARIO";

export type AvisoTributacao = "PIS_CST_SAIDA_EM_ENTRADA" | "IBS_CBS_NAO_ENVIADO";

export interface TributoPisCofinsDevolucao {
  cst: string | null;
  vBC: number;
  /** Alíquota (%). */
  p: number;
  /** Valor. */
  v: number;
}

/** Gravada em NfeDevolucaoItem.tributacaoJson. */
export interface TributacaoDevolucaoItem {
  versao: 1;
  fonte: "XML_ORIGINAL" | "SEM_XML" | "USUARIO";
  icms: {
    /** null = fora da allowlist (bloqueia até revisão). */
    tag: TagIcmsDevolucao | null;
    cst: string | null;
    csosn: string | null;
    orig: number | null;
    modBC: string | null;
    vBC: number;
    pICMS: number;
    vICMS: number;
  };
  pis: TributoPisCofinsDevolucao;
  cofins: TributoPisCofinsDevolucao;
  /** impostoDevol (IPI devolvido). Só com IPI destacado na original. */
  ipiDevol: { pDevol: number; vIPIDevol: number } | null;
  requerRevisao: boolean;
  motivosRevisao: MotivoRevisaoTributacao[];
  avisos: AvisoTributacao[];
  /** Usuário confirmou a revisão (confirmarTributacao). */
  confirmada: boolean;
}

/** Ajuste explícito do usuário (PUT …/devolucao/itens). Passa pela mesma allowlist. */
export interface TributacaoOverride {
  icms?: {
    cst?: string | null;
    csosn?: string | null;
    modBC?: string | null;
    pICMS?: number | null;
  };
  pis?: { cst?: string | null; p?: number | null };
  cofins?: { cst?: string | null; p?: number | null };
  /** false remove o grupo impostoDevol. */
  ipiDevol?: boolean;
}

// ─────────────────────────────── Saldo ───────────────────────────────

export interface SaldoItemOriginal {
  nItem: number;
  /** null = original externa sem XML (saldo não verificável). */
  quantidadeOriginal: number | null;
  /** AUTHORIZED — consome. */
  devolvidaAutorizada: number;
  /** VALIDATING | SIGNING | SENDING — reserva. */
  emProcessamento: number;
  /** DRAFT | REJECTED — só informa. */
  emRascunho: number;
  /** max(0, original − autorizada − emProcessamento); null quando original é null. */
  disponivel: number | null;
}

// ─────────────────────── Snapshot da origem e referências ───────────────────────

/** Item do XML autorizado da original (em NfeDevolucao.origensJson). */
export interface OrigemItemSnapshot {
  nItem: number;
  codigo: string;
  descricao: string;
  ncm: string;
  cest: string | null;
  unidade: string;
  cfop: string;
  quantidade: number;
  valorUnitario: number;
  valorProduto: number;
  desconto: number;
  origem: number | null;
  impostoOriginal: ImpostoOriginal;
}

export interface OrigemDevolucaoSnapshot {
  chaveAcesso: string;
  originalNfeId: string | null;
  modelo: string;
  /** nNF/série REAIS (da chave), nunca NfeEmitida.numero. */
  numero: number;
  serie: number;
  /** YYYY-MM-DD (data de emissão no Brasil). */
  dataEmissao: string | null;
  emitenteCnpjCpf: string;
  crtOriginal: string | null;
  idDest: IdDest;
  itens: OrigemItemSnapshot[];
}

/** Referência de um item da devolução (NfeDevolucaoItem em memória). */
export interface RefDevolucaoItem {
  /** 1..990 = NfeItem.numero da devolução = det@nItem da devolução. */
  ordem: number;
  originalNfeId: string | null;
  chaveAcessoOriginal: string;
  /** det@nItem do XML AUTORIZADO da original (nunca NfeItem.numero). */
  nItemOriginal: number;
  codigoOriginal: string;
  cfopOriginal: string | null;
  quantidadeOriginal: number | null;
  valorUnitarioOriginal: number | null;
  quantidade: number;
  valor: number;
  impostoOriginal: ImpostoOriginal | null;
  tributacao: TributacaoDevolucaoItem;
  cfopMapeamento: MapeamentoCfopDevolucao;
}

export type StatusNotaDevolucao = NfeStatus;
