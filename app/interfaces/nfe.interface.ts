import type {
  NfeStatus,
  FiscalAmbiente,
  TipoOperacao,
  FinalidadeNfe,
  DestinoOperacao,
  ModalidadeFrete,
  IndicadorPresenca,
  MeioPagamento,
  OrigemMercadoria,
  CstPisCofins,
  NfeItemTributos,
  NfeTotais,
} from "../fiscal/domain/nfe.types";

// ── Destinatário (snapshot imutável) ──

export interface NfeDestinatario {
  tipoPessoa: "PF" | "PJ" | "EXTERIOR";
  cpfCnpj: string;
  nome: string;
  inscricaoEstadual?: string | null;
  email?: string | null;
  telefone?: string | null;
  // endereço
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  codMunicipio?: string | null;
  uf?: string | null;
  codPais?: string | null;
  pais?: string | null;
}

// ── Item da NFe ──

export interface NfeDraftItem {
  id?: string;
  productId?: string | null;
  numero: number;
  codigo: string;
  descricao: string;
  ncm: string;
  cfop: string;
  cest?: string | null;
  origem: OrigemMercadoria;
  unidade: string;
  quantidade: number;
  valorUnitario: number;
  valorTotal: number;
  desconto?: number | null;
  observacoes?: string | null;
  // campos fiscais para cálculo
  cstIcms?: string | null;
  cstPis?: CstPisCofins | null;
  cstCofins?: CstPisCofins | null;
  aliquotaIcms?: number | null;
  aliquotaIpi?: number | null;
  aliquotaPis?: number | null;
  aliquotaCofins?: number | null;
  reducaoBcIcms?: number | null;
  tributosJson?: NfeItemTributos | null;
}

// ── Payload para criar / atualizar rascunho ──

export interface NfeDraftCreateInput {
  orderId?: string | null;
  customerId?: string | null;
}

export interface NfeDraftUpdateInput {
  // Step 1 — Informações gerais
  serie?: number;
  tipoOperacao?: TipoOperacao;
  finalidade?: FinalidadeNfe;
  destinoOperacao?: DestinoOperacao;
  naturezaOperacao?: string;
  indPresenca?: IndicadorPresenca;
  intermediador?: string | null;
  numeroPedido?: string | null;
  dataEmissao?: string | null;
  dataSaida?: string | null;
  notasReferenciadasJson?: any | null;
  exportacaoJson?: any | null;

  // Step 2 — Destinatário
  destinatarioJson?: NfeDestinatario | null;
  customerId?: string | null;

  // Step 3 — Produtos
  itens?: NfeDraftItem[];

  // Steps 4+ (preparado, implementado em F4)
  modalidadeFrete?: ModalidadeFrete | null;
  transportadoraJson?: any | null;
  volumesJson?: any | null;
  duplicatasJson?: any | null;
  pagamentosJson?: any | null;
  totaisJson?: NfeTotais | null;
}

// ── Resposta do rascunho (GET / POST / PUT) ──

export interface NfeDraftResponse {
  id: string;
  userId: string;
  orderId: string | null;
  customerId: string | null;
  ambiente: FiscalAmbiente;
  modelo: string;
  serie: number;
  numero: number;
  chaveAcesso: string | null;
  tipoOperacao: TipoOperacao;
  finalidade: FinalidadeNfe;
  destinoOperacao: DestinoOperacao;
  naturezaOperacao: string;
  indPresenca: IndicadorPresenca;
  intermediador: string | null;
  numeroPedido: string | null;
  dataEmissao: Date | null;
  dataSaida: Date | null;
  destinatarioJson: NfeDestinatario | null;
  emitenteJson: any | null;
  modalidadeFrete: string | null;
  transportadoraJson: any | null;
  totaisJson: NfeTotais | null;
  notasReferenciadasJson: any | null;
  exportacaoJson: any | null;
  pagamentosJson: any | null;
  duplicatasJson: any | null;
  volumesJson: any | null;
  status: NfeStatus;
  createdAt: Date;
  updatedAt: Date;
  itens: NfeDraftItem[];
}

// ── Lookup results ──

export interface CustomerLookup {
  id: string;
  name: string;
  cpf: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  // PJ fields
  deliveryCnpj: string | null;
  deliveryCorporateName: string | null;
  // Address
  cep: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  ibge: string | null;
}

export interface ProductLookup {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
}
