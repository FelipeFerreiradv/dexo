// Auditoria do Bitz sobre o SystemLog (padrão da casa).
//
// DUAS decisões que valem explicação:
//
// 1. A COLUNA `userId` FICA NULA e o tenant vai em `details.tenantUserId`.
//    Convenção de rembg-telemetry.ts:112-117. A página /logs filtra por
//    `userId IN (tenant)`, então deixar nulo mantém a telemetria do Bitz fora
//    do log que o CLIENTE lê — sem deixar de ser contável globalmente pela
//    equipe. Quando a Fase 9 trouxer AÇÕES DE ESCRITA, aí sim o `userId` será
//    o ator: aquilo o cliente tem que ver no log dele.
//
// 2. `sanitizeDeep` é aplicado AQUI, no call site.
//    SystemLogService.log() grava `details` cru (system-log.repository.ts:23) e
//    ainda despeja o objeto sem sanitizar no console em caso de falha
//    (system-log.service.ts:93). Nenhuma redação acontece dentro do serviço —
//    só no middleware de logging, que este caminho não atravessa. Como aqui
//    passam pergunta do usuário e resposta do modelo, sanitizar é obrigatório.
//
// Nada neste arquivo lança nem é aguardado no caminho da resposta.

import { SystemLogService } from "../../services/system-log.service";
import { sanitizeDeep } from "../../middlewares/logging.middleware";
import type { AiFailureReason } from "../core/types";

/** Teto de texto livre no log. Não é lugar de guardar conversa inteira. */
const MAX_SNIPPET = 200;

function snippet(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_SNIPPET
    ? `${clean.slice(0, MAX_SNIPPET - 1)}…`
    : clean;
}

interface AuditBase {
  dataOwnerId: string;
  actorUserId: string;
  conversationId?: string;
}

/** Um turno concluído. É a linha que permite medir custo por cliente. */
export function auditChatTurn(
  input: AuditBase & {
    provider: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    toolCalls: number;
    degraded: boolean;
  },
): void {
  void SystemLogService.logInfo(
    "AI_CHAT_TURN",
    `Bitz respondeu (${input.provider}/${input.model}, ${input.latencyMs}ms)`,
    {
      resource: "AiConversation",
      resourceId: input.conversationId,
      details: sanitizeDeep({
        tenantUserId: input.dataOwnerId,
        actorUserId: input.actorUserId,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        latencyMs: input.latencyMs,
        toolCalls: input.toolCalls,
        degraded: input.degraded,
      }),
    },
  );
}

/** Falha do provedor. WARNING, não ERROR: IA fora do ar não é incidente de infra. */
export function auditProviderError(
  input: AuditBase & {
    provider: string;
    model: string;
    reason: AiFailureReason;
    detail?: string;
    latencyMs: number;
  },
): void {
  void SystemLogService.logWarning(
    "AI_PROVIDER_ERROR",
    `Bitz indisponível: ${input.reason}`,
    {
      resource: "AiConversation",
      resourceId: input.conversationId,
      details: sanitizeDeep({
        tenantUserId: input.dataOwnerId,
        actorUserId: input.actorUserId,
        provider: input.provider,
        model: input.model,
        reason: input.reason,
        // `detail` já vem classificado e curto do provedor (status HTTP ou
        // código de rede) — nunca corpo de resposta, nunca URL com chave.
        detail: snippet(input.detail),
        latencyMs: input.latencyMs,
      }),
    },
  );
}

/**
 * Uma tool executada.
 *
 * `args` NÃO entra aqui, nem sanitizado. O que interessa para auditoria é QUAL
 * consulta rodou, se deu certo e quanto demorou — os argumentos carregam o
 * termo de busca do usuário, que é dado do cliente e já vive na conversa.
 */
export function auditToolCall(
  input: AuditBase & {
    tool: string;
    ok: boolean;
    ms: number;
    error?: string;
  },
): void {
  void SystemLogService.logInfo(
    "AI_TOOL_CALL",
    `Bitz consultou ${input.tool} (${input.ok ? "ok" : "falhou"}, ${input.ms}ms)`,
    {
      resource: "AiConversation",
      resourceId: input.conversationId,
      details: sanitizeDeep({
        tenantUserId: input.dataOwnerId,
        actorUserId: input.actorUserId,
        tool: input.tool,
        ok: input.ok,
        ms: input.ms,
        error: input.error,
      }),
    },
  );
}

/**
 * Tool recusada por permissão.
 *
 * WARNING e linha própria: é a prova auditável de que o gate por página vale
 * dentro do chat. Se um colaborador sem `financeiro` tentar puxar o caixa pelo
 * Bitz, existe registro disso.
 */
export function auditToolDenied(
  input: AuditBase & { tool: string; page: string },
): void {
  void SystemLogService.logWarning(
    "AI_TOOL_DENIED",
    `Bitz recusou ${input.tool}: sem acesso a ${input.page}`,
    {
      resource: "AiConversation",
      resourceId: input.conversationId,
      details: sanitizeDeep({
        tenantUserId: input.dataOwnerId,
        actorUserId: input.actorUserId,
        tool: input.tool,
        page: input.page,
      }),
    },
  );
}

/** Teto diário batido. */
export function auditQuotaExceeded(
  input: AuditBase & { denied: "tenant" | "global" },
): void {
  void SystemLogService.logWarning(
    "AI_QUOTA_EXCEEDED",
    `Teto diário do Bitz atingido (${input.denied})`,
    {
      resource: "AiConversation",
      resourceId: input.conversationId,
      details: sanitizeDeep({
        tenantUserId: input.dataOwnerId,
        actorUserId: input.actorUserId,
        denied: input.denied,
      }),
    },
  );
}
