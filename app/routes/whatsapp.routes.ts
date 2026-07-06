import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccountStatus } from "@prisma/client";
import { authMiddleware } from "../middlewares/auth.middleware";
import { WhatsAppRepository } from "../marketplaces/repositories/whatsapp.repository";
import { WhatsAppInboxRepository } from "../marketplaces/repositories/whatsapp-inbox.repository";
import { WhatsAppApiService } from "../marketplaces/services/whatsapp-api.service";
import { WhatsAppMediaStorageService } from "../marketplaces/services/whatsapp-media-storage.service";
import { WhatsAppWebhookUseCase } from "../marketplaces/usecases/whatsapp-webhook.usecase";
import { isWhatsappEnabledFor } from "../marketplaces/whatsapp/whatsapp-entitlement.service";
import {
  getWhatsappAppSecret,
  getWhatsappVerifyToken,
  isWhatsappModuleEnabled,
  validateWhatsAppConfig,
} from "../marketplaces/whatsapp/whatsapp-constants";

/**
 * Rotas do módulo WhatsApp (Cloud API oficial da Meta).
 *
 * Módulo 100% aditivo atrás de DOIS gates: flag global
 * NEXT_PUBLIC_WHATSAPP_MODULE_ENABLED (kill-switch) + entitlement por tenant
 * (User.whatsappEnabledAt — plano pago superior). Sem os dois, TODAS as rotas
 * autenticadas respondem 403 e não tocam em nada.
 *
 * Isolamento: este plugin NÃO importa nada de listing/order/marketplace. Apenas:
 *   - WhatsAppRepository (contas do canal)
 *   - WhatsAppApiService (Graph API)
 *   - whatsapp-entitlement.service (gate por usuário)
 */
