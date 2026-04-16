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
  "DEVOLUÇÃO DE COMPRA",
  "REMESSA PARA CONSERTO",
  "REMESSA PARA DEMONSTRAÇÃO",
  "TRANSFERÊNCIA",
  "BONIFICAÇÃO",
  "BRINDE",
];

export const TIPO_OPERACAO_LABELS: Record<string, string> = {
  ENTRADA: "Entrada",
  SAIDA: "Saída",
};

export const FINALIDADE_LABELS: Record<string, string> = {
  NORMAL: "NF-e Normal",
  COMPLEMENTAR: "NF-e Complementar",
  AJUSTE: "NF-e de Ajuste",
  DEVOLUCAO: "NF-e de Devolução",
};

export const DESTINO_LABELS: Record<string, string> = {
  INTERNA: "Operação Interna",
  INTERESTADUAL: "Operação Interestadual",
  EXTERIOR: "Operação com Exterior",
};

export const IND_PRESENCA_LABELS: Record<string, string> = {
  NAO_SE_APLICA: "Não se aplica",
  PRESENCIAL: "Presencial",
  INTERNET: "Internet",
  TELEMARKETING: "Telemarketing",
  ENTREGA_DOMICILIO: "Entrega a domicílio",
  PRESENCIAL_FORA: "Presencial fora do estabelecimento",
  OUTROS: "Outros",
};

export const ORIGEM_LABELS: Record<number, string> = {
  0: "0 - Nacional",
  1: "1 - Estrangeira (importação direta)",
  2: "2 - Estrangeira (adquirida no mercado interno)",
  3: "3 - Nacional com conteúdo importado > 40%",
  4: "4 - Nacional (processos básicos)",
  5: "5 - Nacional com conteúdo importado ≤ 40%",
  6: "6 - Estrangeira (importação direta, sem similar)",
  7: "7 - Estrangeira (adquirida, sem similar)",
  8: "8 - Nacional com conteúdo importado > 70%",
};
