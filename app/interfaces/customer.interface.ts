export type Gender = "M" | "F" | "OUTRO";

export type PersonType = "PF" | "PJ";

export interface Customer {
  id: string;
  userId: string;

  personType: string;

  name: string;
  cpf: string | null;
  rg: string | null;
  birthDate: Date | null;
  gender: string | null;
  maritalStatus: string | null;

  cnpj: string | null;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  inscricaoEstadual: string | null;
  indicadorIE: string | null;

  email: string | null;
  phone: string | null;
  mobile: string | null;

  cep: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  ibge: string | null;
  reference: string | null;

  deliveryName: string | null;
  deliveryCorporateName: string | null;
  deliveryCpf: string | null;
  deliveryCnpj: string | null;
  deliveryRg: string | null;
  deliveryCep: string | null;
  deliveryPhone: string | null;
  deliveryCity: string | null;
  deliveryNeighborhood: string | null;
  deliveryState: string | null;
  deliveryStreet: string | null;
  deliveryComplement: string | null;
  deliveryNumber: string | null;

  notes: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerCreate {
  userId: string;

  personType?: string | null;

  name: string;
  cpf?: string | null;
  rg?: string | null;
  birthDate?: string | Date | null;
  gender?: string | null;
  maritalStatus?: string | null;

  cnpj?: string | null;
  razaoSocial?: string | null;
  nomeFantasia?: string | null;
  inscricaoEstadual?: string | null;
  indicadorIE?: string | null;

  email?: string | null;
  phone?: string | null;
  mobile?: string | null;

  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  ibge?: string | null;
  reference?: string | null;

  deliveryName?: string | null;
  deliveryCorporateName?: string | null;
  deliveryCpf?: string | null;
  deliveryCnpj?: string | null;
  deliveryRg?: string | null;
  deliveryCep?: string | null;
  deliveryPhone?: string | null;
  deliveryCity?: string | null;
  deliveryNeighborhood?: string | null;
  deliveryState?: string | null;
  deliveryStreet?: string | null;
  deliveryComplement?: string | null;
  deliveryNumber?: string | null;

  notes?: string | null;
}

export type CustomerUpdate = Partial<Omit<CustomerCreate, "userId">>;

export interface CustomerListFilters {
  search?: string;
  page?: number;
  limit?: number;
  /**
   * Só clientes cadastrados a partir desta data. Serve "quantos clientes
   * entraram esta semana?" sem trazer a base inteira para contar na memória.
   * Servido por `@@index([userId, createdAt])`.
   */
  createdFrom?: Date;
}

export interface CustomerListResult {
  customers: Customer[];
  total: number;
  totalPages: number;
}
