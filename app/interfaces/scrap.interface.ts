import { ScrapStatus } from "@prisma/client";

export type { ScrapStatus };

export interface Scrap {
  id: string;
  userId: string;

  // Dados do veículo
  brand: string;
  model: string;
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
  notes?: string;
}

export interface ScrapUpdate {
  brand?: string;
  model?: string;
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
  notes?: string;
}

export interface ScrapRepository {
  create(data: ScrapCreate): Promise<Scrap>;
  findById(id: string, userId?: string): Promise<Scrap | null>;
  findAll(
    options?: {
      search?: string;
      status?: ScrapStatus;
      page?: number;
      limit?: number;
    },
    userId?: string,
  ): Promise<{ scraps: Scrap[]; total: number }>;
  update(id: string, data: ScrapUpdate, userId?: string): Promise<Scrap>;
  delete(id: string, userId?: string): Promise<void>;
  count(userId?: string): Promise<number>;
}
