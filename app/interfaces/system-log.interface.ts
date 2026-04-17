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
  | "SYNC_STOCK"
  | "SYNC_ORDERS"
  | "CONNECT_MARKETPLACE"
  | "DISCONNECT_MARKETPLACE"
  | "SYSTEM_ERROR"
  | "USER_ACTIVITY"
  | "OVERSELL_DETECTED"
  | "STOCK_SYNC_FAILED"
  | "WEBHOOK_ACCOUNT_NOT_FOUND"
  | "TOKEN_EXPIRED_REPEATED";

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
