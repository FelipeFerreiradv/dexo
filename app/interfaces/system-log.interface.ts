// --- Sistema de Logs do Sistema ---
export type LogLevel = "INFO" | "WARNING" | "ERROR";

export type LogAction =
  | "LOGIN"
  | "LOGOUT"
  | "CREATE_PRODUCT"
  | "UPDATE_PRODUCT"
  | "DELETE_PRODUCT"
  | "CREATE_ORDER"
  | "UPDATE_ORDER"
  | "CREATE_LISTING"
  | "UPDATE_LISTING"
  | "DELETE_LISTING"
  | "DELETE_LISTING_FAILED"
  | "CREATE_NFE_DRAFT"
  | "UPDATE_NFE_DRAFT"
  | "DELETE_NFE_DRAFT"
  | "EMIT_NFE"
  | "CANCEL_NFE"
  | "INUTILIZE_NFE"
  | "UPDATE_FISCAL_CONFIG"
  | "CREATE_CUSTOMER"
  | "UPDATE_CUSTOMER"
  | "DELETE_CUSTOMER"
  | "CREATE_LOCATION"
  | "UPDATE_LOCATION"
  | "DELETE_LOCATION"
  | "CREATE_SCRAP"
  | "UPDATE_SCRAP"
  | "DELETE_SCRAP"
  | "CREATE_PAYABLE"
  | "UPDATE_PAYABLE"
  | "DELETE_PAYABLE"
  | "CREATE_RECEIVABLE"
  | "UPDATE_RECEIVABLE"
  | "DELETE_RECEIVABLE"
  | "SYNC_STOCK"
  | "SYNC_ORDERS"
  | "CONNECT_MARKETPLACE"
  | "DISCONNECT_MARKETPLACE"
  | "SYSTEM_ERROR"
  | "USER_ACTIVITY"
  | "OVERSELL_DETECTED"
  | "STOCK_SYNC_FAILED"
  // Um único movimento levou um produto MULTI-UNIDADE (previousStock > 1) a
  // estoque zero. A aritmética de venda é decremental e nunca faz isso quando
  // a quantidade vendida é menor que o estoque; então este registro aponta ou
  // uma venda que realmente levou todo o saldo, ou um caminho de zeragem
  // indevida (ver scripts/balcao-stock-fix.ts). Observabilidade: NÃO altera o
  // cálculo do estoque (ver StockDeductionService).
  | "STOCK_ZEROED_IN_ONE_MOVE"
  | "WEBHOOK_ACCOUNT_NOT_FOUND"
  | "TOKEN_EXPIRED_REPEATED"
  | "ML_REACTIVATION_RISK"
  // Listing que apontava para a conta errada e foi reapontado para a conta
  // correta do mesmo tenant. Já era emitido por
  // SystemLogService.logListingOwnershipRepaired, mas faltava no union — o
  // próprio helper não compilava. Ver listing-ownership-repair.service (ML) e
  // o resgate cross-account do import Shopee.
  | "LISTING_OWNERSHIP_REPAIRED"
  // Cancelamento de pedido marketplace: estorno de estoque + reabertura de
  // anúncios (ver OrderUseCase.processOrderCancellation).
  | "ORDER_CANCEL_RESTORE"
  | "ORDER_CANCEL_RESTORE_FAILED"
  | "ORDER_UNCANCEL_REDEDUCT"
  | "MAGALU_CANCEL_DETECTED"
  // Auto-cadastro de Customer a partir de venda de marketplace
  // (ver OrderCustomerService.ensureCustomerForOrder).
  | "ORDER_AUTO_CUSTOMER"
  // Job de importação de dados legados (Superadmin). O registro carrega o
  // estado/relatório do job em `details` (ver app/usecases/import/).
  | "IMPORT_JOB"
  // Quarentena de ingestão de pedido: a API do marketplace devolveu um pedido
  // que não pôde ser totalmente ingerido (item sem vínculo, baixa que falhou,
  // busca que falhou). Antes isso era um `continue` mudo e a venda sumia sem
  // deixar rastro. Ver OrderIngestionIssueService.
  | "ORDER_INGESTION_ISSUE"
  | "ORDER_INGESTION_ISSUE_RESOLVED"
  // O reconciliador esgotou as tentativas e a pendência continua aberta —
  // precisa de ação humana (normalmente vincular o anúncio a um produto).
  | "ORDER_INGESTION_ISSUE_STUCK";

export interface SystemLog {
  id: string;
  userId?: string;
  user?: {
    id: string;
    name?: string;
    email: string;
  };
  action: LogAction;
  resource?: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
  level: LogLevel;
  message: string;
  createdAt: Date;
}

export interface SystemLogCreate {
  userId?: string;
  action: LogAction;
  resource?: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
  level?: LogLevel;
  message: string;
}

export interface SystemLogFilters {
  userId?: string;
  /**
   * Escopo multi-tenant: quando presente, restringe os logs aos `userId` da
   * lista (dono + colaboradores). Tem precedência sobre `userId`. Lista vazia
   * = nenhum resultado (fail-closed). Usado para isolar logs por tenant.
   */
  userIds?: string[];
  action?: LogAction;
  resource?: string;
  level?: LogLevel;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}

export interface SystemLogResponse {
  logs: SystemLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
