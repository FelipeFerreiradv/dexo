import { SystemLogRepository } from "../repositories/system-log.repository";
import {
  SystemLogCreate,
  LogAction,
  LogLevel,
} from "../interfaces/system-log.interface";

/**
 * Serviço para logging do sistema
 * Centraliza todas as operações de log da aplicação
 */
export class SystemLogService {
  /**
   * Registra um log de informação
   */
  static async logInfo(
    action: LogAction,
    message: string,
    options: {
      userId?: string;
      resource?: string;
      resourceId?: string;
      details?: any;
      ipAddress?: string;
      userAgent?: string;
    } = {},
  ) {
    return this.log({
      ...options,
      action,
      level: "INFO",
      message,
    });
  }

  /**
   * Registra um log de aviso
   */
  static async logWarning(
    action: LogAction,
    message: string,
    options: {
      userId?: string;
      resource?: string;
      resourceId?: string;
      details?: any;
      ipAddress?: string;
      userAgent?: string;
    } = {},
  ) {
    return this.log({
      ...options,
      action,
      level: "WARNING",
      message,
    });
  }

  /**
   * Registra um log de erro
   */
  static async logError(
    action: LogAction,
    message: string,
    options: {
      userId?: string;
      resource?: string;
      resourceId?: string;
      details?: any;
      ipAddress?: string;
      userAgent?: string;
    } = {},
  ) {
    return this.log({
      ...options,
      action,
      level: "ERROR",
      message,
    });
  }

  /**
   * Registra um log genérico
   */
  static async log(data: SystemLogCreate) {
    try {
      return await SystemLogRepository.create(data);
    } catch (error) {
      // Em caso de erro no logging, não queremos quebrar a aplicação
      // Apenas logamos no console como fallback
      console.error("[SystemLogService] Erro ao registrar log:", error);
      console.log("[SystemLogService] Tentativa de log:", data);
    }
  }

  /**
   * Logs específicos para ações comuns
   */

  // Autenticação
  static async logLogin(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    return this.logInfo("LOGIN", "Usuário fez login no sistema", {
      userId,
      ipAddress,
      userAgent,
    });
  }

  static async logLogout(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    return this.logInfo("LOGOUT", "Usuário fez logout do sistema", {
      userId,
      ipAddress,
      userAgent,
    });
  }

  // Produtos
  static async logProductCreate(
    userId: string,
    productId: string,
    productData: any,
  ) {
    return this.logInfo(
      "CREATE_PRODUCT",
      `Produto criado: ${productData.name}`,
      {
        userId,
        resource: "Product",
        resourceId: productId,
        details: { productData },
      },
    );
  }

  static async logProductUpdate(
    userId: string,
    productId: string,
    changes: any,
  ) {
    return this.logInfo("UPDATE_PRODUCT", "Produto atualizado", {
      userId,
      resource: "Product",
      resourceId: productId,
      details: { changes },
    });
  }

  static async logProductDelete(
    userId: string,
    productId: string,
    productName: string,
  ) {
    return this.logWarning(
      "DELETE_PRODUCT",
      `Produto excluído: ${productName}`,
      {
        userId,
        resource: "Product",
        resourceId: productId,
      },
    );
  }

  // Pedidos
  static async logOrderCreate(
    orderId: string,
    marketplace: string,
    orderData: any,
  ) {
    return this.logInfo(
      "CREATE_ORDER",
      `Novo pedido criado no ${marketplace}`,
      {
        resource: "Order",
        resourceId: orderId,
        details: { marketplace, orderData },
      },
    );
  }

  // Anúncios
  static async logListingCreate(
    userId: string,
    listingId: string,
    productId: string,
    marketplace: string,
  ) {
    return this.logInfo("CREATE_LISTING", `Anúncio criado no ${marketplace}`, {
      userId,
      resource: "ProductListing",
      resourceId: listingId,
      details: { productId, marketplace },
    });
  }

  // Sincronizações
  static async logSyncStart(
    userId: string,
    syncType: string,
    marketplace: string,
  ) {
    return this.logInfo(
      "SYNC_STOCK",
      `Sincronização iniciada: ${syncType} - ${marketplace}`,
      {
        userId,
        resource: "Sync",
        details: { syncType, marketplace },
      },
    );
  }

