import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MarketplaceUseCase } from "../marketplaces/usecases/marketplace.usercase";
import { SyncUseCase } from "../marketplaces/usecases/sync.usercase";
import { WebhookUseCase } from "../marketplaces/usecases/webhook.usercase";
import { ListingRepository } from "../marketplaces/repositories/listing.repository";
import { MarketplaceRepository } from "../marketplaces/repositories/marketplace.repository";
import { authMiddleware } from "../middlewares/auth.middleware";
import { Platform } from "@prisma/client";
import { SystemLogService } from "../services/system-log.service";
import prisma from "../lib/prisma";

/**
 * Rotas para gerenciar conexões com marketplaces
 */
export async function marketplaceRoutes(app: FastifyInstance) {
  /**
   * POST /marketplace/ml/auth
   * Inicia fluxo de autenticação com Mercado Livre
   * Retorna URL para redirecionamento do usuário
   * Requer autenticação - userId vem da sessão
   */
  app.post<{
    Reply: { authUrl: string; state: string };
  }>(
    "/ml/auth",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // userId vem da sessão (garantido pelo authMiddleware)
        const userId = request.user!.id;

        // Gerar URL de autorização (passa userId para associar no callback)
        const { authUrl, state } = MarketplaceUseCase.initiateOAuth(userId);

        // Retornar URL + state (state será usado no callback)
        return reply.send({
          authUrl,
          state,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar autenticação",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/ml/callback?code=...&state=...
   * Callback do OAuth após usuário autorizar no Mercado Livre
   * Processa o authorization code e cria sessão
   * Nota: NÃO requer autenticação prévia - userId vem do state
   */
  app.get<{
    Querystring: { code?: string; state?: string };
    Reply: { success: boolean; message: string };
  }>("/ml/callback", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const code = (request.query as any).code as string | undefined;
      const state = (request.query as any).state as string | undefined;

      // Validar parâmetros obrigatórios
      if (!code || !state) {
        return reply.status(400).send({
          error: "Parâmetros inválidos",
          message: "code e state são obrigatórios",
        });
      }

      // userId pode vir da sessão atual OU do state armazenado
      // O state já contém o userId de quando o OAuth foi iniciado
      const userId = request.user?.id;

      // Processar callback OAuth (userId será recuperado do state se não existir aqui)
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
  });

  /**
   * GET /marketplace/ml/status
   * Verifica status de conexão com Mercado Livre
   * Retorna se conta está conectada e ativa
   */
  app.get<{
    Reply: {
      connected: boolean;
      platform: string;
      status?: string;
      message: string;
    };
  }>(
    "/ml/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        // Obter status da conexão
        const statusData = await MarketplaceUseCase.getAccountStatus(
          userId,
          Platform.MERCADO_LIVRE,
        );

        return reply.send({
          connected: statusData.connected,
          platform: Platform.MERCADO_LIVRE,
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
   * DELETE /marketplace/ml
   * Desconecta conta do Mercado Livre
   */
  app.delete<{ Reply: { success: boolean; message: string } }>(
    "/ml",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        // Desconectar marketplace
        await MarketplaceUseCase.disconnectAccount(
          userId,
          Platform.MERCADO_LIVRE,
        );

        return reply.send({
          success: true,
          message: "Conta desconectada com sucesso",
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao desconectar conta",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  // ====================================================================
  // ROTAS DE SINCRONIZAÇÃO - Fase 2
  // ====================================================================

  /**
   * POST /marketplace/ml/import
   * Importa todos os itens do Mercado Livre e tenta vincular por SKU
   * Retorna lista de itens importados com status de vinculação
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
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        const result = await SyncUseCase.importMLItems(userId);

        // Registrar log de importação
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
          error: "Erro ao importar itens",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/ml/sync
   * Sincroniza estoque de todos os produtos vinculados ao ML
   * Envia estoque local para o Mercado Livre
   */
  app.post<{
    Reply: {
      success: boolean;
      total: number;
      successful: number;
      failed: number;
      results: Array<{
        productId: string;
        externalListingId: string;
        success: boolean;
        previousStock?: number;
        newStock?: number;
        error?: string;
      }>;
    };
  }>(
    "/ml/sync",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        const result = await SyncUseCase.syncAllStock(
          userId,
          Platform.MERCADO_LIVRE,
        );

        // Registrar log de sincronização completa
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
   * POST /marketplace/ml/sync/:productId
   * Sincroniza estoque de um produto específico para o ML
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
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        const { productId } = request.params as { productId: string };

        const result = await SyncUseCase.syncProductStock(productId);

        const successful = result.filter((r) => r.success);
        const failed = result.filter((r) => !r.success);

        if (failed.length > 0 && successful.length === 0) {
          // Todos falharam
          const firstError = failed[0];
          await SystemLogService.logSyncError(
            userId,
            "PRODUCT_SYNC",
            "MultiPlatform",
            firstError.error || "Erro desconhecido",
          );
          return reply.status(400).send({
            success: false,
            results: result.map((r) => ({
              productId: r.productId,
              externalListingId: r.externalListingId,
              error: r.error,
            })),
          });
        }

        // Registrar log de sincronização bem-sucedida
        await SystemLogService.logSyncComplete(
          userId,
          "PRODUCT_SYNC",
          "MultiPlatform",
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
   * GET /marketplace/ml/listings
   * Lista todos os listings (vínculos produto-anúncio) do usuário
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
        createdAt: Date;
      }>;
    };
  }>(
    "/ml/listings",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        // Buscar conta do ML
        const account = await MarketplaceRepository.findByUserIdAndPlatform(
          userId,
          Platform.MERCADO_LIVRE,
        );

        if (!account) {
          return reply.status(404).send({
            error: "Conta não encontrada",
            message: "Nenhuma conta do Mercado Livre conectada",
          });
        }

        // Buscar listings
        const listings = await ListingRepository.findAllByAccount(account.id);

        return reply.send({
          success: true,
          count: listings.length,
          listings,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao listar vínculos",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  // ====================================================================
  // ROTAS DE WEBHOOK - Fase 5.3
  // ====================================================================

  /**
   * POST /marketplace/ml/webhook
   * Endpoint para receber webhooks do Mercado Livre
   * Processa notificações de pedidos automaticamente
   * NÃO requer autenticação - validação é feita via application_id
   */
  app.post<{
    Body: any;
    Reply: { success: boolean; message: string; data?: any };
  }>("/ml/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = request.body;

      // Validar payload do webhook
      if (!WebhookUseCase.validateWebhookPayload(payload)) {
        return reply.status(400).send({
          success: false,
          message: "Payload de webhook inválido",
        });
      }

      // Processar webhook de pedido
      const result = await WebhookUseCase.processOrderWebhook(payload);

      if (!result.success) {
        // Log do erro mas retorna 200 para não fazer ML tentar novamente
        console.error("[Webhook] Erro ao processar:", result.error);
        return reply.status(200).send({
          success: false,
          message: result.error || "Erro ao processar webhook",
        });
      }

      // Retornar sucesso
      return reply.send({
        success: true,
        message: "Webhook processado com sucesso",
        data: {
          userId: result.userId,
          orderId: result.orderId,
          action: result.action,
        },
      });
    } catch (error) {
      console.error("[Webhook] Erro interno:", error);
      return reply.status(500).send({
        success: false,
        message: "Erro interno do servidor",
      });
    }
  });

  // ====================================================================
  // ROTAS PARA SHOPEE
  // ====================================================================

  /**
   * POST /marketplace/shopee/import
   * Importa todos os itens do Shopee e tenta vincular por SKU
   * Retorna lista de itens importados com status de vinculação
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
    "/shopee/import",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        const result = await SyncUseCase.importShopeeItems(userId);

        // Registrar log de importação
        await SystemLogService.logSyncComplete(userId, "IMPORT", "Shopee", {
          totalItems: result.totalItems,
          linkedItems: result.linkedItems,
          unlinkedItems: result.unlinkedItems,
          errors: result.errors.length,
        });

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
          error: "Erro ao importar itens",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/listings
   * Lista todos os anúncios vinculados do Shopee
   * Requer autenticação
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
        createdAt: Date;
      }>;
    };
  }>(
    "/shopee/listings",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        // Buscar conta do marketplace
        const account = await MarketplaceRepository.findByUserIdAndPlatform(
          userId,
          Platform.SHOPEE,
        );

        if (!account) {
          return reply.status(404).send({
            error: "Conta não encontrada",
            message: "Conecte sua conta do Shopee primeiro",
          });
        }

        // Buscar listings
        const listings = await prisma.productListing.findMany({
          where: {
            marketplaceAccountId: account.id,
          },
          select: {
            id: true,
            productId: true,
            externalListingId: true,
            externalSku: true,
            status: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        return reply.send({
          success: true,
          count: listings.length,
          listings,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao buscar anúncios",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /marketplace/shopee/sync
   * Sincroniza estoque de todos os produtos vinculados ao Shopee
   * Requer autenticação
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
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        const result = await SyncUseCase.syncAllStock(userId, Platform.SHOPEE);

        // Registrar log de sincronização completa
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
   * Sincroniza estoque de um produto específico para o Shopee
   * Requer autenticação
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
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        const { productId } = request.params as { productId: string };

        const result = await SyncUseCase.syncProductStock(productId);

        const successful = result.filter((r) => r.success);
        const failed = result.filter((r) => !r.success);

        // Registrar log de sincronização bem-sucedida
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
        // userId vem da sessão (garantido pelo authMiddleware)
        const userId = request.user!.id;

        // Gerar URL de autorização
        const { authUrl, state } =
          MarketplaceUseCase.initiateShopeeOAuth(userId);

        // Retornar URL + state (state será usado no callback)
        return reply.send({
          authUrl,
          state,
        });
      } catch (error) {
        return reply.status(500).send({
          error: "Erro ao iniciar autenticação Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/callback?code=...&shop_id=...
   * Callback do OAuth após usuário autorizar no Shopee
   * Processa o authorization code e cria sessão
   * Nota: NÃO requer autenticação prévia - userId vem do state
   */
  app.get<{
    Querystring: { code?: string; shop_id?: string };
    Reply: { success: boolean; message: string };
  }>(
    "/shopee/callback",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const code = (request.query as any).code as string | undefined;
        const shopIdStr = (request.query as any).shop_id as string | undefined;

        // Validar parâmetros obrigatórios
        if (!code || !shopIdStr) {
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message: "code e shop_id são obrigatórios",
          });
        }

        const shopId = parseInt(shopIdStr);
        if (isNaN(shopId)) {
          return reply.status(400).send({
            error: "Parâmetros inválidos",
            message: "shop_id deve ser um número válido",
          });
        }

        // userId vem da sessão atual (usuário deve estar logado)
        const userId = request.user?.id;
        if (!userId) {
          return reply.status(401).send({
            error: "Não autenticado",
            message: "Usuário deve estar logado para conectar Shopee",
          });
        }

        // Processar callback OAuth
        const account = await MarketplaceUseCase.handleShopeeOAuthCallback({
          code,
          shopId,
          userId,
        });

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
        return reply.status(500).send({
          error: "Erro ao processar callback Shopee",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /marketplace/shopee/status
   * Verifica status de conexão com Shopee
   * Retorna se conta está conectada e ativa
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
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        // Obter status da conexão
        const statusData =
          await MarketplaceUseCase.getShopeeAccountStatus(userId);

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

  /**
   * DELETE /marketplace/shopee
   * Desconecta conta do Shopee
   */
  app.delete<{ Reply: { success: boolean; message: string } }>(
    "/shopee",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Usuário já validado pelo middleware
        const userId = request.user!.id;

        // Desconectar marketplace
        await MarketplaceUseCase.disconnectShopeeAccount(userId);

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
