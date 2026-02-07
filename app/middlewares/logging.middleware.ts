import { FastifyRequest, FastifyReply } from "fastify";
// import { SystemLogService } from "../services/system-log.service"; // Importação dinâmica para evitar problemas de inicialização

/**
 * Middleware para logging automático de requisições HTTP
 * Registra todas as ações realizadas pelos usuários no sistema
 */
export const loggingMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  // Capturar timestamp de início
  const startTime = Date.now();

  // Aguardar a resposta ser enviada
  reply.raw.on("finish", () => {
    // Executar logging de forma assíncrona sem bloquear
    setImmediate(async () => {
      try {
        const duration = Date.now() - startTime;
        const user = (request as any).user;
        const userId = user?.id;

        // Informações da requisição
        const method = request.method;
        const url = request.url;
        const ipAddress = request.ip;
        const userAgent = request.headers["user-agent"];

        // Status da resposta
        const statusCode = reply.statusCode;

        // Determinar o tipo de ação baseado na rota e método
        const actionType = determineActionType(method, url);
        if (!actionType) return; // Não logar rotas que não interessam

        // Determinar nível do log baseado no status
        const level =
          statusCode >= 400 ? "ERROR" : statusCode >= 300 ? "WARNING" : "INFO";

        // Criar mensagem descritiva
        const message = createLogMessage(method, url, statusCode, duration);

        // Registrar log de forma assíncrona
        import("../services/system-log.service")
          .then(({ SystemLogService }) => {
            SystemLogService.log({
              userId,
              action: actionType.action as any, // Cast necessário pois o tipo é validado em runtime
              resource: actionType.resource,
              resourceId: actionType.resourceId,
              level: level as any,
              message,
              ipAddress,
              userAgent,
              details: {
                method,
                url,
                statusCode,
                duration,
                query: request.query,
                params: request.params,
                body: sanitizeBody(request.body),
              },
            }).catch((error) => {
              // Em caso de erro no logging, não queremos quebrar a aplicação
              console.error(
                "[LoggingMiddleware] Erro ao registrar log:",
                error,
              );
            });
          })
          .catch((error) => {
            console.error(
              "[LoggingMiddleware] Erro ao importar SystemLogService:",
              error,
            );
          });
      } catch (error) {
        // Em caso de erro no logging, não queremos quebrar a aplicação
        console.error("[LoggingMiddleware] Erro ao processar log:", error);
      }
    });
  });
};

/**
 * Determina o tipo de ação baseado na rota e método HTTP
 */
function determineActionType(
  method: string,
  url: string,
): {
  action: string;
  resource?: string;
  resourceId?: string;
} | null {
  // Remover query parameters da URL
  const cleanUrl = url.split("?")[0];

  // Padrões de rotas
  if (cleanUrl === "/login" && method === "POST") {
    return { action: "LOGIN", resource: "User" };
  }

  if (cleanUrl.startsWith("/products")) {
    if (method === "POST") {
      return { action: "CREATE_PRODUCT", resource: "Product" };
    }
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "UPDATE_PRODUCT", resource: "Product", resourceId: id };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "DELETE_PRODUCT", resource: "Product", resourceId: id };
    }
  }

  if (cleanUrl.startsWith("/listings")) {
    if (method === "POST") {
      return { action: "CREATE_LISTING", resource: "ProductListing" };
    }
  }

  if (cleanUrl.includes("/marketplace/") && cleanUrl.includes("/sync")) {
    return { action: "SYNC_STOCK", resource: "Sync" };
  }

  // Não logar rotas de leitura (GET) a menos que sejam específicas
  if (method === "GET") {
    return null;
  }

  // Para outras ações não mapeadas, usar um log genérico
  return { action: "USER_ACTIVITY", resource: "System" };
}

/**
 * Extrai ID da URL (ex: /products/123 -> 123)
 */
function extractIdFromUrl(url: string): string | undefined {
  const parts = url.split("/");
  const lastPart = parts[parts.length - 1];
  return lastPart && lastPart !== "" ? lastPart : undefined;
}

/**
 * Cria uma mensagem descritiva para o log
 */
function createLogMessage(
  method: string,
  url: string,
  statusCode: number,
  duration: number,
): string {
  const cleanUrl = url.split("?")[0];
  return `${method} ${cleanUrl} - ${statusCode} (${duration}ms)`;
}

/**
 * Remove dados sensíveis do body antes de logar
 */
function sanitizeBody(body: any): any {
  if (!body || typeof body !== "object") return body;

  const sanitized = { ...body };

  // Remover campos sensíveis
  const sensitiveFields = ["password", "token", "secret", "key"];
  sensitiveFields.forEach((field) => {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  });

  return sanitized;
}
