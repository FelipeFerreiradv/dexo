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
  // Não deu para ler a preferência `User.reopenListingsOnSaleCancel` e o sistema
  // assumiu LIGADO (comportamento de hoje). Existe porque fail-open SILENCIOSO
  // seria inaceitável: o cliente que DESLIGOU veria o anúncio reabrir sem
  // nenhum rastro de por quê. Ver app/services/reopen-listings-preference.ts.
  | "REOPEN_PREFERENCE_READ_FAILED"
  // Remediação do PASSIVO: anúncio que voltou ao ar por um cancelamento
  // enquanto a preferência já estava DESLIGADA, e que foi pausado de volta
  // pelo script scripts/audit-reopen-off-relisted.ts --apply. Ação manual e
  // rara, mas que altera o que o comprador vê — por isso deixa rastro.
  | "REOPEN_OFF_RELISTED_REMEDIATED"
  | "ORDER_UNCANCEL_REDEDUCT"
  | "MAGALU_CANCEL_DETECTED"
  // O marketplace encerrou o pedido, mas a peça NÃO está no pátio — e o estorno
  // de estoque foi RETIDO por isso. O ML usa o mesmo `status: "cancelled"` para
  // cancelamento antes do envio (peça no pátio, estorno correto) e para
  // devolução depois da entrega (peça com o comprador); só `cancel_detail` +
  // o envio separam os dois. O pedido continua sendo marcado CANCELLED: o que
  // NÃO acontece é o `+1` e a reabertura do anúncio. `details` carrega a
  // evidência (group/code/status do envio) para a decisão ser auditável.
  // Ver OrderOutcomeService e OrderUseCase.processOrderCancellation.
  | "ORDER_RETURN_HOLD"
  // O operador confirmou que a peça devolvida chegou ao pátio: `+1` com reason
  // própria ("Devolução recebida ...", nunca "Estorno venda ...", que
  // envenenaria o net do cancelamento) e o anúncio reabre pelo caminho normal,
  // respeitando `reopenListingsOnSaleCancel`. É a única forma de o estoque
  // voltar depois de uma devolução — nenhuma rotina decide isso sozinha.
  | "ORDER_RETURN_RESTOCKED"
  // O operador declarou que a peça NÃO volta (o comprador ficou com ela, o
  // marketplace bancou o prejuízo, ou extraviou). Estoque permanece 0 e o
  // anúncio permanece fora. Não mexe em estoque — a peça já estava baixada
  // desde a venda; este registro existe para o desfecho não ser esquecido.
  | "ORDER_RETURN_WRITTEN_OFF"
  // O marketplace desfez a devolução e manteve a venda (o dinheiro ficou com o
  // vendedor). A pendência fecha como VENDA_MANTIDA e, se o estoque já tinha
  // voltado, ele é re-baixado pelo net do StockLog — nunca duas vezes.
  // Ver OrderReturnPendencyReconcilerService.
  | "ORDER_RETURN_SALE_REINSTATED"
  // Remediação do PASSIVO: peça cujo estoque voltou por um estorno de
  // devolução indevido e que foi zerada + pausada em todos os canais pelo
  // script scripts/audit-estoque-fantasma-devolucao.ts --apply. Altera o que o
  // comprador vê e desfaz um `+1` já commitado — por isso deixa rastro.
  | "RETURN_PHANTOM_STOCK_REMEDIATED"
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
  | "ML_UP_REPUBLISH_ORPHAN";

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
