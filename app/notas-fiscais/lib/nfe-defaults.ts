import type { NfeDraftFormData } from "./nfe-form-schema";

export const DEFAULT_NFE_DRAFT: NfeDraftFormData = {
  // Step 1
  serie: 1,
  tipoOperacao: "SAIDA",
  finalidade: "NORMAL",
  destinoOperacao: "INTERNA",
  naturezaOperacao: "VENDA DE MERCADORIA",
  indPresenca: "NAO_SE_APLICA",
  intermediador: null,
  numeroPedido: null,
  dataEmissao: null,
  dataSaida: null,

  // Step 2
  customerId: null,
  destinatario: {
    tipoPessoa: "PF",
    cpfCnpj: "",
    nome: "",
    inscricaoEstadual: null,
    email: null,
    telefone: null,
    cep: null,
    logradouro: null,
    numero: null,
    complemento: null,
    bairro: null,
    municipio: null,
    codMunicipio: null,
    uf: null,
    codPais: "1058",
    pais: "BRASIL",
  },

  // Step 3
  itens: [],

  // Step 4
  modalidadeFrete: "SEM_FRETE",
  transportadora: {
    cpfCnpj: null,
    nome: null,
    inscricaoEstadual: null,
    endereco: null,
    municipio: null,
    uf: null,
  },

  // Step 5
  volumes: [],

  // Step 6
  duplicatas: [],

  // Step 7
  pagamentos: [{ meio: "DINHEIRO", valor: 0 }],
};

export const EMPTY_NFE_ITEM = {
  productId: null,
  numero: 1,
  codigo: "",
  descricao: "",
  ncm: "",
  cfop: "5102",
  cest: null,
  origem: 0 as const,
  unidade: "UN",
  quantidade: 1,
  valorUnitario: 0,
  valorTotal: 0,
  desconto: null,
  observacoes: null,
};

export const NATUREZA_OPERACAO_OPTIONS = [
  "VENDA DE MERCADORIA",
  "VENDA DE PRODUTO",
  "DEVOLUCAO DE COMPRA",
  "REMESSA PARA CONSERTO",
  "REMESSA PARA DEMONSTRACAO",
  "TRANSFERENCIA",
  "BONIFICACAO",
  "BRINDE",
];

export const TIPO_OPERACAO_LABELS: Record<string, string> = {
  ENTRADA: "Entrada",
  SAIDA: "Saida",
};

export const FINALIDADE_LABELS: Record<string, string> = {
  NORMAL: "NF-e Normal",
  COMPLEMENTAR: "NF-e Complementar",
  AJUSTE: "NF-e de Ajuste",
  DEVOLUCAO: "NF-e de Devolucao",
};

export const DESTINO_LABELS: Record<string, string> = {
  INTERNA: "Operacao Interna",
  INTERESTADUAL: "Operacao Interestadual",
  EXTERIOR: "Operacao com Exterior",
};

export const IND_PRESENCA_LABELS: Record<string, string> = {
  NAO_SE_APLICA: "Nao se aplica",
  PRESENCIAL: "Presencial",
  INTERNET: "Internet",
  TELEMARKETING: "Telemarketing",
  ENTREGA_DOMICILIO: "Entrega a domicilio",
  PRESENCIAL_FORA: "Presencial fora do estabelecimento",
  OUTROS: "Outros",
};

export const ORIGEM_LABELS: Record<number, string> = {
  0: "0 - Nacional",
  1: "1 - Estrangeira (importacao direta)",
  2: "2 - Estrangeira (adquirida no mercado interno)",
  3: "3 - Nacional com conteudo importado > 40%",
  4: "4 - Nacional (processos basicos)",
  5: "5 - Nacional com conteudo importado <= 40%",
  6: "6 - Estrangeira (importacao direta, sem similar)",
  7: "7 - Estrangeira (adquirida, sem similar)",
  8: "8 - Nacional com conteudo importado > 70%",
};

export const MODALIDADE_FRETE_LABELS: Record<string, string> = {
  CIF: "0 - Por conta do remetente (CIF)",
  FOB: "1 - Por conta do destinatario (FOB)",
  TERCEIROS: "2 - Por conta de terceiros",
  PROPRIO_REMETENTE: "3 - Proprio por conta do remetente",
  PROPRIO_DESTINATARIO: "4 - Proprio por conta do destinatario",
  SEM_FRETE: "9 - Sem frete",
};

export const MEIO_PAGAMENTO_LABELS: Record<string, string> = {
  DINHEIRO: "Dinheiro",
  CHEQUE: "Cheque",
  CARTAO_CREDITO: "Cartao de Credito",
  CARTAO_DEBITO: "Cartao de Debito",
  CREDITO_LOJA: "Credito Loja",
  VALE_ALIMENTACAO: "Vale Alimentacao",
  VALE_REFEICAO: "Vale Refeicao",
  VALE_PRESENTE: "Vale Presente",
  VALE_COMBUSTIVEL: "Vale Combustivel",
  BOLETO: "Boleto Bancario",
  DEPOSITO: "Deposito Bancario",
  PIX: "PIX",
  TRANSFERENCIA: "Transferencia Bancaria",
  SEM_PAGAMENTO: "Sem Pagamento",
  OUTROS: "Outros",
};

export const ESPECIE_VOLUME_OPTIONS = [
  "CAIXA",
  "PACOTE",
  "VOLUME",
  "FARDO",
  "SACO",
  "ROLO",
  "PALLET",
  "ENVELOPE",
  "OUTROS",
];
