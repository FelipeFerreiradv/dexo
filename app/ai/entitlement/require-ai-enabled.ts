// preHandler padrão das rotas /ai/*: nega quando o tenant não tem o Bitz.
//
// Espelha o helper denyIfDisabled de app/routes/whatsapp.routes.ts:31-41, mas
// como preHandler reutilizável — o Bitz terá várias rotas e repetir o if em
// cada handler é como um gate acaba esquecido em uma delas.
//
// A regra da casa (estabelecida pelo WhatsApp): 403 no namespace PRÓPRIO do
// módulo, passthrough silencioso em rota legada compartilhada. O Bitz não
// compartilha rota com ninguém, então é 403 puro em tudo — exceto
// GET /ai/entitlement, que é a sonda de visibilidade da UI e responde
// 200 { enabled: false }, porque "não contratado" é um estado legítimo.

import { FastifyReply, FastifyRequest } from "fastify";

import { isAiEnabledFor } from "./ai-entitlement.service";

export async function requireAiEnabled(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Sem usuário o authMiddleware já respondeu 401; não é papel deste hook.
  const dataOwnerId = request.user?.dataOwnerId;
  if (!dataOwnerId) return;

  if (await isAiEnabledFor(dataOwnerId)) return;

  // O `return` é obrigatório: num hook async do Fastify, chamar reply.send()
  // sem retornar a reply NÃO interrompe o ciclo e o handler roda mesmo assim.
  // Mesmo formato de requirePageAccess/requireAction (403 com `code`).
  return reply.status(403).send({
    message: "O Bitz não está habilitado para esta conta.",
    code: "AI_DISABLED",
  });
}
