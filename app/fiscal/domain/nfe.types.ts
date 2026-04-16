// ── Enums e tipos do domínio fiscal NF-e modelo 55 ──

export type NfeStatus =
  | "DRAFT"
  | "VALIDATING"
  | "SIGNING"
  | "SENDING"
  | "AUTHORIZED"
  | "REJECTED"
  | "CANCELLED"
  | "INUTILIZED";

export type FiscalAmbiente = "HOMOLOGACAO" | "PRODUCAO";

export type TipoOperacao = "ENTRADA" | "SAIDA";

export type FinalidadeNfe = "NORMAL" | "COMPLEMENTAR" | "AJUSTE" | "DEVOLUCAO";

export type DestinoOperacao = "INTERNA" | "INTERESTADUAL" | "EXTERIOR";

export type RegimeTributario = "SIMPLES" | "LUCRO_PRESUMIDO" | "LUCRO_REAL";

export type ModalidadeFrete =
  | "CIF" // 0 - Contratação do Frete por conta do Remetente
  | "FOB" // 1 - Contratação do Frete por conta do Destinatário
  | "TERCEIROS" // 2 - Contratação por conta de Terceiros
  | "PROPRIO_REMETENTE" // 3 - Transporte Próprio por conta do Remetente
  | "PROPRIO_DESTINATARIO" // 4 - Transporte Próprio por conta do Destinatário
  | "SEM_FRETE"; // 9 - Sem Ocorrência de Transporte

export type IndicadorPresenca =
  | "NAO_SE_APLICA" // 0
  | "PRESENCIAL" // 1
  | "INTERNET" // 2
  | "TELEMARKETING" // 3
  | "ENTREGA_DOMICILIO" // 4
  | "PRESENCIAL_FORA" // 5
  | "OUTROS"; // 9

export type MeioPagamento =
  | "DINHEIRO" // 01
  | "CHEQUE" // 02
  | "CARTAO_CREDITO" // 03
  | "CARTAO_DEBITO" // 04
  | "CREDITO_LOJA" // 05
  | "VALE_ALIMENTACAO" // 10
  | "VALE_REFEICAO" // 11
  | "VALE_PRESENTE" // 12
  | "VALE_COMBUSTIVEL" // 13
  | "BOLETO" // 15
  | "DEPOSITO" // 16
  | "PIX" // 17
  | "TRANSFERENCIA" // 18
  | "SEM_PAGAMENTO" // 90
  | "OUTROS"; // 99

// Mapa meio de pagamento → código SEFAZ
export const MEIO_PAGAMENTO_COD: Record<MeioPagamento, string> = {
  DINHEIRO: "01",
  CHEQUE: "02",
  CARTAO_CREDITO: "03",
  CARTAO_DEBITO: "04",
  CREDITO_LOJA: "05",
  VALE_ALIMENTACAO: "10",
  VALE_REFEICAO: "11",
  VALE_PRESENTE: "12",
  VALE_COMBUSTIVEL: "13",
  BOLETO: "15",
  DEPOSITO: "16",
  PIX: "17",
  TRANSFERENCIA: "18",
  SEM_PAGAMENTO: "90",
  OUTROS: "99",
};

// Mapa indicador presença → código SEFAZ
export const IND_PRESENCA_COD: Record<IndicadorPresenca, string> = {
  NAO_SE_APLICA: "0",
  PRESENCIAL: "1",
  INTERNET: "2",
  TELEMARKETING: "3",
  ENTREGA_DOMICILIO: "4",
  PRESENCIAL_FORA: "5",
  OUTROS: "9",
};

// Mapa modalidade frete → código SEFAZ
export const MODALIDADE_FRETE_COD: Record<ModalidadeFrete, string> = {
  CIF: "0",
  FOB: "1",
  TERCEIROS: "2",
  PROPRIO_REMETENTE: "3",
  PROPRIO_DESTINATARIO: "4",
  SEM_FRETE: "9",
};

// Mapa finalidade → código SEFAZ
export const FINALIDADE_NFE_COD: Record<FinalidadeNfe, string> = {
  NORMAL: "1",
  COMPLEMENTAR: "2",
  AJUSTE: "3",
  DEVOLUCAO: "4",
};

// Mapa destino → código SEFAZ
export const DESTINO_OPERACAO_COD: Record<DestinoOperacao, string> = {
  INTERNA: "1",
  INTERESTADUAL: "2",
  EXTERIOR: "3",
};

// ── Origem da mercadoria (CST de origem) ──
export type OrigemMercadoria = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

// ── CSTs de ICMS para regime normal ──
export type CstIcms =
  | "00" | "10" | "20" | "30" | "40" | "41" | "50" | "51"
  | "60" | "70" | "80" | "90";

// ── CSOSNs para Simples Nacional ──
export type Csosn =
  | "101" | "102" | "103" | "201" | "202" | "203"
  | "300" | "400" | "500" | "900";

// ── CSTs PIS/COFINS ──
export type CstPisCofins =
  | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09"
  | "49" | "50" | "51" | "52" | "53" | "54" | "55" | "56" | "60"
  | "61" | "62" | "63" | "64" | "65" | "66" | "67" | "70" | "71"
  | "72" | "73" | "74" | "75" | "98" | "99";

// ── Transições válidas da máquina de estados ──
export const NFE_TRANSITIONS: Record<NfeStatus, NfeStatus[]> = {
  DRAFT: ["VALIDATING"],
  VALIDATING: ["SIGNING", "DRAFT"],
  SIGNING: ["SENDING", "DRAFT"],
  SENDING: ["AUTHORIZED", "REJECTED", "DRAFT"],
  AUTHORIZED: ["CANCELLED"],
  REJECTED: ["DRAFT"],
  CANCELLED: [],
  INUTILIZED: [],
};

export function canTransition(from: NfeStatus, to: NfeStatus): boolean {
  return NFE_TRANSITIONS[from].includes(to);
}

// ── Input/output do FiscalCalculator ──

export interface NfeItemInput {
  quantidade: number;
  valorUnitario: number;
  desconto: number;
  ncm: string;
  cfop: string;
  origem: OrigemMercadoria;
  /** CST ICMS (regime normal) ou CSOSN (Simples) */
  cstIcms: string;
  cstPis: CstPisCofins;
  cstCofins: CstPisCofins;
  // Alíquotas override (se null → regras padrão)
  aliquotaIcms: number | null;
  aliquotaIpi: number | null;
  aliquotaPis: number | null;
  aliquotaCofins: number | null;
  reducaoBcIcms: number | null;
}

export interface NfeItemTributos {
  // Base de cálculo e valor do ICMS
  bcIcms: number;
  valorIcms: number;
  aliquotaIcms: number;
  // IPI
  bcIpi: number;
  valorIpi: number;
  aliquotaIpi: number;
  // PIS
  bcPis: number;
  valorPis: number;
  aliquotaPis: number;
  // COFINS
  bcCofins: number;
  valorCofins: number;
  aliquotaCofins: number;
  // Valor total do item com impostos
  valorTotalTributos: number;
}

export interface NfeTotais {
  // Produtos
  totalProdutos: number;
  totalDesconto: number;
  // ICMS
  totalBcIcms: number;
  totalIcms: number;
  // IPI
  totalBcIpi: number;
  totalIpi: number;
  // PIS
  totalPis: number;
  // COFINS
  totalCofins: number;
  // Nota
  totalNota: number;
  totalTributos: number;
}

export interface CalculoNfeResult {
  itens: NfeItemTributos[];
  totais: NfeTotais;
}
