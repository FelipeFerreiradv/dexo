// Orçamento (BLOCO 1). Espelha finance.interface.ts (Receivable) — mesma forma
// de itens e de cliente rápido —, mas SEM encargos/parcelamento/dueDate. Modelo
// aditivo e isolado: não importa nem altera nenhum tipo de finance.

export type BudgetStatus = "ABERTO" | "CONVERTIDO" | "EXPIRADO" | "CANCELADO";

// Item do orçamento. Mesma forma do ReceivableItemInput (cadastrado OU manual).
export interface BudgetItemInput {
  // Item CADASTRADO: productId setado, description null.
  // Item MANUAL: productId null, description setada (texto livre).
  productId?: string | null;
  description?: string | null;
  // Sucata de origem (override explícito; precede Product.scrapId).
  scrapId?: string | null;
  listingId?: string | null;
  quantity: number;
  unitPrice: number; // snapshot
}

export interface BudgetItemSnapshot extends BudgetItemInput {
  id: string;
  product?: { id: string; sku: string; name: string } | null;
  createdAt?: Date;
}

// Cadastro rápido de cliente — CPF-only, opcional (igual ao do balcão).
export interface BudgetNewCustomerInput {
  name: string;
  cpf?: string | null;
}

export interface Budget {
  id: string;
  userId: string;
  customerId: string;
  // Vendedor atribuído (colaborador ou o próprio admin). null = sem vendedor.
  vendedorId: string | null;

  document: string | null;
  reason: string | null;
  notes: string | null;
  totalAmount: number;

  status: BudgetStatus;
  validUntil: Date | null;

  // Conta a receber gerada na conversão (quando CONVERTIDO).
  receivableId: string | null;

  createdAt: Date;
  updatedAt: Date;

  // joins (mesma projeção leve do finance)
  customer?: {
    id: string;
    name: string;
    cpf: string | null;
    email: string | null;
  } | null;
  unidade?: {
    id: string;
    name: string;
  } | null;
  vendedor?: {
    id: string;
    name: string | null;
    email: string;
  } | null;

  // Itens — ausente quando não incluído (lista é egress-light, igual ao finance).
  items?: BudgetItemSnapshot[];
}

export interface BudgetCreate {
  userId: string;
  customerId: string;
  // Quando presente, cria o cliente na MESMA transação (atômico). Mesma
  // semântica do quick-create do balcão.
  newCustomer?: BudgetNewCustomerInput;
  unidadeId?: string | null;
  // Vendedor atribuído (colaborador/admin). Validado no usecase (deve pertencer
  // à equipe do dono). Opcional/nulável.
  vendedorId?: string | null;

  document?: string | null;
  reason?: string | null;
  notes?: string | null;
  totalAmount: number;

  // Data de validade do orçamento (string ISO/"YYYY-MM-DD" ou Date). Opcional.
  validUntil?: string | Date | null;

  items?: BudgetItemInput[];
}

export type BudgetUpdate = Partial<Omit<BudgetCreate, "userId">>;

export interface BudgetListFilters {
  search?: string;
  status?: BudgetStatus;
  customerId?: string;
  // undefined/"" = todas; "sem_unidade" = unidadeId NULL; outro = aquela unidade.
  unidadeId?: string;
  // Filtro por vendedor. "sem_vendedor" = vendedorId NULL; outro = aquele vendedor.
  vendedorId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface BudgetListResult {
  items: Budget[];
  total: number;
  totalPages: number;
}
