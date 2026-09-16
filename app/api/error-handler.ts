import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { SystemLogService } from "../services/system-log.service";

/**
 * O cliente fechou a conexão antes da resposta sair?
 *
 * Medido em produção (set/2026): 8.379 `SYSTEM_ERROR` "Premature close" no mês,
 * quase todos em `/marketplace/{ml,shopee}/category-suggest` — o formulário de
 * produto CANCELA a sugestão anterior (AbortSignal) a cada tecla. Não é defeito;
 * era ruído que enterrava os erros reais no painel.
 *
 * Reproduzido com Fastify + @fastify/compress: o aborto chega aqui com
 * `code = ERR_STREAM_PREMATURE_CLOSE` e o socket JÁ destruído. Um erro real da
 * rota tem o socket vivo — por isso as duas condições juntas. `request.raw
 * .destroyed` NÃO serve: fica true em qualquer POST depois que o corpo é lido.
 */
export function isClientAbort(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "ERR_STREAM_PREMATURE_CLOSE") return false;
  return Boolean(request.raw.socket?.destroyed || reply.raw.destroyed);
}

/** Handler global de erro da API (extraído de api.ts para ser testável). */
export function createApiErrorHandler(log: FastifyBaseLogger) {
  return async (error: any, request: FastifyRequest, reply: FastifyReply) => {
    const message: string = error?.message ?? String(error);
    const statusCode: number =
      typeof error?.statusCode === "number" ? error.statusCode : 500;

    if (isClientAbort(error, request, reply)) {
      // Ninguém espera esta resposta: uma linha informativa, sem SYSTEM_ERROR.
      log.info(
        { path: request.url, method: request.method, code: error.code },
        "request aborted by client",
      );
    } else {
      log.error(
        { err: error, path: request.url, method: request.method },
        "request error",
      );
      try {
        await SystemLogService.logError(
          "SYSTEM_ERROR",
          `${request.method} ${request.url}: ${message}`,
          {
            resource: "Request",
            resourceId: request.id,
            details: {
              method: request.method,
              url: request.url,
              statusCode,
            },
          },
        );
      } catch {
        // swallow — não deixa falha de log derrubar o handler.
      }
    }
    // SEGURANÇA: em produção, NÃO devolver a mensagem crua de erros 5xx ao cliente
    // (pode vazar query de banco, caminho de arquivo, nome de função). 4xx (erros
    // de validação) continuam informativos. O detalhe completo fica no log +
    // SystemLog, correlacionável pelo requestId.
    const isProd = process.env.NODE_ENV === "production";
    const clientMessage =
      statusCode >= 500 && isProd ? "Erro interno do servidor" : message;
    reply.status(statusCode).send({
      error: "Erro interno do servidor",
      message: clientMessage,
      requestId: request.id,
    });
  };
}
