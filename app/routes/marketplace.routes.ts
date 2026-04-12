import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MarketplaceUseCase } from "../marketplaces/usecases/marketplace.usercase";
import { SyncUseCase } from "../marketplaces/usecases/sync.usercase";
import { WebhookUseCase } from "../marketplaces/usecases/webhook.usercase";
import { ListingRepository } from "../marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "../marketplaces/repositories/marketplace.repository";
import CategoryRepository from "../marketplaces/repositories/category.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import { Platform } from "@prisma/client";
import { SystemLogService } from "../services/system-log.service";
import prisma from "../lib/prisma";
import { ListingRetryService } from "../marketplaces/services/listing-retry.service";
import CategorySuggestionService from "../marketplaces/services/category-suggestion.service";
import { ShopeeOAuthService } from "../marketplaces/services/shopee-oauth.service";
import { ShopeeApiService } from "../marketplaces/services/shopee-api.service";
import { MLApiService } from "../marketplaces/services/ml-api.service";
import { MLOAuthService } from "../marketplaces/services/ml-oauth.service";
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
      const refreshed = await MLOAuthService.refreshAccessToken(
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // userId vem da sessÃ£o (garantido pelo authMiddleware)
        const userId = request.user!.id;
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
      const userId = request.user?.id;

      // Processar callback OAuth (userId serÃ¡ recuperado do state se nÃ£o existir aqui)
      const account = await MarketplaceUseCase.handleOAuthCallback({
        code,
        state,
        userId,
      });

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
            if (WebhookUseCase.validateWebhookPayload(body)) {
              const result =
                await WebhookUseCase.processOrderWebhook(body);
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

        const userId = request.user?.id;

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
        const userId = request.user!.id;
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
        const raw = await CategoryRepository.listFlattenedOptions("MLB");
        // Normalizar para o formato esperado pelo front: { id, value }
        const categories = (raw || []).map((c: any) => ({
          id: c.externalId || c.id,
          value: c.fullPath || c.name || c.externalId || c.id,
        }));
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
        const userId = request.user!.id;
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
        const userId = request.user!.id;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
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
   * Importa itens do Mercado Livre (multi-contas) e tenta vincular por SKU
   */
  app.post<{
    Reply: {
      success: boolean;
      totalItems: number;
      linkedItems: number;
      unlinkedItems: number;
      items: Array<{
        externalListingId: string;
        title: string;
        sku: string | null;
        linkedProductId: string | null;
        status: string;
      }>;
      errors: string[];
    };
  }>(
    "/ml/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.id;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);
        const accountId =
          accountIds && accountIds.length > 0 ? accountIds[0] : undefined;

        const result = await SyncUseCase.importMLItems(userId, accountId);

        await SystemLogService.logSyncComplete(
          userId,
          "IMPORT",
          "MercadoLivre",
          {
            totalItems: result.totalItems,
            linkedItems: result.linkedItems,
            unlinkedItems: result.unlinkedItems,
            errors: result.errors.length,
          },
        );

        return reply.send({
          success: true,
          totalItems: result.totalItems,
          linkedItems: result.linkedItems,
          unlinkedItems: result.unlinkedItems,
          items: result.items,
          errors: result.errors,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao importar itens do Mercado Livre",
          message: error instanceof Error ? error.message : "Erro desconhecido",
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
        const userId = request.user!.id;
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
        const userId = request.user!.id;
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
        const userId = request.user!.id;

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
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const raw = await CategoryRepository.listFlattenedOptions("SHP");
        const categories = (raw || []).map((c: any) => ({
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
        const userId = request.user!.id;
        const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        );
        return reply.send({ accounts });
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
        const userId = request.user!.id;
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
        const userId = request.user!.id;
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
        const statusCode = /não encontrada|not found/i.test(message) ? 404 : 500;
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
        const userId = request.user!.id;
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
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.id;
        const accountIds =
          ((request.body as any)?.accountIds as string[] | undefined) ??
          ((request.query as any)?.accountId
            ? [(request.query as any).accountId as string]
            : undefined);

        const result = await SyncUseCase.syncAllStock(
          userId,
          Platform.SHOPEE,
          accountIds,
        );

        // Registrar log de sincronizaÃ§Ã£o completa
        await SystemLogService.logSyncComplete(userId, "FULL_SYNC", "Shopee", {
          total: result.total,
          successful: result.successful,
          failed: result.failed,
        });

        return reply.send({
          success: result.failed === 0,
          total: result.total,
          successful: result.successful,
          failed: result.failed,
          results: result.results,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao sincronizar estoque",
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
        const userId = request.user!.id;
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
   * POST /marketplace/shopee/webhook
   * Recebe push notifications da Shopee (configurado no Partner Portal)
   * Sem auth middleware - Shopee envia diretamente
   * Códigos: 4 = order status update, 3 = order tracking update
   */
  app.post(
    "/shopee/webhook",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body || {}) as Record<string, any>;

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

          // Códigos de pedido: 3 = order tracking, 4 = order status
          if (code !== 3 && code !== 4) {
            console.log(
              `[Shopee Webhook] Código ${code} ignorado (não é pedido)`,
            );
            return;
          }

          console.log(
            `[Shopee Webhook] Recebido code=${code}, shop_id=${shopId}, order=${body.data?.ordersn || "N/A"}`,
          );

          const result =
            await WebhookUseCase.processShopeeOrderWebhook(body as any);

          if (result.success) {
            console.log(
              `[Shopee Webhook] Processado com sucesso: ${result.action}`,
            );
          } else {
            console.warn(
              `[Shopee Webhook] Falha no processamento: ${result.error}`,
            );
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // userId vem da sessÃ£o (garantido pelo authMiddleware)
        const userId = request.user!.id;
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
      const acceptHeader = ((request.headers.accept as string) || "").toString();
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
        let userId = state ? ShopeeOAuthService.consumeState(state) : null;
        if (!userId) {
          userId = request.user?.id ?? null;
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
        const userId = request.user!.id;
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
        const userId = request.user!.id;
        const accountId = (request.query as any)?.accountId as
          | string
          | undefined;
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
        const userId = request.user!.id;
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
        const userId = request.user!.id;
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
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // UsuÃ¡rio jÃ¡ validado pelo middleware
        const userId = request.user!.id;
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
}