  static async logSyncComplete(
    userId: string,
    syncType: string,
    marketplace: string,
    results: any,
  ) {
    return this.logInfo(
      "SYNC_STOCK",
      `Sincronização concluída: ${syncType} - ${marketplace}`,
      {
        userId,
        resource: "Sync",
        details: { syncType, marketplace, results },
      },
    );
  }

  static async logSyncError(
    userId: string,
    syncType: string,
    marketplace: string,
    error: string,
  ) {
    return this.logError(
      "SYNC_STOCK",
      `Erro na sincronização: ${syncType} - ${marketplace}`,
      {
        userId,
        resource: "Sync",
        details: { syncType, marketplace, error },
      },
    );
  }

  // Marketplace
  static async logMarketplaceConnect(
    userId: string,
    marketplace: string,
    accountId: string,
  ) {
    return this.logInfo("CONNECT_MARKETPLACE", `Conectado ao ${marketplace}`, {
      userId,
      resource: "MarketplaceAccount",
      resourceId: accountId,
      details: { marketplace },
    });
  }

  static async logMarketplaceDisconnect(
    userId: string,
    marketplace: string,
    accountId: string,
  ) {
    return this.logWarning(
      "DISCONNECT_MARKETPLACE",
      `Desconectado do ${marketplace}`,
      {
        userId,
        resource: "MarketplaceAccount",
        resourceId: accountId,
        details: { marketplace },
      },
    );
  }

  // Sistema
  static async logSystemError(error: string, details?: any) {
    return this.logError("SYSTEM_ERROR", `Erro do sistema: ${error}`, {
      details,
    });
  }

  static async logUserActivity(
    userId: string,
    activity: string,
    details?: any,
  ) {
    return this.logInfo("USER_ACTIVITY", activity, {
      userId,
      details,
    });
  }

  /**
   * Busca logs do sistema com filtros e paginação
   */
  static async getLogs(options: {
    page?: number;
    limit?: number;
    filters?: {
      userId?: string;
      action?: LogAction;
      resource?: string;
      level?: LogLevel;
      startDate?: Date;
      endDate?: Date;
      search?: string;
    };
  }) {
    const { page = 1, limit = 20, filters = {} } = options;

    return SystemLogRepository.findMany({
      userId: filters.userId,
      action: filters.action,
      resource: filters.resource,
      level: filters.level,
      startDate: filters.startDate,
      endDate: filters.endDate,
      page,
      limit,
    });
  }

  /**
   * Obtém estatísticas dos logs
   */
  static async getStats(
    options: {
      startDate?: Date;
      endDate?: Date;
    } = {},
  ) {
    const logs = await SystemLogRepository.findMany({
      startDate: options.startDate,
      endDate: options.endDate,
      limit: 10000, // Buscar muitos logs para estatísticas
    });

    const stats = {
      totalLogs: logs.logs.length,
      logsByLevel: {} as Record<string, number>,
      logsByAction: {} as Record<string, number>,
      logsByResource: {} as Record<string, number>,
      recentActivity: [] as Array<{ date: string; count: number }>,
    };

    // Contadores por nível, ação e recurso
    logs.logs.forEach((log) => {
      stats.logsByLevel[log.level] = (stats.logsByLevel[log.level] || 0) + 1;
      stats.logsByAction[log.action] =
        (stats.logsByAction[log.action] || 0) + 1;
      if (log.resource) {
        stats.logsByResource[log.resource] =
          (stats.logsByResource[log.resource] || 0) + 1;
      }
    });

    // Atividade recente (últimos 7 dias)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentLogs = logs.logs.filter((log) => log.createdAt >= sevenDaysAgo);
    const activityMap = new Map<string, number>();

    recentLogs.forEach((log: { createdAt: Date }) => {
      const dateKey = log.createdAt.toISOString().split("T")[0];
      activityMap.set(dateKey, (activityMap.get(dateKey) || 0) + 1);
    });

    stats.recentActivity = Array.from(activityMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return stats;
  }

  /**
   * Remove logs antigos
   */
  static async cleanupOldLogs(daysOld: number): Promise<number> {
    return SystemLogRepository.deleteOldLogs(daysOld);
  }
}
