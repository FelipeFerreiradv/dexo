import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MarketplaceUseCase } from "../marketplaces/usecases/marketplace.usercase";
import { SyncUseCase } from "../marketplaces/usecases/sync.usercase";
import { WebhookUseCase } from "../marketplaces/usecases/webhook.usercase";
import { ListingRepository } from "../marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "../marketplaces/repositories/marketplace.repository";
import CategoryRepository from "../marketplaces/repositories/category.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import { blockCollaborator } from "../middlewares/no-collaborator.middleware";
import { Platform } from "@prisma/client";
import { SystemLogService } from "../services/system-log.service";
import prisma from "../lib/prisma";
import { ListingRetryService } from "../marketplaces/services/listing-retry.service";
import { MLAttributeCatalogService } from "../marketplaces/services/ml-attribute-catalog.service";
import CategorySuggestionService from "../marketplaces/services/category-suggestion.service";
import { MLCatalogSuggestionUseCase } from "../marketplaces/usecases/ml-catalog-suggestion.usecase";
import { InternalSuggestionUseCase } from "../marketplaces/usecases/internal-suggestion.usecase";
import { ShopeeOAuthService } from "../marketplaces/services/shopee-oauth.service";
import { ShopeeApiService } from "../marketplaces/services/shopee-api.service";
import { MLApiService } from "../marketplaces/services/ml-api.service";
import { MLOAuthService } from "../marketplaces/services/ml-oauth.service";
import { MagaluWebhookSignatureService } from "../marketplaces/services/magalu-webhook-signature.service";
import { ShopeeWebhookSignatureService } from "../marketplaces/services/shopee-webhook-signature.service";
import { SHOPEE_CONSTANTS } from "../marketplaces/shopee/shopee-constants";
import { Readable } from "stream";
import { MAGALU_CONSTANTS } from "../marketplaces/magalu/magalu-constants";
import type { MagaluOrderWebhookPayload } from "../marketplaces/types/magalu-order.types";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { getVehicleRootSet } from "../marketplaces/services/category-resolution.service";
import {
  ML_BLOCKED_BRANCHES,
  SHOPEE_AUTOMOTIVE_MARKERS,
  SHOPEE_BLOCKED_BRANCHES,
  normalizePath,
} from "../marketplaces/lib/category-inference/map-generation";
import { AccountStatus } from "@prisma/client";

/**
 * Cache curto (60s) do par { accountId, accessToken } resolvido por usuário.
 * As chamadas /ml/compatibility/* disparam em sequência quando o usuário abre o
 * modal (marcas → modelos → veículos). Sem este cache cada request repete
 * 2 queries Prisma + potencial refresh de token, custando ~700ms cada.
 * TTL curto para que renovações de token/troca de conta propaguem rápido.
 */
type ResolvedMlAccount = { accountId: string; accessToken: string };
const resolvedAccountCache = new Map<
  string,
  { data: ResolvedMlAccount; exp: number }
>();
const RESOLVED_ACCOUNT_TTL_MS = 60 * 1000;

function resolvedAccountCacheKey(userId: string, accountId?: string): string {
  return `${userId}::${accountId ?? ""}`;
}

/**
 * Resolve a conta Mercado Livre a ser usada para consultas de compatibilidade:
 *   - usa accountId explícito se informado e pertencer ao usuário;
 *   - senão, cai para a conta ATIVA mais recente do usuário;
 *   - renova o token automaticamente se estiver expirado, persistindo a renovação;
 *   - devolve { account, accessToken } ou null se não houver conta utilizável.
 */
