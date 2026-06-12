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
                query: sanitizeDeep(request.query),
                params: sanitizeDeep(request.params),
                body: sanitizeDeep(request.body),
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
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "UPDATE_LISTING",
        resource: "ProductListing",
        resourceId: id,
      };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "DELETE_LISTING",
        resource: "ProductListing",
        resourceId: id,
      };
    }
  }

  // Notas Fiscais
  if (cleanUrl.startsWith("/fiscal")) {
    if (cleanUrl.includes("/nfe/emission") && method === "POST") {
      return { action: "EMIT_NFE", resource: "NfeEmitida" };
    }
    if (cleanUrl.includes("/nfe/draft") && method === "POST") {
      return { action: "CREATE_NFE_DRAFT", resource: "NfeEmitida" };
    }
    if (cleanUrl.includes("/nfe/inutilizacao") && method === "POST") {
      return { action: "INUTILIZE_NFE", resource: "NfeInutilizacao" };
    }
    if (cleanUrl.includes("/nfe") && method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "UPDATE_NFE_DRAFT",
        resource: "NfeEmitida",
        resourceId: id,
      };
    }
    if (cleanUrl.includes("/nfe") && method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "CANCEL_NFE", resource: "NfeEmitida", resourceId: id };
    }
    if (
      cleanUrl.includes("/config") &&
      (method === "POST" || method === "PUT")
    ) {
      return {
        action: "UPDATE_FISCAL_CONFIG",
        resource: "CompanyFiscalConfig",
      };
    }
  }

  // Customers
  if (cleanUrl.startsWith("/customers")) {
    if (method === "POST") {
      return { action: "CREATE_CUSTOMER", resource: "Customer" };
    }
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "UPDATE_CUSTOMER",
        resource: "Customer",
        resourceId: id,
      };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "DELETE_CUSTOMER",
        resource: "Customer",
        resourceId: id,
      };
    }
  }

  // Locations
  if (cleanUrl.startsWith("/locations")) {
    if (method === "POST") {
      return { action: "CREATE_LOCATION", resource: "Location" };
    }
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "UPDATE_LOCATION",
        resource: "Location",
        resourceId: id,
      };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "DELETE_LOCATION",
        resource: "Location",
        resourceId: id,
      };
    }
  }

  // Scraps
  if (cleanUrl.startsWith("/scraps")) {
    if (method === "POST") {
      return { action: "CREATE_SCRAP", resource: "Scrap" };
    }
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "UPDATE_SCRAP", resource: "Scrap", resourceId: id };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "DELETE_SCRAP", resource: "Scrap", resourceId: id };
    }
    if (method === "PATCH") {
      // Transição de estágio logístico (/scraps/:id/logistics-status): o log
      // estruturado {from,to} é gravado no ScrapUseCase. Evita log duplicado.
      return null;
    }
  }

  // Finance — payables / receivables
  if (cleanUrl.startsWith("/finance/payables")) {
    if (method === "POST") {
      return { action: "CREATE_PAYABLE", resource: "Payable" };
    }
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "UPDATE_PAYABLE", resource: "Payable", resourceId: id };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return { action: "DELETE_PAYABLE", resource: "Payable", resourceId: id };
    }
  }
  if (cleanUrl.startsWith("/finance/receivables")) {
    if (method === "POST") {
      return { action: "CREATE_RECEIVABLE", resource: "Receivable" };
    }
    if (method === "PUT") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "UPDATE_RECEIVABLE",
        resource: "Receivable",
        resourceId: id,
      };
    }
    if (method === "DELETE") {
      const id = extractIdFromUrl(cleanUrl);
      return {
        action: "DELETE_RECEIVABLE",
        resource: "Receivable",
        resourceId: id,
      };
    }
  }

  // Marketplace connect/disconnect (capturado mesmo quando bloqueado por
  // colaborador — registra a tentativa via 403)
  if (
    cleanUrl.startsWith("/marketplace/ml/auth") ||
    cleanUrl.startsWith("/marketplace/shopee/auth")
  ) {
    if (method === "POST") {
      return { action: "CONNECT_MARKETPLACE", resource: "MarketplaceAccount" };
    }
  }
  if (
    (cleanUrl === "/marketplace/ml" || cleanUrl === "/marketplace/shopee") &&
    method === "DELETE"
  ) {
    return {
      action: "DISCONNECT_MARKETPLACE",
      resource: "MarketplaceAccount",
    };
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
 * Campos sensíveis (segredos + PII) que NUNCA devem ir para o SystemLog em
 * claro. Comparação por substring case-insensitive no nome do campo, então
 * cobre variações (accessToken, certificadoSenhaEnc, customerCpf, etc.).
 * Como isto só afeta o CONTEÚDO do log (não o comportamento), redigir demais
 * é seguro — preferimos pecar pelo excesso.
 */
const SENSITIVE_FIELD_PATTERNS = [
  "password",
  "senha",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "cpf",
  "cnpj",
  "rg",
  // PII de contato/endereço de clientes finais
  "email",
  "phone",
  "mobile",
  "telefone",
  "celular",
  "birthdate",
  "datanascimento",
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_FIELD_PATTERNS.some((p) => k.includes(p));
}

/**
 * Redige recursivamente campos sensíveis de qualquer objeto/array (body, query,
 * params). Antes a função era rasa (só top-level) e não cobria PII (CPF/CNPJ/
 * email/telefone) nem segredos aninhados.
 */
export function sanitizeDeep(value: any, depth = 0): any {
  if (depth > 6) return "[TRUNCATED]"; // proteção contra estruturas profundas
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v, depth + 1));
  }
  if (typeof value !== "object") return value;

  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitizeDeep(val, depth + 1);
    }
  }
  return out;
}
