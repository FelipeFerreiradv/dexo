export type FinanceStatus = "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";
export type FinanceKind = "receivable" | "payable";

export interface FinanceEntry {
  id: string;
  userId: string;
  customerId: string;

  document: string | null;
  reason: string | null;
  debtDetails: string | null;
  totalAmount: number;

  fineAmount: number | null;
  finePercent: number | null;
  interestPercent: number | null;
  toleranceDays: number | null;

  installments: number;
  periodDays: number | null;
  dueDate: Date;

  status: FinanceStatus;
  paidAt: Date | null;

  createdAt: Date;
  updatedAt: Date;

  // join
  customer?: {
    id: string;
    name: string;
    cpf: string | null;
    email: string | null;
  } | null;
}

export interface FinanceEntryCreate {
  userId: string;
  customerId: string;

  document?: string | null;
  reason?: string | null;
  debtDetails?: string | null;
  totalAmount: number;

  fineAmount?: number | null;
  finePercent?: number | null;
  interestPercent?: number | null;
  toleranceDays?: number | null;

  installments?: number;
  periodDays?: number | null;
  dueDate: string | Date;

  status?: FinanceStatus;
  paidAt?: string | Date | null;
}

export type FinanceEntryUpdate = Partial<Omit<FinanceEntryCreate, "userId">>;

export interface FinanceListFilters {
  search?: string;
  status?: FinanceStatus;
  customerId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface FinanceListResult {
  items: FinanceEntry[];
  total: number;
  totalPages: number;
}

export interface FinanceSummary {
  receivables: {
    totalCount: number;
    totalAmount: number;
    overdueCount: number;
    overdueAmount: number;
    pendingAmount: number;
    paidAmount: number;
  };
  payables: {
    totalCount: number;
    totalAmount: number;
    overdueCount: number;
    overdueAmount: number;
    pendingAmount: number;
    paidAmount: number;
  };
}
