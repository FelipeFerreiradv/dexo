// ⭐ O escopo de uma execução de tool. É a peça central de segurança do Bitz.
//
// A pergunta que este arquivo responde: como garantir que o modelo NUNCA
// consiga escolher de qual loja os dados vêm?
//
// A resposta não é "validar bem os argumentos". É TIRAR O TENANT DO ALCANCE
// DELE. Toda tool tem a assinatura `(args, scope)`. O modelo produz `args` — e
// só. O `scope` vem daqui, montado a partir da sessão já autenticada, e não há
// caminho por onde ele possa ser influenciado por texto.
//
// Três travas somadas, cada uma suficiente sozinha:
//
//  1. TIPO. `AiScope` é NOMINAL: carrega uma marca de símbolo único que não é
//     construível a partir de objeto literal. `const s: AiScope = {...}` não
//     compila. A única forma de obter um é chamar `scopeFromRequest`.
//
//  2. SCHEMA. Um teste percorre o registry e falha se QUALQUER schema zod tiver
//     chave casando /userId|dataOwnerId|tenant|ownerId/i. Se alguém tentar
//     aceitar o tenant como argumento, a suíte quebra.
//
//  3. RUNTIME. O tool-runner faz `.strict()`: chave extra vinda do modelo é
//     REJEITADA, não ignorada. Um `{"consulta":"x","userId":"outro"}` não passa
//     silenciosamente — ele falha.
//
// A permissão por página mora aqui pelo mesmo motivo: `scope.can("financeiro")`
// consulta as permissões REAIS do colaborador que digitou, não uma afirmação do
// modelo sobre quem ele é.

import type { FastifyRequest } from "fastify";

import { hasActionAccess, type ActionId } from "../../lib/action-access";
import { hasPageAccess, type PageId } from "../../lib/page-access";

/**
 * Marca nominal. `declare const` = existe só no sistema de tipos; nenhum objeto
 * carrega esta chave em runtime. É exatamente isso que impede a construção por
 * literal e mantém `scopeFromRequest` como porta única.
 */
declare const AI_SCOPE_BRAND: unique symbol;

export interface AiScope {
  readonly [AI_SCOPE_BRAND]: true;

  /** O TENANT. Escopo de tudo que o agente consulta. */
  readonly dataOwnerId: string;

  /** Quem digitou (colaborador ou o próprio admin). Trilha de auditoria. */
  readonly actorId: string;

  /** O ator tem acesso a esta página? Delega para a regra real do sistema. */
  can(page: PageId): boolean;

  /** O ator pode executar esta ação? Delega para a regra real do sistema. */
  canAction(action: ActionId): boolean;
}

/** O que `authMiddleware` pendura em `request.user`. */
interface AuthUser {
  id?: string | null;
  dataOwnerId?: string | null;
  parentUserId?: string | null;
  role?: string | null;
  pagePermissions?: Record<string, boolean> | null;
}

/**
 * ÚNICA fábrica de `AiScope`. Só a partir de uma requisição autenticada.
 *
 * Devolve `null` quando não há sessão — quem chama decide o que fazer, e o
 * caminho `/ai/chat` já passou por `authMiddleware` + `requireAiEnabled`, então
 * na prática nunca é null lá.
 *
 * O `dataOwnerId` NÃO é recalculado aqui: é lido de `request.user`, onde o
 * `authMiddleware` (auth.middleware.ts:23-26) já resolveu `parentUserId ?? id`.
 * Uma segunda derivação seria uma segunda regra para manter em sincronia — e
 * duas regras de tenant é como se cria um vazamento.
 */
export function scopeFromRequest(request: FastifyRequest): AiScope | null {
  const user = (request as unknown as { user?: AuthUser | null }).user;
  const dataOwnerId = user?.dataOwnerId;
  const actorId = user?.id;
  if (!user || !dataOwnerId || !actorId) return null;

  // `hasPageAccess`/`hasActionAccess` são funções PURAS e já testadas
  // (page-access.spec.ts, finance-action-permission.spec.ts). O Bitz não tem
  // regra de permissão própria: se um dia a regra da casa mudar, ele acompanha
  // sozinho. Um segundo modelo de permissão seria um segundo lugar para errar.
  const scope = {
    dataOwnerId,
    actorId,
    can: (page: PageId) => hasPageAccess(user, page),
    canAction: (action: ActionId) => hasActionAccess(user, action),
  };

  // O cast é o preço da marca nominal, e é POR ISSO que ele mora aqui e em
  // nenhum outro lugar: esta linha é a fronteira auditável do sistema.
  return scope as unknown as AiScope;
}