async function resolveMlAccountForCompat(
  userId: string,
  accountId?: string,
): Promise<ResolvedMlAccount | null> {
  const cacheKey = resolvedAccountCacheKey(userId, accountId);
  const cached = resolvedAccountCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return cached.data;
  }

  let account = accountId
    ? await MarketplaceRepository.findByIdAndUser(accountId, userId)
    : await MarketplaceRepository.findFirstActiveByUserAndPlatform(
        userId,
        Platform.MERCADO_LIVRE,
      );

  if (!account && !accountId) {
    const all = await MarketplaceRepository.findAllByUserIdAndPlatform(
      userId,
      Platform.MERCADO_LIVRE,
    );
    const active = (all || []).filter(
      (acc) => acc.status === AccountStatus.ACTIVE,
    );
    if (active.length > 0) {
      account = active.sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt || 0).getTime() -
          new Date(a.updatedAt || a.createdAt || 0).getTime(),
      )[0];
    }
  }

  if (!account || !account.accessToken || !account.refreshToken) return null;

  let accessToken = account.accessToken;
  if (account.expiresAt && new Date(account.expiresAt) <= new Date()) {
    try {
      const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );
      const updated = await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });
      if (updated) accessToken = updated.accessToken;
      else accessToken = refreshed.accessToken;
    } catch (err) {
      console.warn(
        `[marketplace:ml-compat] Falha ao renovar token da conta ${account.id}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  const resolved: ResolvedMlAccount = { accountId: account.id, accessToken };
  resolvedAccountCache.set(cacheKey, {
    data: resolved,
    exp: Date.now() + RESOLVED_ACCOUNT_TTL_MS,
  });
  return resolved;
}

/**
 * Rotas para gerenciar conexÃµes com marketplaces
 */
export async function marketplaceRoutes(app: FastifyInstance) {
  app.get("/ml/cli-callback", async (request, reply) => {
    const q = (request.query as Record<string, string | undefined>) ?? {};
    const code = q.code ?? "";
    const state = q.state ?? "";
    const error = q.error ?? "";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ML CLI Callback</title>
<style>body{font-family:monospace;padding:24px;max-width:900px;margin:0 auto}
h2{color:#333}pre{background:#f4f4f4;padding:12px;border-radius:6px;word-break:break-all;white-space:pre-wrap}
.ok{color:#080}.err{color:#c00}</style></head><body>
<h2>${error ? '<span class="err">Erro retornado pelo ML</span>' : '<span class="ok">Autorização recebida</span>'}</h2>
${error ? `<p><b>error:</b> ${error}</p>` : ""}
<p>Cole esta URL completa no terminal do helper CLI:</p>
<pre>${request.protocol}://${request.hostname}${request.url}</pre>
<p>Ou, se preferir, cole somente os campos:</p>
<pre>code=${code}\nstate=${state}</pre>
</body></html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /**
   * POST /marketplace/ml/auth
   * Inicia fluxo de autenticaÃ§Ã£o com Mercado Livre
   * Retorna URL para redirecionamento do usuÃ¡rio
   * Requer autenticaÃ§Ã£o - userId vem da sessÃ£o
   */
  app.post<{
    Reply: { authUrl: string; state: string };
  }>(
    "/ml/auth",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // userId vem da sessÃ£o (garantido pelo authMiddleware)
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        // Gerar URL de autorizaÃ§Ã£o (passa userId para associar no callback)
        const { authUrl, state } = MarketplaceUseCase.initiateOAuth(userId);

        // Retornar URL + state (state serÃ¡ usado no callback)
        return reply.send({
          authUrl,
          state,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar autenticaÃ§Ã£o",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/callback?code=...&state=...
   * Callback do OAuth apÃ³s usuÃ¡rio autorizar no Mercado Livre
   * Processa o authorization code e cria sessÃ£o
   * Nota: NÃƒO requer autenticaÃ§Ã£o prÃ©via - userId vem do state
   */
  app.get<{
    Querystring: { code?: string; state?: string };
    Reply: { success: boolean; message: string };
  }>("/ml/callback", async (request: FastifyRequest, reply: FastifyReply) => {
    // Detectar se é um redirect do browser (vindo do Mercado Livre) ou chamada da API (fetch)
    const acceptHeader = ((request.headers.accept as string) || "").toString();
    const isBrowserRedirect = acceptHeader.includes("text/html");
    const frontendUrl =
      process.env.NEXTAUTH_URL ||
      process.env.CORS_ORIGIN ||
      "http://localhost:3000";

    try {
      const code = (request.query as any).code as string | undefined;
      const state = (request.query as any).state as string | undefined;

      // Validar parÃ¢metros obrigatÃ³rios
      if (!code || !state) {
        if (isBrowserRedirect) {
          return reply.redirect(
            `${frontendUrl}/integracoes/mercado-livre/callback?result=error&message=${encodeURIComponent("code e state são obrigatórios")}`,
          );
        }
        return reply.status(400).send({
          error: "ParÃ¢metros invÃ¡lidos",
          message: "code e state sÃ£o obrigatÃ³rios",
        });
      }

      // userId pode vir da sessÃ£o atual OU do state armazenado
      // O state jÃ¡ contÃ©m o userId de quando o OAuth foi iniciado
      const userId = request.user?.dataOwnerId;

      let account;
      try {
        account = await MarketplaceUseCase.handleOAuthCallback({
          code,
          state,
          userId,
        });
      } catch (handleErr) {
        const msg =
          handleErr instanceof Error ? handleErr.message : String(handleErr);
        // Fluxo CLI helper: state foi gerado fora deste backend (script
        // connect-ml-account.ts). Retornar HTML com code+state para o
        // operador colar no terminal.
        if (
          isBrowserRedirect &&
          /state inv|state expirad|state n[ãa]o encontrado/i.test(msg)
        ) {
          const fullUrl = `${request.protocol}://${request.hostname}${request.url}`;
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ML CLI Callback</title>
<style>body{font-family:monospace;padding:24px;max-width:900px;margin:0 auto}
h2{color:#080}pre{background:#f4f4f4;padding:12px;border-radius:6px;word-break:break-all;white-space:pre-wrap}
small{color:#666}</style></head><body>
<h2>Autorização capturada</h2>
<p>State não bate com o backend (esperado se você usou o CLI helper).</p>
<p><b>Cole esta URL completa de volta no terminal do helper:</b></p>
<pre>${fullUrl}</pre>
<p>Ou somente os campos:</p>
<pre>code=${code}\nstate=${state}</pre>
<small>Esta tela só aparece em conexões via CLI helper.</small>
</body></html>`;
          return reply.type("text/html; charset=utf-8").send(html);
        }
        throw handleErr;
      }

      // Se veio do browser (redirect do ML), redirecionar para a página de callback do frontend
      // para que o postMessage funcione e o popup feche corretamente
      if (isBrowserRedirect) {
        return reply.redirect(
          `${frontendUrl}/integracoes/mercado-livre/callback?result=success`,
        );
      }

      return reply.send({
        success: true,
        message: "Conta conectada com sucesso",
        account: {
          id: account.id,
          platform: account.platform,
          status: account.status,
          createdAt: account.createdAt,
        },
      });
    } catch (error) {
      if (isBrowserRedirect) {
        const errorMsg =
          error instanceof Error ? error.message : "Erro desconhecido";
        return reply.redirect(
          `${frontendUrl}/integracoes/mercado-livre/callback?result=error&message=${encodeURIComponent(errorMsg)}`,
        );
      }
      return reply.status(500).send({
        error: "Erro ao processar callback",
        message: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  // POST /ml/callback — pode ser OAuth callback (code+state) OU webhook notification (resource+topic+user_id)
  app.post(
    "/ml/callback",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body || {}) as Record<string, any>;
      const query = (request.query || {}) as Record<string, any>;

      // --- Webhook notification do Mercado Livre (resource + topic + user_id) ---
      if (body.resource || body.topic || body.user_id) {
        // Retornar 200 imediatamente (ML espera resposta rápida para parar de reenviar)
        reply.status(200).send({ received: true });

        // Processar webhook em background (fire-and-forget)
        setImmediate(async () => {
          try {
            if (
              body.topic === "questions" &&
              WebhookUseCase.validateQuestionWebhookPayload(body)
            ) {
              const result = await WebhookUseCase.processQuestionWebhook(body);
              if (result.success) {
                console.log(
                  `[ML Webhook] Pergunta processada: ${result.action} (question: ${result.questionId ?? "?"})`,
                );
              } else {
                console.warn(`[ML Webhook] Falha em pergunta: ${result.error}`);
              }
            } else if (
              body.topic === "items" &&
              WebhookUseCase.validateItemWebhookPayload(body)
            ) {
              const result = await WebhookUseCase.processItemWebhook(body);
              if (result.success) {
                console.log(
                  `[ML Webhook] Item processado: ${result.action} (item: ${result.itemId ?? "?"}${result.productId ? `, product: ${result.productId}` : ""})`,
                );
              } else {
                console.warn(`[ML Webhook] Falha em item: ${result.error}`);
              }
            } else if (WebhookUseCase.validateWebhookPayload(body)) {
              const result = await WebhookUseCase.processOrderWebhook(body);
              if (result.success) {
                console.log(
                  `[ML Webhook] Processado com sucesso: ${result.action} (order: ${result.orderId})`,
                );
              } else {
                console.warn(
                  `[ML Webhook] Falha no processamento: ${result.error}`,
                );
              }
            } else {
              console.log(
                `[ML Webhook] Payload ignorado (topic: ${body.topic || "unknown"})`,
              );
            }
          } catch (err) {
            console.error(
              "[ML Webhook] Erro no processamento em background:",
              err instanceof Error ? err.message : err,
            );
          }
        });

        return reply;
      }

      // --- OAuth callback (code + state) ---
      try {
        const code =
          (body.code as string | undefined) ||
          (query.code as string | undefined);
        const state =
          (body.state as string | undefined) ||
          (query.state as string | undefined);

        if (!code || !state) {
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message: "code e state são obrigatórios",
          });
        }

        const userId = request.user?.dataOwnerId;

        const account = await MarketplaceUseCase.handleOAuthCallback({
          code,
          state,
          userId,
        });

        return reply.send({
          success: true,
          message: "Conta conectada com sucesso",
          account: {
            id: account.id,
            platform: account.platform,
            status: account.status,
            createdAt: account.createdAt,
          },
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao processar callback",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/status
   * Verifica status de conexÃ£o com Mercado Livre
   * Retorna se conta estÃ¡ conectada e ativa
   */
  app.get<{
    Reply: {
      connected: boolean;
      platform: string;
      status?: string;
      restricted?: boolean;
      message: string;
    };
  }>(
    "/ml/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        // Obter status da conexÃ£o
        const statusData = await MarketplaceUseCase.getAccountStatus(
          userId,
          Platform.MERCADO_LIVRE,
        );

        console.log(
          `[/ml/status] userId=${userId} connected=${statusData.connected} status=${statusData.account?.status} restricted=${(statusData as any).restricted}`,
        );

        return reply.send({
          connected: statusData.connected,
          platform: Platform.MERCADO_LIVRE,
          status: statusData.account?.status,
          restricted: (statusData as any).restricted || false,
          message: statusData.message,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao obter status",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/categories
   * Lista categorias do Mercado Livre já sincronizadas (flatten)
   */
  app.get(
    "/ml/categories",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const q = request.query as any;
        const showAll = q?.all === "1" || q?.all === "true";
        const raw = await CategoryRepository.listFlattenedOptions("MLB");
        let list = raw || [];
        // Restrição de nicho: só categorias sob a raiz veicular (MLB5672),
        // excluindo ramos bloqueados (ex.: motos). Fonte única com a sugestão
        // (getVehicleRootSet). Fail-open: árvore não sincronizada (set vazio)
        // → não filtra, não trava o usuário. Escape hatch: ?all=1.
        if (!showAll) {
          try {
            const set = await getVehicleRootSet("MLB");
            if (set.size > 0) {
              const niche = list.filter((c: any) => {
                const extId = c.externalId || c.id;
                if (!set.has(extId)) return false;
                const p = normalizePath(c.fullPath || c.name || "");
                return !ML_BLOCKED_BRANCHES.some((b) => p.includes(b));
              });
              // fail-open-to-raw: se o filtro esvaziaria uma lista não-vazia
              // (árvore parcial/dessincronizada), devolve a lista crua.
              if (niche.length > 0) list = niche;
            }
          } catch {
            // fail-open: falha transitória ao montar o set veicular não pode
            // derrubar a listagem — devolve a lista crua (mesma filosofia da
            // sugestão, que faz skipCache/sem-filtro no throw).
          }
        }
        // Normalizar para o formato esperado pelo front: { id, value }
        const categories = list.map((c: any) => ({
          id: c.externalId || c.id,
          value: c.fullPath || c.name || c.externalId || c.id,
        }));
        reply.header("Cache-Control", "private, max-age=600");
        return reply.send({ categories });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao listar categorias",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/categories/:categoryId/attributes
   * Devolve a ficha técnica oficial da categoria (GET /categories/{id}/attributes
   * do ML) já normalizada. Service é fail-open: erros viram [].
   */
  app.get(
    "/ml/categories/:categoryId/attributes",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { categoryId } = request.params as { categoryId?: string };
      if (!categoryId || !categoryId.trim()) {
        return reply
          .status(400)
          .send({ error: "Parâmetro 'categoryId' é obrigatório" });
      }
      try {
        const attributes = await MLAttributeCatalogService.getAll(
          categoryId.trim(),
        );
        reply.header("Cache-Control", "private, max-age=600");
        return reply.send({ attributes });
      } catch (error) {
        // Service já é fail-open, mas garantimos contrato 200/{attributes:[]}
        return reply.send({ attributes: [] });
      }
    },
  );

  /**
   * GET /marketplace/ml/category-suggest?title=...
   * Sugere categorias do ML com base no título normalizado usando catálogo sincronizado.
   */
  app.get(
    "/ml/category-suggest",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const title = (request.query as any)?.title as string | undefined;
      if (!title || !title.trim()) {
        return reply
          .status(400)
          .send({ error: "Parâmetro 'title' é obrigatório" });
      }

      try {
        const suggestions =
          await CategorySuggestionService.suggestFromTitle(title);
        return reply.send(suggestions);
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sugerir categorias",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/catalog/suggestions?q=...&category_id=...&limit=5
   * Sugere catalog products do Mercado Livre a partir do título do produto.
   * Fail-open: erros de API viram 200/{suggestions:[]}.
   */
  app.get(
    "/ml/catalog/suggestions",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = (request.query as any)?.q as string | undefined;
      const categoryId = (request.query as any)?.category_id as
        string | undefined;
      const limitRaw = (request.query as any)?.limit as string | undefined;
      const limit = limitRaw ? Number(limitRaw) : undefined;

      if (!q || q.trim().length < 3) {
        return reply.send({ suggestions: [] });
      }

      try {
        const suggestions = await MLCatalogSuggestionUseCase.listSuggestions(
          q.trim(),
          {
            categoryId: categoryId?.trim() || undefined,
            limit: Number.isFinite(limit) ? (limit as number) : undefined,
          },
        );
        console.log(
          JSON.stringify({
            event: "ml.catalog.suggestions.served",
            qLength: q.trim().length,
            count: suggestions.length,
            hasCategoryFilter: !!categoryId,
          }),
        );
        reply.header("Cache-Control", "private, max-age=120");
        return reply.send({ suggestions });
      } catch {
        return reply.send({ suggestions: [] });
      }
    },
  );

  /**
   * GET /marketplace/ml/catalog/products/:catalogProductId
   * Retorna detalhes normalizados de um catalog product do ML.
   * 404 quando o id não existe ou a API falhar.
   */
  app.get(
    "/ml/catalog/products/:catalogProductId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { catalogProductId } = request.params as {
        catalogProductId?: string;
      };
      if (!catalogProductId || !catalogProductId.trim()) {
        return reply
          .status(400)
          .send({ error: "Parâmetro 'catalogProductId' é obrigatório" });
      }

      try {
        const detail = await MLCatalogSuggestionUseCase.getProductDetail(
          catalogProductId.trim(),
        );
        if (!detail) {
          return reply
            .status(404)
            .send({ error: "catalog product não encontrado" });
        }
        console.log(
          JSON.stringify({
            event: "ml.catalog.product.fetched",
            catalogProductId: detail.catalogProductId,
            categoryId: detail.categoryId,
            domainId: detail.domainId,
            attributesCount: Object.keys(detail.attributes || {}).length,
            compatCount: detail.compatibilities.length,
          }),
        );
        reply.header("Cache-Control", "private, max-age=300");
        return reply.send({ product: detail });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao buscar catalog product",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/internal/suggest?title=...
   * Sugestão da BASE INTERNA: casa o título contra CatalogStat (agregados de
   * todos os produtos) e devolve campos para preencher só os vazios do form.
   * Fail-open: erros viram 200 com { suggestion: null }. Só agregados — nunca
   * dado individual, userId, loja, costPrice ou markup. Herda o rate-limit global.
   */
  app.get(
    "/internal/suggest",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const title = (request.query as any)?.title as string | undefined;
      if (!title || !title.trim()) {
        return reply
          .status(400)
          .send({ error: "Parâmetro 'title' é obrigatório" });
      }

      try {
        const result = await InternalSuggestionUseCase.suggestFromTitle(
          title.trim(),
        );
        console.log(
          JSON.stringify({
            event: "internal.suggest.served",
            hasSuggestion: !!result.suggestion,
            confidence: result.suggestion?.confidence ?? null,
            sampleSize: result.suggestion?.sampleSize ?? null,
          }),
        );
        reply.header("Cache-Control", "private, max-age=120");
        return reply.send(result);
      } catch {
        // Fail-open: nunca derruba o cadastro por causa da sugestão.
        return reply.send({ suggestion: null, reason: "insufficient_sample" });
      }
    },
  );

  /**
   * GET /marketplace/ml/listings
   * Lista todos os anÃºncios vinculados (multi-contas)
   */
  app.get<{
    Reply: {
      success: boolean;
      count: number;
      listings: Array<{
        id: string;
        productId: string;
        externalListingId: string;
        externalSku: string | null;
        permalink: string | null;
        status: string;
        createdAt: Date;
        product?: {
          name: string;
          sku: string;
          stock: number;
        };
      }>;
    };
  }>(
    "/ml/listings",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        const accounts =
          accountIds && accountIds.length > 0
            ? await prisma.marketplaceAccount.findMany({
                where: {
                  id: { in: accountIds },
                  userId,
                  platform: Platform.MERCADO_LIVRE,
                },
              })
            : await MarketplaceRepository.findAllByUserIdAndPlatform(
                userId,
                Platform.MERCADO_LIVRE,
              );

        if (!accounts || accounts.length === 0) {
          return reply.status(404).send({
            error: "Conta nÃ£o encontrada",
            message: "Conecte sua conta do Mercado Livre primeiro",
          });
        }

        const listingsArrays = await Promise.all(
          accounts.map((acc) =>
            prisma.productListing.findMany({
              where: { marketplaceAccountId: acc.id },
              select: {
                id: true,
                productId: true,
                externalListingId: true,
                externalSku: true,
                permalink: true,
                status: true,
                lastError: true,
                createdAt: true,
                product: {
                  select: { name: true, sku: true, stock: true },
                },
              },
              orderBy: { createdAt: "desc" },
            }),
          ),
        );

        const listings = listingsArrays.flat();

        return reply.send({
          success: true,
          count: listings.length,
          listings,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao buscar anÃºncios",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/accounts
   * Lista todas as contas ML do usuário (multi-contas)
   */
  app.get(
    "/ml/accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        );
        return reply.send({ accounts });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao listar contas",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * DELETE /marketplace/ml
   * Desconecta conta do Mercado Livre (aceita accountId para multi-contas)
   */
  app.delete<{ Reply: { success: boolean; message: string } }>(
    "/ml",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        await MarketplaceUseCase.disconnectAccount(
          userId,
          Platform.MERCADO_LIVRE,
          accountId,
        );

        return reply.send({
          success: true,
          message: "Conta Mercado Livre desconectada com sucesso",
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao desconectar conta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/ml/import
   * Importa anúncios ATIVOS de TODAS as contas ACTIVE do dono e cria+vincula os
   * produtos (dedup por SKU via núcleo). Responde 202 com importId; a aba faz
   * polling em GET /ml/import/:importId. `accountId` opcional restringe a 1 conta.
   */
  app.post(
    "/ml/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        const job = await SyncUseCase.startMLImportJob(userId, accountId);

        return reply.status(202).send({
          success: true,
          importId: job.importId,
          status: job.status,
          message: job.message,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar importação do Mercado Livre",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/import/:importId — status/resultado do job de importação.
   */
  app.get<{ Params: { importId: string } }>(
    "/ml/import/:importId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { importId } = request.params as { importId: string };
        const status = await SyncUseCase.getGenericImportJobStatus(
          userId,
          importId,
        );
        return reply.send({
          success: true,
          importId: status.importId,
          status: status.status,
          progress: status.progress,
          result: status.result,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro desconhecido";
        const statusCode = /não encontrada|not found/i.test(message)
          ? 404
          : 500;
        return reply.status(statusCode).send({
          error: "Erro ao consultar importação do Mercado Livre",
          message,
        });
      }
    },
  );

  /**
   * POST /marketplace/ml/sync
   * Sincroniza estoque de todos os produtos vinculados ao ML (multi-contas)
   * Retorna 202 imediatamente e processa em segundo plano para evitar timeout nginx
   */
  app.post(
    "/ml/sync",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        // Responder 202 imediatamente para evitar 504 do nginx
        reply.status(202).send({
          success: true,
          message: "Sincronização iniciada em segundo plano",
          total: 0,
          successful: 0,
          failed: 0,
          results: [],
        });

        // Processar sync em background (fire-and-forget)
        setImmediate(async () => {
          try {
            const result = await SyncUseCase.syncAllStock(
              userId,
              Platform.MERCADO_LIVRE,
              accountIds,
            );

            await SystemLogService.logSyncComplete(
              userId,
              "FULL_SYNC",
              "MercadoLivre",
              {
                total: result.total,
                successful: result.successful,
                failed: result.failed,
              },
            );
            console.log(
              `[ml/sync] Background sync complete: ${result.successful}/${result.total} OK, ${result.failed} failed`,
            );
          } catch (bgErr) {
            console.error(
              `[ml/sync] Background sync error:`,
              bgErr instanceof Error ? bgErr.message : bgErr,
            );
          }
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar sincronização do Mercado Livre",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/ml/sync/:productId
   * Sincroniza estoque de um produto especÃ­fico no ML
   */
  app.post<{
    Params: { productId: string };
    Reply: {
      success: boolean;
      results: {
        productId: string;
        externalListingId: string;
        previousStock?: number;
        newStock?: number;
        error?: string;
      }[];
    };
  }>(
    "/ml/sync/:productId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { productId } = request.params as { productId: string };

        const result = await SyncUseCase.syncProductStock(productId);
        const successful = result.filter((r) => r.success);
        const failed = result.filter((r) => !r.success);

        await SystemLogService.logSyncComplete(
          userId,
          "PRODUCT_SYNC",
          "MercadoLivre",
          {
            productId,
            successful: successful.length,
            failed: failed.length,
          },
        );

        return reply.send({
          success: failed.length === 0,
          results: result,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sincronizar estoque do produto no ML",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/ml/retry-pending
   * ForÃ§a uma execuÃ§Ã£o imediata do worker de retry de anÃºncios pendentes (placeholders)
   */
  app.post(
    "/ml/retry-pending",
    { preHandler: [authMiddleware] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        await ListingRetryService.runOnce();
        return reply.send({ success: true, message: "Retry disparado" });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar retry de anÃºncios pendentes",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/shopee/sync-categories
   * Sincroniza categorias do Shopee para o banco local (MarketplaceCategory com siteId="SHP")
   */
  app.post(
    "/shopee/sync-categories",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;

        // Buscar uma conta Shopee conectada para usar nas chamadas da API
        const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        );
        const active = (accounts || []).find(
          (acc) => acc.status === "ACTIVE" && acc.accessToken && acc.shopId,
        );
        if (!active) {
          return reply.status(400).send({
            error: "Nenhuma conta Shopee ativa encontrada",
            message:
              "Conecte uma conta do Shopee antes de sincronizar categorias.",
          });
        }

        const shopId =
          typeof active.shopId === "string"
            ? parseInt(active.shopId)
            : (active.shopId as number);

        const categoryResponse = await ShopeeApiService.getCategories(
          active.accessToken!,
          shopId,
          "pt-BR",
        );

        const categoryList = (categoryResponse.category_list || []) as any[];

        // A API v2 usa display_category_name (localizado) ou original_category_name
        const getName = (cat: any): string =>
          cat.display_category_name ||
          cat.category_name ||
          cat.original_category_name ||
          `Cat_${cat.category_id}`;

        // Construir mapa de nomes por ID para fullPath
        const nameMap = new Map<number, string>();
        for (const cat of categoryList) {
          nameMap.set(cat.category_id, getName(cat));
        }

        // Construir fullPath a partir do parent
        const buildFullPath = (cat: any): string => {
          const parts: string[] = [];
          let currentParentId = cat.parent_category_id;
          parts.unshift(getName(cat));
          while (currentParentId && currentParentId > 0) {
            const parentName = nameMap.get(currentParentId);
            if (parentName) {
              parts.unshift(parentName);
            }
            // Encontrar o parent para subir na árvore
            const parentCat = categoryList.find(
              (c) => c.category_id === currentParentId,
            );
            currentParentId = parentCat?.parent_category_id ?? 0;
          }
          return parts.join(" > ");
        };

        const entries = categoryList.map((cat: any) => ({
          externalId: `SHP_${cat.category_id}`,
          siteId: "SHP",
          name: getName(cat),
          fullPath: buildFullPath(cat),
          pathFromRoot: [cat.parent_category_id, cat.category_id],
          parentExternalId:
            cat.parent_category_id > 0 ? `SHP_${cat.parent_category_id}` : null,
          keywords: null,
        }));

        await CategoryRepository.upsertMany(entries);

        return reply.send({
          success: true,
          count: entries.length,
          message: `${entries.length} categorias do Shopee sincronizadas.`,
        });
      } catch (error) {
        console.error("[shopee/sync-categories] Erro:", error);
        return reply.status(500).send({
          error: "Erro ao sincronizar categorias do Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/categories
   * Lista categorias do Shopee já sincronizadas (flatten)
   */
  app.get(
    "/shopee/categories",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const q = request.query as any;
        const showAll = q?.all === "1" || q?.all === "true";
        const raw = await CategoryRepository.listFlattenedOptions("SHP");
        let list = raw || [];
        // Nicho Shopee: ramos bloqueados (motos/barcos/pesados) são hard-drop;
        // marcadores automotivos são SOFT (fail-open-to-raw se esvaziarem a
        // lista, para não sumir categoria legítima com path atípico).
        // Escape hatch: ?all=1.
        if (!showAll) {
          const noBlocked = list.filter((c: any) => {
            const p = normalizePath(c.fullPath || c.name || "");
            return !SHOPEE_BLOCKED_BRANCHES.some((b) => p.includes(b));
          });
          const inNiche = noBlocked.filter((c: any) => {
            const p = normalizePath(c.fullPath || c.name || "");
            return SHOPEE_AUTOMOTIVE_MARKERS.some((m) => p.includes(m));
          });
          list = inNiche.length > 0 ? inNiche : noBlocked;
        }
        const categories = list.map((c: any) => ({
          id: c.externalId || c.id,
          value: c.fullPath || c.name || c.externalId || c.id,
        }));
        return reply.send({ categories });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao listar categorias Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/category-suggest?title=...
   * Sugere categorias do Shopee com base no título usando catálogo sincronizado.
   */
  app.get(
    "/shopee/category-suggest",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const title = (request.query as any)?.title as string | undefined;
      if (!title || !title.trim()) {
        return reply
          .status(400)
          .send({ error: "Parâmetro 'title' é obrigatório" });
      }

      try {
        const suggestions = await CategorySuggestionService.suggestFromTitle(
          title,
          "SHP",
        );
        if (suggestions.suggestions.length > 0) {
          console.log(
            `[SHP suggest] "${title}" → ${suggestions.suggestions.length} results, top: ${suggestions.suggestions[0].categoryId} conf=${suggestions.suggestions[0].confidence?.toFixed(3)} path="${suggestions.suggestions[0].fullPath?.substring(0, 80)}"`,
          );
        } else {
          console.log(
            `[SHP suggest] "${title}" → 0 results (tokens: ${suggestions.tokens.join(",")})`,
          );
        }
        return reply.send(suggestions);
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sugerir categorias Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/shopee/import
   * Importa todos os itens do Shopee e tenta vincular por SKU
   * Retorna lista de itens importados com status de vinculação
   */
  app.get(
    "/shopee/accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        );

        const enriched = await Promise.all(
          accounts.map(async (acc) => {
            if (!acc.shopId || !acc.accessToken) return acc;
            try {
              const info: any = await ShopeeApiService.getShopInfo(
                acc.accessToken,
                acc.shopId,
              );
              const payload = info?.response ?? info;
              const shopName =
                payload?.shop_name || payload?.shopName || undefined;
              const region = payload?.region || undefined;
              const merchantName =
                payload?.merchant_name || payload?.merchantName || undefined;
              return { ...acc, shopName, region, merchantName };
            } catch (err) {
              request.log?.warn?.(
                { err, accountId: acc.id },
                "shopee get_shop_info falhou, usando fallback",
              );
              return acc;
            }
          }),
        );

        return reply.send({ accounts: enriched });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao listar contas Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  app.post<{
    Reply: {
      success: boolean;
      importId: string;
      status: string;
      message: string;
    };
  }>(
    "/shopee/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        const job = await SyncUseCase.startShopeeImportJob(userId, accountId);

        return reply.status(202).send({
          success: true,
          importId: job.importId,
          status: job.status,
          message: job.message,
        });
      } catch (error) {
        console.error(
          "[shopee/import] Error:",
          error instanceof Error ? error.stack : error,
        );
        return reply.status(500).send({
          error: "Erro ao importar itens",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  app.get<{
    Params: { importId: string };
  }>(
    "/shopee/import/:importId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { importId } = request.params as { importId: string };
        const status = await SyncUseCase.getShopeeImportJobStatus(
          userId,
          importId,
        );

        return reply.send({
          success: true,
          importId: status.importId,
          status: status.status,
          progress: status.progress,
          result: status.result,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro desconhecido";
        const statusCode = /não encontrada|not found/i.test(message)
          ? 404
          : 500;
        return reply.status(statusCode).send({
          error: "Erro ao consultar importação Shopee",
          message,
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/listings
   * Lista todos os anÃºncios vinculados do Shopee
   * Requer autenticaÃ§Ã£o
   */
  app.get<{
    Reply: {
      success: boolean;
      count: number;
      listings: Array<{
        id: string;
        productId: string;
        externalListingId: string;
        externalSku: string | null;
        status: string;
        permalink: string | null;
        shopId?: number | null;
        createdAt: Date;
      }>;
    };
  }>(
    "/shopee/listings",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        // Buscar contas do marketplace
        const accounts =
          accountIds && accountIds.length > 0
            ? await prisma.marketplaceAccount.findMany({
                where: {
                  id: { in: accountIds },
                  userId,
                  platform: Platform.SHOPEE,
                },
              })
            : await MarketplaceRepository.findAllByUserIdAndPlatform(
                userId,
                Platform.SHOPEE,
              );

        if (!accounts || accounts.length === 0) {
          return reply.status(404).send({
            error: "Conta nÃ£o encontrada",
            message: "Conecte sua conta do Shopee primeiro",
          });
        }

        // Buscar listings de todas as contas selecionadas
        const listingsArrays = await Promise.all(
          accounts.map((acc) =>
            prisma.productListing.findMany({
              where: { marketplaceAccountId: acc.id },
              select: {
                id: true,
                productId: true,
                externalListingId: true,
                externalSku: true,
                status: true,
                lastError: true,
                permalink: true,
                createdAt: true,
                marketplaceAccount: { select: { shopId: true } },
                product: {
                  select: {
                    name: true,
                    sku: true,
                    stock: true,
                  },
                },
              },
              orderBy: { createdAt: "desc" },
            }),
          ),
        );
        const listings = listingsArrays.flat();

        return reply.send({
          success: true,
          count: listings.length,
          listings: listings.map((l: any) => ({
            ...l,
            shopId: l.marketplaceAccount?.shopId ?? null,
          })),
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao buscar anÃºncios",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/shopee/sync
   * Sincroniza estoque de todos os produtos vinculados ao Shopee
   * Requer autenticaÃ§Ã£o
   */
  app.post<{
    Reply: {
      success: boolean;
      total: number;
      successful: number;
      failed: number;
      results: Array<{
        success: boolean;
        productId: string;
        externalListingId: string;
        previousStock?: number;
        newStock?: number;
        error?: string;
      }>;
    };
  }>(
    "/shopee/sync",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        // Responder 202 imediatamente para evitar 504 do nginx
        reply.status(202).send({
          success: true,
          message: "Sincronização iniciada em segundo plano",
          total: 0,
          successful: 0,
          failed: 0,
          results: [],
        });

        // Processar sync em background (fire-and-forget)
        setImmediate(async () => {
          try {
            const result = await SyncUseCase.syncAllStock(
              userId,
              Platform.SHOPEE,
              accountIds,
            );

            await SystemLogService.logSyncComplete(
              userId,
              "FULL_SYNC",
              "Shopee",
              {
                total: result.total,
                successful: result.successful,
                failed: result.failed,
              },
            );
            console.log(
              `[shopee/sync] Background sync complete: ${result.successful}/${result.total} OK, ${result.failed} failed`,
            );
          } catch (bgErr) {
            console.error(
              `[shopee/sync] Background sync error:`,
              bgErr instanceof Error ? bgErr.message : bgErr,
            );
          }
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar sincronização do Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/shopee/sync/:productId
   * Sincroniza estoque de um produto especÃ­fico para o Shopee
   * Requer autenticaÃ§Ã£o
   */
  app.post<{
    Params: { productId: string };
    Reply: {
      success: boolean;
      results: {
        productId: string;
        externalListingId: string;
        previousStock?: number;
        newStock?: number;
        error?: string;
      }[];
    };
  }>(
    "/shopee/sync/:productId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        const { productId } = request.params as { productId: string };

        const result = await SyncUseCase.syncProductStock(productId);

        const successful = result.filter((r) => r.success);
        const failed = result.filter((r) => !r.success);

        // Registrar log de sincronizaÃ§Ã£o bem-sucedida
        await SystemLogService.logSyncComplete(
          userId,
          "PRODUCT_SYNC",
          "Shopee",
          {
            productId,
            successful: successful.length,
            failed: failed.length,
          },
        );

        return reply.send({
          success: failed.length === 0,
          results: result.map((r) => ({
            productId: r.productId,
            externalListingId: r.externalListingId,
            previousStock: r.previousStock,
            newStock: r.newStock,
            error: r.error,
          })),
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sincronizar produto",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * Captura o corpo CRU do push da Shopee antes do parse de JSON.
   *
   * A assinatura da Shopee é sobre os bytes originais; re-serializar o objeto
   * já parseado muda ordem de chaves e espaçamento e nunca conferiria. O hook
   * é no-op para qualquer outra rota deste plugin — devolve o `payload`
   * intacto, sem ler o stream.
   */
  /**
   * Chaves cuja verificacao bem-sucedida ja foi logada neste processo. Existe so
   * para o log de `signature_ok` sair uma vez por chave, e nao a cada push.
   */
  const chavesJaLogadas = new Set<string>();

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!request.url.split("?")[0].endsWith("/shopee/webhook")) {
      return payload;
    }
    // Com a checagem desligada não há por que bufferizar nada: devolver o
    // stream intacto é o que torna o kill-switch byte-idêntico ao anterior.
    if (process.env.SHOPEE_WEBHOOK_SIGNATURE_DISABLED === "1") {
      return payload;
    }

    // TETO DE MEMÓRIA. A rota é pública e não autenticada, e este hook roda
    // ANTES do parser — ou seja, antes do `bodyLimit` do Fastify. Sem o teto,
    // qualquer um empurra bytes indefinidamente para dentro da memória do
    // dexo-api. Passou do teto, para de acumular: a assinatura não vai conferir
    // e a requisição é recusada, que é o desfecho correto de um corpo desses.
    const TETO_BYTES = 1024 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    let estourou = false;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const b = Buffer.from(chunk);
      total += b.length;
      if (total > TETO_BYTES) {
        estourou = true;
        break;
      }
      chunks.push(b);
    }
    const raw = Buffer.concat(chunks);
    (request as any).shopeeRawBody = estourou ? undefined : raw.toString("utf8");
    if (estourou) {
      console.warn(
        JSON.stringify({
          event: "shopee.webhook.body_too_large",
          bytesLidos: total,
          tetoBytes: TETO_BYTES,
        }),
      );
    }
    return Readable.from(raw);
  });

  /**
   * POST /marketplace/shopee/webhook
   * Recebe push notifications da Shopee (configurado no Partner Portal)
   * Sem auth middleware - a Shopee envia diretamente, autenticada pelo HMAC
   * do header Authorization.
   * Codigos de pedido: 3 = order_status_push, 4 = order_trackingno_push
   * (conferido no console em 30/07/2026 — o comentario anterior invertia os dois).
   */
  app.post(
    "/shopee/webhook",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body || {}) as Record<string, any>;

      // Assinatura HMAC-SHA256 sobre "<url do callback>|<corpo cru>".
      //
      // Antes desta checagem a rota era completamente aberta: qualquer POST com
      // {shop_id, code:4} de uma loja conhecida disparava importação com baixa
      // de estoque e consumia a chave de idempotência do evento.
      //
      // Só bloqueia quando dá para verificar de verdade (partner key + URL de
      // callback conhecidas). Sem isso, apenas avisa — recusar sem poder
      // verificar perderia venda, que é justamente o que estamos consertando.
      // KILL-SWITCH: SHOPEE_WEBHOOK_SIGNATURE_DISABLED=1 desliga a checagem.
      if (process.env.SHOPEE_WEBHOOK_SIGNATURE_DISABLED !== "1") {
        // DUAS chaves candidatas, porque o console tem duas legitimas do mesmo
        // app e a documentacao nao diz qual assina o push: a "Live Push Partner
        // Key" (tela Push Mechanism) e a "Live API Partner Key" (tela do app).
        // Escolher errado rejeita 100% dos pushes com 401, em silencio.
        const candidatas = [
          {
            nome: "push",
            valor: process.env.SHOPEE_PUSH_PARTNER_KEY?.trim() || undefined,
          },
          { nome: "api", valor: SHOPEE_CONSTANTS.PARTNER_KEY },
        ];
        const partnerKey = candidatas.find((c) => c.valor)?.valor;
        const callbackUrl = ShopeeWebhookSignatureService.callbackUrl();
        const podeVerificar = Boolean(partnerKey && callbackUrl);

        if (!podeVerificar) {
          console.warn(
            "[Shopee Webhook] Assinatura NAO verificada (falta SHOPEE_PARTNER_KEY ou APP_BACKEND_URL/SHOPEE_WEBHOOK_URL). Rota segue aberta.",
          );
        } else {
          const veredito = ShopeeWebhookSignatureService.verifyAny(
            callbackUrl,
            (request as any).shopeeRawBody,
            request.headers["authorization"] as string | undefined,
            candidatas,
          );

          // Qual chave conferiu, uma vez por chave por processo: sem isto a
          // resposta ficaria sendo inferida do comportamento, e trocar uma das
          // chaves viraria um 401 sem explicacao.
          if (veredito.ok && veredito.chave && !chavesJaLogadas.has(veredito.chave)) {
            chavesJaLogadas.add(veredito.chave);
            console.log(
              JSON.stringify({
                event: "shopee.webhook.signature_ok",
                chave: veredito.chave,
                callbackUrl,
              }),
            );
          }

          if (!veredito.ok) {
            console.warn(
              JSON.stringify({
                event: "shopee.webhook.invalid_signature",
                shopId: body?.shop_id ?? null,
                code: body?.code ?? null,
                hasAuthorization: Boolean(request.headers["authorization"]),
                callbackUrl,
              }),
            );
            void SystemLogService.logError(
              "SYNC_ORDERS",
              "Webhook Shopee rejeitado: assinatura HMAC nao confere.",
              {
                resource: "MarketplaceAccount",
                details: {
                  platform: "SHOPEE",
                  shopId: body?.shop_id ?? null,
                  code: body?.code ?? null,
                  // Se a URL cadastrada no Partner Portal diferir desta, TODO
                  // push cai aqui — conferir antes de suspeitar de ataque.
                  callbackUrl,
                },
              },
            ).catch(() => {});
            return reply.status(401).send({ error: "assinatura invalida" });
          }
        }
      }

      // Retornar 200 imediatamente (Shopee espera resposta rápida)
      reply.status(200).send({ received: true });

      // Processar em background
      setImmediate(async () => {
        try {
          const shopId = body.shop_id as number | undefined;
          const code = body.code as number | undefined;

          if (!shopId || !code) {
            console.log(
              "[Shopee Webhook] Payload sem shop_id ou code, ignorando",
            );
            return;
          }

          // 3 = order_status_push, 4 = order_trackingno_push. Os DOIS entram:
          // o de status traz a mudanca de estado e o de rastreio confirma envio.
          if (code !== 3 && code !== 4) {
            console.log(
              `[Shopee Webhook] Código ${code} ignorado (não é pedido)`,
            );
            return;
          }

          console.log(
            `[Shopee Webhook] Recebido code=${code}, shop_id=${shopId}, order=${body.data?.ordersn || "N/A"}`,
          );

          const result = await WebhookUseCase.processShopeeOrderWebhook(
            body as any,
          );

          if (result.success) {
            console.log(
              `[Shopee Webhook] Processado com sucesso: ${result.action}`,
            );
          } else {
            console.warn(
              `[Shopee Webhook] Falha no processamento: ${result.error}`,
            );
            // Já respondemos 200: a Shopee considera o evento entregue. Sem
            // este registro, uma venda perdida aqui não deixa rastro nenhum em
            // banco — só uma linha no log do processo. O claim é liberado pelo
            // use case, então a reentrega ainda pode salvar. Espelha o que a
            // rota da Magalu já fazia.
            void SystemLogService.logError(
              "SYNC_ORDERS",
              `Webhook Shopee falhou no processamento: ${result.error ?? "erro desconhecido"}`,
              {
                resource: "Order",
                details: {
                  platform: "SHOPEE",
                  shopId,
                  code,
                  ordersn: body?.data?.ordersn ?? null,
                  accountId: result.accountId ?? null,
                },
              },
            ).catch(() => {});
          }
        } catch (err) {
          console.error(
            "[Shopee Webhook] Erro no processamento em background:",
            err instanceof Error ? err.message : err,
          );
        }
      });

      return reply;
    },
  );

  /**
   * POST /marketplace/shopee/auth
   * Inicia fluxo de autenticação com Shopee
   * Retorna URL para redirecionamento do usuário
   * Requer autenticação - userId vem da sessão
   */
  app.post<{
    Reply: { authUrl: string; state: string };
  }>(
    "/shopee/auth",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // userId vem da sessÃ£o (garantido pelo authMiddleware)
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        // Gerar URL de autorizaÃ§Ã£o
        const { authUrl, state } =
          MarketplaceUseCase.initiateShopeeOAuth(userId);

        // Retornar URL + state (state serÃ¡ usado no callback)
        return reply.send({
          authUrl,
          state,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar autenticaÃ§Ã£o Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/callback?code=...&shop_id=...
   * Callback do OAuth apÃ³s usuÃ¡rio autorizar no Shopee
   * Processa o authorization code e cria sessÃ£o
   * Nota: NÃƒO requer autenticaÃ§Ã£o prÃ©via - userId vem do state
   */
  app.get<{
    Querystring: { code?: string; shop_id?: string; state?: string };
    Reply: { success: boolean; message: string };
  }>(
    "/shopee/callback",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Detectar se é um redirect do browser (vindo do Shopee) ou chamada da API (fetch)
      const acceptHeader = (
        (request.headers.accept as string) || ""
      ).toString();
      const isBrowserRedirect = acceptHeader.includes("text/html");
      const frontendUrl =
        process.env.NEXTAUTH_URL ||
        process.env.CORS_ORIGIN ||
        "http://localhost:3000";

      try {
        const code = (request.query as any).code as string | undefined;
        const shopIdStr = (request.query as any).shop_id as string | undefined;
        const state = (request.query as any).state as string | undefined;

        // Validar parâmetros obrigatórios
        if (!code || !shopIdStr) {
          if (isBrowserRedirect) {
            return reply.redirect(
              `${frontendUrl}/integracoes/shopee/callback?result=error&message=${encodeURIComponent("code e shop_id são obrigatórios")}`,
            );
          }
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message: "code e shop_id são obrigatórios",
          });
        }

        const shopId = parseInt(shopIdStr);
        if (isNaN(shopId)) {
          if (isBrowserRedirect) {
            return reply.redirect(
              `${frontendUrl}/integracoes/shopee/callback?result=error&message=${encodeURIComponent("shop_id deve ser um número válido")}`,
            );
          }
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message: "shop_id deve ser um número válido",
          });
        }

        // Recuperar userId: (1) do state token armazenado, (2) da sessão atual
        // Usar dataOwnerId garante que se houver fallback de sessão, a conta vai
        // pro admin (não pro colaborador) — colaboradores estão bloqueados
        // de qualquer forma pelo blockCollaborator no /shopee/auth.
        let userId = state ? ShopeeOAuthService.consumeState(state) : null;
        if (!userId) {
          userId = request.user?.dataOwnerId ?? null;
        }

        if (!userId) {
          console.error(
            "[Shopee callback] userId não encontrado. state=",
            state ?? "(ausente)",
            "query=",
            JSON.stringify(request.query),
          );
          if (isBrowserRedirect) {
            return reply.redirect(
              `${frontendUrl}/integracoes/shopee/callback?result=error&message=${encodeURIComponent("state (userId) é obrigatório para processar callback Shopee")}`,
            );
          }
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message:
              "state (userId) é obrigatório para processar callback Shopee",
          });
        }

        console.log(
          "[Shopee callback] userId resolvido:",
          userId,
          "via",
          state ? "state" : "session",
        );

        // Processar callback OAuth
        const account = await MarketplaceUseCase.handleShopeeOAuthCallback({
          code,
          shopId,
          userId,
        });

        // Se veio do browser (redirect do Shopee), redirecionar para a página de callback do frontend
        // para que o postMessage funcione e o popup feche corretamente
        if (isBrowserRedirect) {
          return reply.redirect(
            `${frontendUrl}/integracoes/shopee/callback?result=success`,
          );
        }

        return reply.send({
          success: true,
          message: "Conta Shopee conectada com sucesso",
          account: {
            id: account.id,
            platform: account.platform,
            status: account.status,
            shopId: account.shopId,
            createdAt: account.createdAt,
          },
        });
      } catch (error) {
        if (isBrowserRedirect) {
          const errorMsg =
            error instanceof Error ? error.message : "Erro desconhecido";
          return reply.redirect(
            `${frontendUrl}/integracoes/shopee/callback?result=error&message=${encodeURIComponent(errorMsg)}`,
          );
        }
        return reply.status(500).send({
          error: "Erro ao processar callback Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/status
   * Verifica status de conexÃ£o com Shopee
   * Retorna se conta estÃ¡ conectada e ativa
   */
  app.get<{
    Reply: {
      connected: boolean;
      platform: string;
      status?: string;
      shopId?: number;
      message: string;
    };
  }>(
    "/shopee/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        // Obter status da conexÃ£o
        const statusData = await MarketplaceUseCase.getShopeeAccountStatus(
          userId,
          accountId,
        );

        return reply.send({
          connected: statusData.connected,
          platform: Platform.SHOPEE,
          status: statusData.account?.status,
          shopId: statusData.account?.shopId,
          message: statusData.message,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao obter status Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  // =========================================================================
  // Compatibilidade nativa do ML (seletor guiado do modal de produtos)
  // =========================================================================

  /**
   * GET /marketplace/ml/compatibility/brands
   * Retorna marcas oficiais do domínio MLB-CARS_AND_VANS.
   */
  app.get<{ Querystring: { accountId?: string } }>(
    "/ml/compatibility/brands",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountId = (request.query as any)?.accountId as
          string | undefined;
        const resolved = await resolveMlAccountForCompat(userId, accountId);
        if (!resolved) {
          return reply.status(412).send({
            error: "ML_ACCOUNT_REQUIRED",
            message:
              "Conecte uma conta ativa do Mercado Livre para usar o seletor guiado de compatibilidade.",
          });
        }

        const brands = await MLApiService.listCompatibilityBrands(
          resolved.accessToken,
        );
        return reply.status(200).send({
          accountId: resolved.accountId,
          brands,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[marketplace:ml-compat] brands error:", msg);
        return reply
          .status(500)
          .send({ error: "ML_COMPAT_BRANDS_FAILED", message: msg });
      }
    },
  );

  /**
   * GET /marketplace/ml/compatibility/models?brandValueId=...&brandName=...
   */
  app.get<{
    Querystring: {
      brandValueId?: string;
      brandName?: string;
      accountId?: string;
    };
  }>(
    "/ml/compatibility/models",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { brandValueId, brandName, accountId } =
          (request.query as any) || {};
        if (!brandValueId || typeof brandValueId !== "string") {
          return reply
            .status(400)
            .send({ error: "brandValueId é obrigatório" });
        }

        const resolved = await resolveMlAccountForCompat(userId, accountId);
        if (!resolved) {
          return reply.status(412).send({
            error: "ML_ACCOUNT_REQUIRED",
            message:
              "Conecte uma conta ativa do Mercado Livre para usar o seletor guiado de compatibilidade.",
          });
        }

        const models = await MLApiService.listCompatibilityModels(
          resolved.accessToken,
          { valueId: brandValueId, name: brandName },
        );
        return reply.status(200).send({
          accountId: resolved.accountId,
          models,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[marketplace:ml-compat] models error:", msg);
        return reply
          .status(500)
          .send({ error: "ML_COMPAT_MODELS_FAILED", message: msg });
      }
    },
  );

  /**
   * GET /marketplace/ml/compatibility/vehicles?brandValueId=...&modelValueId=...
   */
  app.get<{
    Querystring: {
      brandValueId?: string;
      modelValueId?: string;
      accountId?: string;
    };
  }>(
    "/ml/compatibility/vehicles",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { brandValueId, modelValueId, accountId } =
          (request.query as any) || {};
        if (!brandValueId || typeof brandValueId !== "string") {
          return reply
            .status(400)
            .send({ error: "brandValueId é obrigatório" });
        }
        if (!modelValueId || typeof modelValueId !== "string") {
          return reply
            .status(400)
            .send({ error: "modelValueId é obrigatório" });
        }

        const resolved = await resolveMlAccountForCompat(userId, accountId);
        if (!resolved) {
          return reply.status(412).send({
            error: "ML_ACCOUNT_REQUIRED",
            message:
              "Conecte uma conta ativa do Mercado Livre para usar o seletor guiado de compatibilidade.",
          });
        }

        const vehicles = await MLApiService.listCompatibilityVehicles(
          resolved.accessToken,
          { valueId: brandValueId },
          { valueId: modelValueId },
        );
        return reply.status(200).send({
          accountId: resolved.accountId,
          vehicles,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[marketplace:ml-compat] vehicles error:", msg);
        return reply
          .status(500)
          .send({ error: "ML_COMPAT_VEHICLES_FAILED", message: msg });
      }
    },
  );

  /**
   * DELETE /marketplace/shopee
   * Desconecta conta do Shopee
   */
  app.delete<{ Reply: { success: boolean; message: string } }>(
    "/shopee",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        // Desconectar marketplace
        await MarketplaceUseCase.disconnectShopeeAccount(userId, accountId);

        return reply.send({
          success: true,
          message: "Conta Shopee desconectada com sucesso",
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao desconectar conta Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  // ====================================================================
  // ROTAS MAGALU (espelham o padrão /ml/*). Toda a integração é aditiva e
  // só é exercitada quando a flag NEXT_PUBLIC_MAGALU_INTEGRATION_ENABLED
  // está ligada no front. Webhook + import/sync entram nas Entregas C/D.
  // ====================================================================

  /**
   * POST /marketplace/magalu/auth
   * Inicia o fluxo OAuth (ID Magalu). userId vem da sessão.
   */
  app.post<{ Reply: { authUrl: string; state: string } }>(
    "/magalu/auth",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { authUrl, state } =
          MarketplaceUseCase.initiateMagaluOAuth(userId);
        return reply.send({ authUrl, state });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar autenticação",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/magalu/callback?code=...&state=...
   * Callback OAuth da Magalu. Não requer auth prévia — userId vem do state.
   */
  app.get<{
    Querystring: { code?: string; state?: string };
  }>(
    "/magalu/callback",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const acceptHeader = (
        (request.headers.accept as string) || ""
      ).toString();
      const isBrowserRedirect = acceptHeader.includes("text/html");
      const frontendUrl =
        process.env.NEXTAUTH_URL ||
        process.env.CORS_ORIGIN ||
        "http://localhost:3000";

      try {
        const code = (request.query as any).code as string | undefined;
        const state = (request.query as any).state as string | undefined;

        if (!code || !state) {
          if (isBrowserRedirect) {
            return reply.redirect(
              `${frontendUrl}/integracoes/magalu/callback?result=error&message=${encodeURIComponent("code e state são obrigatórios")}`,
            );
          }
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message: "code e state são obrigatórios",
          });
        }

        const userId = request.user?.dataOwnerId;
        const account = await MarketplaceUseCase.handleMagaluOAuthCallback({
          code,
          state,
          userId,
        });

        if (isBrowserRedirect) {
          return reply.redirect(
            `${frontendUrl}/integracoes/magalu/callback?result=success`,
          );
        }

        return reply.send({
          success: true,
          message: "Conta conectada com sucesso",
          account: {
            id: account.id,
            platform: account.platform,
            status: account.status,
            createdAt: account.createdAt,
          },
        });
      } catch (error) {
        if (isBrowserRedirect) {
          const errorMsg =
            error instanceof Error ? error.message : "Erro desconhecido";
          return reply.redirect(
            `${frontendUrl}/integracoes/magalu/callback?result=error&message=${encodeURIComponent(errorMsg)}`,
          );
        }
        return reply.status(500).send({
          error: "Erro ao processar callback",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/magalu/webhook — recebe eventos nativos v1 da Magalu
   * (orders_order / orders_delivery). Valida HMAC (best-effort, ver TODO),
   * responde 200 rápido e processa em background.
   */
  app.post(
    "/magalu/webhook",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body || {}) as MagaluOrderWebhookPayload;

      // Validação de assinatura HMAC-SHA256 (X-Signature-256 sobre
      // "{X-Timestamp}.{corpo}"). LIMITAÇÃO: o Fastify já parseou o JSON e o
      // projeto não captura raw body; validamos sobre o JSON re-serializado e
      // NÃO bloqueamos em mismatch (para não perder pedidos reais) — apenas
      // logamos. TODO: capturar raw body p/ enforcement estrito.
      const secret = MAGALU_CONSTANTS.WEBHOOK_SECRET;
      if (secret) {
        const sigHeader = request.headers["x-signature-256"] as
          string | undefined;
        const ts = request.headers["x-timestamp"] as string | undefined;
        const rawApprox = JSON.stringify(body ?? {});
        const ok = MagaluWebhookSignatureService.verify(
          rawApprox,
          ts,
          sigHeader,
          secret,
        );
        if (!ok) {
          console.warn(
            "[magalu/webhook] assinatura HMAC não confere (validação best-effort sobre JSON re-serializado).",
          );
        }
      }

      // Magalu espera resposta rápida — responder 200 e processar depois.
      reply.status(200).send({ received: true });

      setImmediate(async () => {
        try {
          const r = await WebhookUseCase.processMagaluOrderWebhook(body);
          if (!r.success) {
            console.warn(`[magalu/webhook] ${r.error}`);
            // Já respondemos 200: a Magalu considera o evento entregue. Sem
            // este registro, uma venda perdida aqui não deixa nenhum rastro
            // acionável — só uma linha de log no processo. O claim do evento
            // é liberado pelo use case, então a reentrega ainda pode salvar.
            void SystemLogService.logError(
              "SYNC_ORDERS",
              `Webhook Magalu falhou no processamento: ${r.error ?? "erro desconhecido"}`,
              {
                resource: "Order",
                details: {
                  platform: "MAGALU",
                  topic: body?.topic ?? null,
                  resourceId: body?.data?.params?.id ?? null,
                  tenantId: body?.tenant_id ?? null,
                  accountId: r.accountId ?? null,
                },
              },
            ).catch(() => {});
          } else {
            console.log(`[magalu/webhook] ${r.action ?? "ok"}`);
          }
        } catch (e) {
          console.error(
            "[magalu/webhook] erro:",
            e instanceof Error ? e.message : e,
          );
          void SystemLogService.logError(
            "SYNC_ORDERS",
            `Webhook Magalu lancou excecao no processamento`,
            {
              resource: "Order",
              details: {
                platform: "MAGALU",
                topic: body?.topic ?? null,
                resourceId: body?.data?.params?.id ?? null,
                tenantId: body?.tenant_id ?? null,
                error: e instanceof Error ? e.message : String(e),
              },
            },
          ).catch(() => {});
        }
      });
    },
  );

  /**
   * GET /marketplace/magalu/status
   */
  app.get(
    "/magalu/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const statusData =
          await MarketplaceUseCase.getMagaluAccountStatus(userId);
        return reply.send({
          connected: statusData.connected,
          platform: Platform.MAGALU,
          status: statusData.account?.status,
          message: statusData.message,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao obter status",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/magalu/accounts — lista contas Magalu do usuário.
   */
  app.get(
    "/magalu/accounts",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.MAGALU,
        );
        return reply.send({ accounts });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao listar contas",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * DELETE /marketplace/magalu — desconecta conta (aceita accountId).
   */
  app.delete<{ Reply: { success: boolean; message: string } }>(
    "/magalu",
    { preHandler: [authMiddleware, blockCollaborator] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        await MarketplaceUseCase.disconnectAccount(
          userId,
          Platform.MAGALU,
          accountId,
        );

        return reply.send({
          success: true,
          message: "Conta Magalu desconectada com sucesso",
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao desconectar conta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/magalu/listings — vínculos produto↔anúncio da Magalu.
   */
  app.get(
    "/magalu/listings",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        const accounts =
          accountIds && accountIds.length > 0
            ? await prisma.marketplaceAccount.findMany({
                where: {
                  id: { in: accountIds },
                  userId,
                  platform: Platform.MAGALU,
                },
              })
            : await MarketplaceRepository.findAllByUserIdAndPlatform(
                userId,
                Platform.MAGALU,
              );

        if (!accounts || accounts.length === 0) {
          return reply.status(404).send({
            error: "Conta não encontrada",
            message: "Conecte sua conta da Magalu primeiro",
          });
        }

        const listingsArrays = await Promise.all(
          accounts.map((acc) =>
            prisma.productListing.findMany({
              where: { marketplaceAccountId: acc.id },
              select: {
                id: true,
                productId: true,
                externalListingId: true,
                externalSku: true,
                permalink: true,
                status: true,
                lastError: true,
                createdAt: true,
                product: { select: { name: true, sku: true, stock: true } },
              },
              orderBy: { createdAt: "desc" },
            }),
          ),
        );

        const listings = listingsArrays.flat();
        return reply.send({ success: true, count: listings.length, listings });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao buscar anúncios",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/magalu/categories?search=<termo>
   * Busca categorias do Magalu por nome (combobox de categoria do modal).
   */
  app.get(
    "/magalu/categories",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const q = request.query as any;
        const search = q?.search as string | undefined;
        const showAll = q?.all === "1" || q?.all === "true";
        const categories = await ListingUseCase.searchMagaluCategories(
          userId,
          search ?? "",
          { all: showAll },
        );
        return reply.send({ categories });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao buscar categorias Magalu",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/magalu/category-suggest?name=<nome do produto>
   * Sugere a categoria Magalu (mesma resolução do create) — id + caminho.
   */
  app.get(
    "/magalu/category-suggest",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const name = (request.query as any)?.name as string | undefined;
      if (!name || !name.trim()) {
        return reply
          .status(400)
          .send({ error: "Parâmetro 'name' é obrigatório" });
      }
      try {
        const userId = request.user!.dataOwnerId;
        const suggestion = await ListingUseCase.suggestMagaluCategory(
          userId,
          name,
        );
        return reply.send(suggestion ?? { categoryId: null, path: null });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sugerir categoria Magalu",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/magalu/import — importa anúncios ATIVOS de TODAS as contas
   * ACTIVE do dono e cria+vincula os produtos (dedup por SKU via núcleo).
   * Responde 202 com importId; a aba faz polling em GET /magalu/import/:importId.
   */
  app.post(
    "/magalu/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        const job = await SyncUseCase.startMagaluImportJob(userId, accountId);

        return reply.status(202).send({
          success: true,
          importId: job.importId,
          status: job.status,
          message: job.message,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar importação da Magalu",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/magalu/import/:importId — status/resultado do job.
   */
  app.get<{ Params: { importId: string } }>(
    "/magalu/import/:importId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { importId } = request.params as { importId: string };
        const status = await SyncUseCase.getGenericImportJobStatus(
          userId,
          importId,
        );
        return reply.send({
          success: true,
          importId: status.importId,
          status: status.status,
          progress: status.progress,
          result: status.result,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro desconhecido";
        const statusCode = /não encontrada|not found/i.test(message)
          ? 404
          : 500;
        return reply.status(statusCode).send({
          error: "Erro ao consultar importação da Magalu",
          message,
        });
      }
    },
  );

  /**
   * POST /marketplace/magalu/sync — sincroniza estoque de todos os anúncios
   * Magalu (multi-contas). Responde 202 e processa em background.
   */
  app.post(
    "/magalu/sync",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        reply.status(202).send({
          success: true,
          message: "Sincronização iniciada em segundo plano",
          total: 0,
          successful: 0,
          failed: 0,
          results: [],
        });

        setImmediate(async () => {
          try {
            const result = await SyncUseCase.syncAllStock(
              userId,
              Platform.MAGALU,
              accountIds,
            );
            await SystemLogService.logSyncComplete(
              userId,
              "FULL_SYNC",
              "Magalu",
              {
                total: result.total,
                successful: result.successful,
                failed: result.failed,
              },
            );
            console.log(
              `[magalu/sync] Background sync complete: ${result.successful}/${result.total} OK, ${result.failed} failed`,
            );
          } catch (bgErr) {
            console.error(
              `[magalu/sync] Background sync error:`,
              bgErr instanceof Error ? bgErr.message : bgErr,
            );
          }
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar sincronização da Magalu",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/magalu/sync/:productId — sincroniza um produto específico.
   */
  app.post<{ Params: { productId: string } }>(
    "/magalu/sync/:productId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { productId } = request.params as { productId: string };

        const result = await SyncUseCase.syncProductStock(productId);
        const failed = result.filter((r) => !r.success);

        await SystemLogService.logSyncComplete(
          userId,
          "PRODUCT_SYNC",
          "Magalu",
          {
            productId,
            successful: result.length - failed.length,
            failed: failed.length,
          },
        );

        return reply.send({ success: failed.length === 0, results: result });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sincronizar estoque do produto na Magalu",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );
}
