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
  // Baixa de estoque represada há mais de 24h porque o kill-switch da
  // integração (OLX/FACEBOOK_INTEGRATION_DISABLED) segue ligado. O job NÃO foi
  // perdido — continua PENDING e reprocessa quando o operador religar. Este
  // registro existe só para o adiamento deixar de ser silencioso.
  | "STOCK_SYNC_DEFERRED_TOO_LONG"
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
  | "ORDER_INGESTION_ISSUE_STUCK"
  // Pipeline de remoção de fundo (rembg). Gravados apenas com
  // IMAGE_PIPELINE_METRICS=1 (ver rembg-telemetry.ts). A taxa de fallback —
  // a métrica nº 1 do pipeline — é count(IMAGE_BG_FALLBACK) /
  // (count(IMAGE_BG_FALLBACK)+count(IMAGE_BG_REMOVED)) numa janela.
  | "IMAGE_BG_REMOVED"
  | "IMAGE_BG_FALLBACK"
  // Falha TERMINAL de um job assíncrono de recorte (worker — fase futura).
  | "IMAGE_BG_JOB_FAILED"
  // Alerta: taxa de fallback da última 1h acima do limiar (rembg-alert.service).
  | "IMAGE_FALLBACK_RATE_HIGH"
  // Rastro LGPD (PR 5): imagem do cliente saiu para o provedor EXTERNO de
  // recorte. SEMPRE gravado (não fica atrás de IMAGE_PIPELINE_METRICS).
  | "IMAGE_SENT_EXTERNAL"
  // Republicação de item User Product concluída, mas NÃO deu para confirmar
  // que o anúncio antigo ficou encerrado com estoque zero — ele pode seguir
  // somando unidades no agrupamento do painel do ML. Precisa de varredura do
  // Suporte. Ver SyncUseCase.closeOldUpListing.
  //
  // Não usar `ProductListing.lastError` para isto: aquele campo é o canal de
  // retry (prefixo [TERMINAL]) e é zerado a cada sucesso de sync, o que
  // apagaria o aviso. Mesma razão de `compatDiagnostics` existir separado.
  | "ML_UP_REPUBLISH_ORPHAN"
  // ---------------------------------------------------------------------
  // Bitz (agente de IA). ADITIVO: a coluna `action` no banco é String livre
  // (schema.prisma:783), então acrescentar aqui é mudança só de TypeScript —
  // sem migração. A UI de /logs faz fallback gracioso para a string crua
  // (logs-view.tsx:212), então nenhuma tela quebra com um valor novo.
  //
  // Todas gravadas com a COLUNA userId nula e o tenant em
  // `details.tenantUserId` — convenção de rembg-telemetry.ts:112-117, para
  // telemetria interna não poluir o /logs do cliente (que filtra por userId)
  // e ainda assim ser contável globalmente.
  // ---------------------------------------------------------------------
  | "AI_CHAT_TURN"
  | "AI_TOOL_CALL"
  | "AI_TOOL_DENIED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_PROVIDER_ERROR"
  // ⭐ A única ação do Bitz que ALTERA alguma coisa (Fase 9), e por isso a única
  // que fica no log geral como WARNING mesmo quando dá certo: é aqui que o
  // suporte procura ao responder "quem mexeu no preço dessa peça?". A trilha
  // detalhada vive em `AiAction`, que tem escopo de tenant.
  | "AI_ACTION";

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
