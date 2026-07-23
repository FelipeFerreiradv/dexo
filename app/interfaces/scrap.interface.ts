import { ScrapStatus, LogisticsStatus } from "@prisma/client";

export type { ScrapStatus, LogisticsStatus };

export interface Scrap {
  id: string;
  userId: string;

  // Dados do veículo
  brand: string;
  model: string;
  // Apelido do veículo (identificação humana no pátio) — aditivo.
  nickname?: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
  chassis?: string;
  engineNumber?: string;
  renavam?: string;
  lot?: string;
  deregistrationCert?: string;

  // Custo e pagamento
  cost?: number;
  extraCosts?: number;
  paymentMethod?: string;

  // Localização
  locationId?: string;
  locationCode?: string;

  // Dados fiscais / NF-e
  ncm?: string;
  supplierCnpj?: string;
  accessKey?: string;
  issueDate?: Date;
  entryDate?: Date;
  nfeNumber?: string;
  nfeProtocol?: string;
  operationNature?: string;
  nfeSeries?: string;
  fiscalModel?: string;
  icmsValue?: number;
  icmsCtValue?: number;
  freightMode?: string;
  issuePurpose?: string;

  // Imagens
  imageUrls: string[];

  // Status e controle
  status: ScrapStatus;
  logisticsStatus: LogisticsStatus;
  notes?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Contagem de produtos vinculados (para listagem)
  productsCount?: number;
}

export interface ScrapCreate {
  userId: string;

  brand: string;
  model: string;
  nickname?: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
  chassis?: string;
  engineNumber?: string;
  renavam?: string;
  lot?: string;
  deregistrationCert?: string;

  cost?: number;
  extraCosts?: number;
  paymentMethod?: string;

  locationId?: string;

  ncm?: string;
  supplierCnpj?: string;
  accessKey?: string;
  issueDate?: Date;
  entryDate?: Date;
  nfeNumber?: string;
  nfeProtocol?: string;
  operationNature?: string;
  nfeSeries?: string;
  fiscalModel?: string;
  icmsValue?: number;
  icmsCtValue?: number;
  freightMode?: string;
  issuePurpose?: string;

  imageUrls?: string[];

  status?: ScrapStatus;
  logisticsStatus?: LogisticsStatus;
  notes?: string;
}

export interface ScrapUpdate {
  brand?: string;
  model?: string;
  nickname?: string;
  year?: string;
  version?: string;
  color?: string;
  plate?: string;
  chassis?: string;
  engineNumber?: string;
  renavam?: string;
  lot?: string;
  deregistrationCert?: string;

  cost?: number;
  extraCosts?: number;
  paymentMethod?: string;

  locationId?: string | null;

  ncm?: string;
  supplierCnpj?: string;
  accessKey?: string;
  issueDate?: Date;
  entryDate?: Date;
  nfeNumber?: string;
  nfeProtocol?: string;
  operationNature?: string;
  nfeSeries?: string;
  fiscalModel?: string;
  icmsValue?: number;
  icmsCtValue?: number;
  freightMode?: string;
  issuePurpose?: string;

  imageUrls?: string[];

  status?: ScrapStatus;
  logisticsStatus?: LogisticsStatus;
  notes?: string;
}

export interface ScrapListOptions {
  search?: string;
  status?: ScrapStatus;
  logisticsStatus?: LogisticsStatus;
  page?: number;
  limit?: number;
}

// Resultado do pipeline (Kanban): contadores + amostra de cards por estágio,
// devolvidos num único request (sem N+1).
export interface ScrapPipelineStage {
  count: number;
  scraps: Scrap[];
}

export type ScrapPipeline = Record<LogisticsStatus, ScrapPipelineStage>;

// Saúde financeira de uma sucata (página de detalhe). Fontes confirmadas na
// Fase 0: investimento = cost + extraCosts; receita realizada = marketplace
// (OrderItem em Order PAID/SHIPPED/DELIVERED) + balcão (ReceivableItem em
// Receivable PAGA); potencial = price*stock das peças em estoque.
export interface ScrapFinancials {
  investment: number;
  realizedRevenue: { marketplace: number; counter: number; total: number };
  potentialRevenue: number;
  roi: number | null; // % — null quando o investimento é 0
}

export type ScrapPartStatus = "IN_STOCK" | "SOLD";

export interface ScrapPart {
  id: string;
  name: string;
  sku: string;
  partNumber?: string;
  price: number;
  stock: number;
  status: ScrapPartStatus;
  quality?: string;
  isSecurityItem: boolean;
  isTraceable: boolean;
  soldQuantity: number; // total vendido (marketplace + balcão)
}

// GET /scraps/:id enriquecido (campos opcionais, aditivos — só vêm quando
// solicitados via ?include=).
// Histórico de transições de estágio (diferencial F).
export interface ScrapStatusEventDTO {
  fromStatus: LogisticsStatus | null;
  toStatus: LogisticsStatus;
  createdAt: Date;
}

// Venda avulsa (item MANUAL, sem produto cadastrado) atribuída diretamente a
// esta sucata via ReceivableItem.scrapId. Display-only: a receita já entra em
// realizedRevenue.counter (getScrapMoney), aqui é só o detalhamento.
export interface ScrapManualSale {
  description: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface ScrapDetail extends Scrap {
  financials?: ScrapFinancials;
  products?: ScrapPart[];
  history?: ScrapStatusEventDTO[];
  manualSales?: ScrapManualSale[];
}

// Visão de Balcão: busca peça-cêntrica que devolve a peça + o lote de origem
// com seu estágio logístico (para o vendedor saber se já dá pra retirar).
export interface BalcaoPartSource {
  scrapId: string;
  brand: string;
  model: string;
  year?: string;
  plate?: string;
  logisticsStatus: LogisticsStatus;
}

export interface BalcaoPart {
  id: string;
  name: string;
  sku: string;
  partNumber?: string;
  price: number;
  stock: number;
  source: BalcaoPartSource | null;
}

export interface ScrapRepository {
  create(data: ScrapCreate): Promise<Scrap>;
  findById(id: string, userId?: string): Promise<Scrap | null>;
  findAll(
    options?: ScrapListOptions,
    userId?: string,
  ): Promise<{ scraps: Scrap[]; total: number }>;
  pipeline(userId: string): Promise<ScrapPipeline>;
  getScrapMoney(
    scrapId: string,
    userId: string,
  ): Promise<{ marketplace: number; counter: number; potential: number }>;
  getScrapParts(scrapId: string, userId: string): Promise<ScrapPart[]>;
  getScrapManualSales(
    scrapId: string,
    userId: string,
  ): Promise<ScrapManualSale[]>;
  findStagesByIds(
    ids: string[],
    userId: string,
  ): Promise<
    Array<{
      id: string;
      brand: string;
      model: string;
      year: string | null;
      plate: string | null;
      logisticsStatus: LogisticsStatus;
    }>
  >;
  recordStatusEvent(
    scrapId: string,
    userId: string,
    fromStatus: LogisticsStatus | null,
    toStatus: LogisticsStatus,
  ): Promise<void>;
  getStatusEvents(
    scrapId: string,
    userId: string,
  ): Promise<ScrapStatusEventDTO[]>;
  update(id: string, data: ScrapUpdate, userId?: string): Promise<Scrap>;
  updateLogisticsStatus(
    id: string,
    logisticsStatus: LogisticsStatus,
    userId?: string,
  ): Promise<Scrap>;
  delete(id: string, userId?: string): Promise<void>;
  count(userId?: string): Promise<number>;
}