export const whatsappRoutes = async (fastify: FastifyInstance) => {
  /** 403 padrão quando o tenant não tem o módulo habilitado. */
  const denyIfDisabled = async (
    userId: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (await isWhatsappEnabledFor(userId)) return false;
    reply
      .status(403)
      .send({ error: "Módulo WhatsApp não habilitado para esta conta" });
    return true;
  };

  /**
   * GET /whatsapp/status
   * Sonda de visibilidade da UI (sidebar/página de integração/aba Mensagens).
   * NÃO retorna 403 — o "não habilitado" é um estado legítimo ({enabled:false}).
   */
  fastify.get(
    "/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });
      const enabled = await isWhatsappEnabledFor(userId);
      return reply.send({ enabled });
    },
  );

  /**
   * GET /whatsapp/accounts
   * Números conectados do tenant (sem segredos).
   */
  fastify.get(
    "/accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });
      if (await denyIfDisabled(userId, reply)) return;

      const accounts = await WhatsAppRepository.findAllByUserId(userId);
      return reply.send({ accounts });
    },
  );

  /**
   * POST /whatsapp/accounts — conexão MANUAL de um número.
   * body: { phoneNumberId, wabaId, accessToken, appId?, appSecret? }
   *
   * Valida o par token+número na Graph ANTES de gravar (nada de conta morta) e
   * tenta assinar o app aos webhooks da WABA (best-effort — se falhar, a conta
   * fica criada e o cliente re-testa depois; o motivo volta na resposta).
   */
  fastify.post(
    "/accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });
      if (await denyIfDisabled(userId, reply)) return;

      try {
        validateWhatsAppConfig();
      } catch (err: any) {
        return reply.status(500).send({
          error: err?.message ?? "Módulo WhatsApp sem configuração de servidor",
        });
      }

      const body = (request.body || {}) as {
        phoneNumberId?: string;
        wabaId?: string;
        accessToken?: string;
        appId?: string;
        appSecret?: string;
      };
      const phoneNumberId = body.phoneNumberId?.trim();
      const wabaId = body.wabaId?.trim();
      const accessToken = body.accessToken?.trim();
      if (!phoneNumberId || !wabaId || !accessToken) {
        return reply.status(400).send({
          error: "phoneNumberId, wabaId e accessToken são obrigatórios",
        });
      }

      // Valida token+número na Graph antes de persistir.
      let info;
      try {
        info = await WhatsAppApiService.getPhoneNumberInfo(
          accessToken,
          phoneNumberId,
        );
      } catch (err: any) {
        return reply.status(400).send({
          error: `Não foi possível validar o número na Meta: ${err?.message ?? err}`,
        });
      }

      let account;
      try {
        account = await WhatsAppRepository.createAccount({
          userId,
          wabaId,
          phoneNumberId,
          displayPhoneNumber: info.displayPhoneNumber ?? phoneNumberId,
          verifiedName: info.verifiedName ?? null,
          accessToken,
          appId: body.appId?.trim() || null,
          appSecret: body.appSecret?.trim() || null,
        });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const status = msg.includes("já está conectado") ? 409 : 500;
        return reply.status(status).send({ error: msg });
      }

      // Assina o app (do token) aos webhooks da WABA. Best-effort.
      let webhookSubscribed = true;
      let webhookError: string | undefined;
      try {
        await WhatsAppApiService.subscribeApp(accessToken, wabaId);
      } catch (err: any) {
        webhookSubscribed = false;
        webhookError = err?.message ?? String(err);
      }

      return reply
        .status(201)
        .send({ account, webhookSubscribed, webhookError });
    },
  );

  /**
   * POST /whatsapp/accounts/:id/test
   * Revalida token+número na Graph. Sucesso → ACTIVE + metadados atualizados;
   * erro de credencial (HTTP 401/403 ou code 190) → status ERROR. Outros erros
   * (rede/timeout) NÃO mudam o status — só reportam.
   */
  fastify.post<{ Params: { id: string } }>(
    "/accounts/:id/test",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });
      if (await denyIfDisabled(userId, reply)) return;

      const account = await WhatsAppRepository.findWithSecretsByIdAndUser(
        request.params.id,
        userId,
      );
      if (!account) {
        return reply.status(404).send({ error: "Conta não encontrada" });
      }

      try {
        const info = await WhatsAppApiService.getPhoneNumberInfo(
          account.accessToken,
          account.phoneNumberId,
        );
        await WhatsAppRepository.updateDisplayInfo(account.id, {
          displayPhoneNumber: info.displayPhoneNumber,
          verifiedName: info.verifiedName ?? null,
        });
        if (account.status !== AccountStatus.ACTIVE) {
          await WhatsAppRepository.updateStatus(
            account.id,
            AccountStatus.ACTIVE,
          );
        }
        return reply.send({ ok: true, info });
      } catch (err: any) {
        const isAuthError =
          err?.status === 401 || err?.status === 403 || err?.graphCode === 190;
        if (isAuthError) {
          await WhatsAppRepository.updateStatus(account.id, AccountStatus.ERROR);
        }
        return reply.send({
          ok: false,
          authError: isAuthError,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * DELETE /whatsapp/accounts/:id — desconecta o número (apaga conversas e
   * mensagens locais do canal junto; não toca em NADA fora das tabelas WhatsApp).
   */
  fastify.delete<{ Params: { id: string } }>(
    "/accounts/:id",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });
      if (await denyIfDisabled(userId, reply)) return;

      const account = await WhatsAppRepository.findByIdAndUser(
        request.params.id,
        userId,
      );
      if (!account) {
        return reply.status(404).send({ error: "Conta não encontrada" });
      }

      await WhatsAppRepository.deleteAccount(account.id);
      return reply.send({ success: true });
    },
  );

  /**
   * GET /whatsapp/media/:messageId — serving AUTENTICADO da mídia recebida.
   * A mídia mora fora de public/ (privacidade); a posse é validada pela cadeia
   * mensagem→conversa→conta→userId do tenant.
   */
  fastify.get<{ Params: { messageId: string } }>(
    "/media/:messageId",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user?.dataOwnerId;
      if (!userId) return reply.status(401).send({ error: "Não autenticado" });
      if (await denyIfDisabled(userId, reply)) return;

      const media = await WhatsAppInboxRepository.findMediaMessageForUser(
        request.params.messageId,
        userId,
      );
      if (!media) {
        return reply.status(404).send({ error: "Mídia não encontrada" });
      }
      const storage = new WhatsAppMediaStorageService();
      const bytes = await storage.readFile(media.mediaPath);
      if (!bytes) {
        return reply.status(404).send({ error: "Arquivo não encontrado" });
      }
      reply.header("Cache-Control", "private, max-age=3600");
      return reply
        .type(media.mediaMimeType ?? "application/octet-stream")
        .send(bytes);
    },
  );

  /**
   * Webhook da Cloud API — plugin ENCAPSULADO de propósito: o content-type
   * parser `parseAs: "buffer"` abaixo vale SÓ para as rotas deste bloco
   * (Fastify encapsula parsers por contexto), preservando o corpo BRUTO que o
   * HMAC do X-Hub-Signature-256 exige, sem tocar no parse JSON global da API.
   */
  fastify.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    /**
     * GET /whatsapp/webhook — handshake de verificação da Meta.
     * Responde o hub.challenge se o hub.verify_token bater com o nosso.
     * Flag global desligada ⇒ 404 (handshake não completa; módulo inerte).
     */
    webhookScope.get("/webhook", async (request, reply) => {
      if (!isWhatsappModuleEnabled()) {
        return reply.status(404).send({ error: "Not found" });
      }
      const q = (request.query || {}) as Record<string, string | undefined>;
      const mode = q["hub.mode"];
      const verifyToken = q["hub.verify_token"];
      const challenge = q["hub.challenge"];
      const expected = getWhatsappVerifyToken();

      if (
        mode === "subscribe" &&
        Boolean(expected) &&
        verifyToken === expected &&
        challenge
      ) {
        return reply.status(200).type("text/plain").send(challenge);
      }
      return reply.status(403).send({ error: "verify token inválido" });
    });

    /**
     * POST /whatsapp/webhook — eventos (messages/statuses).
     * Segurança fail-closed: assinatura HMAC do corpo bruto é OBRIGATÓRIA e
     * bloqueante (401 em mismatch/sem segredo configurado). Depois de validar,
     * 200 imediato + processamento em background (padrão dos webhooks do
     * projeto) — a Meta exige resposta rápida e reenvia em não-200 por 7 dias.
     */
    webhookScope.post("/webhook", async (request, reply) => {
      // Kill-switch global: inerte (200 sem processar — nada de retry storm).
      if (!isWhatsappModuleEnabled()) {
        return reply.status(200).send({ received: true });
      }

      const rawBody = request.body as Buffer;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.status(400).send({ error: "corpo inválido" });
      }
      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply.status(400).send({ error: "JSON inválido" });
      }

      if (payload?.object !== "whatsapp_business_account") {
        return reply.status(200).send({ received: true });
      }

      // Assinatura validada POR CONTA (não com uma lista agregada de segredos):
      // cada phone_number_id do payload é autorizado só se a assinatura do corpo
      // casa com o App Secret DAQUELA conta (fallback env). Isso impede que o
      // tenant A (que conhece o próprio App Secret) forje um payload contendo o
      // número do tenant B e o injete — o número de B só passa se assinado com o
      // segredo de B. `authorized` alimenta o processamento, que ignora changes
      // de números não-autorizados.
      const signature = request.headers["x-hub-signature-256"] as
        | string
        | undefined;
      const phoneNumberIds =
        WhatsAppWebhookUseCase.extractPhoneNumberIds(payload);
      const accounts = (
        await Promise.all(
          phoneNumberIds.map((id) =>
            WhatsAppRepository.findByPhoneNumberIdWithSecrets(id),
          ),
        )
      ).filter((a): a is NonNullable<typeof a> => Boolean(a));

      const authorized = new Set<string>();
      for (const account of accounts) {
        const secret = account.appSecret || getWhatsappAppSecret();
        if (!secret) continue;
        if (
          WhatsAppWebhookUseCase.verifySignature(rawBody, signature, [secret])
        ) {
          authorized.add(account.phoneNumberId);
        }
      }

      // Nenhum número autorizado (desconhecido, sem segredo, ou assinatura
      // inválida) ⇒ 401 ÚNICO. Resposta uniforme de propósito: não distinguir
      // "número desconhecido" de "assinatura inválida" evita um oráculo de
      // enumeração dos números conectados. A Meta reenvia em não-200, o que é
      // aceitável para o volume de lixo/ataque que cai aqui.
      if (authorized.size === 0) {
        request.log.warn(
          "[whatsapp-webhook] Nenhum número autorizado (assinatura inválida ou número desconhecido) — rejeitado",
        );
        return reply.status(401).send({ error: "não autorizado" });
      }

      reply.status(200).send({ received: true });
      const authorizedIds = [...authorized];
      setImmediate(() => {
        WhatsAppWebhookUseCase.processWebhook(payload, authorizedIds).catch(
          (err) => {
            console.error(
              "[whatsapp-webhook] Erro no processamento em background:",
              err instanceof Error ? err.message : err,
            );
          },
        );
      });
    });
  });

  // healthcheck simples (não exige auth) — espelha /messages/_ping. Também
  // reporta se o módulo está ligado globalmente (não vaza nada por usuário).
  fastify.get("/_ping", async () => {
    return { ok: true, moduleEnabled: isWhatsappModuleEnabled() };
  });
};
