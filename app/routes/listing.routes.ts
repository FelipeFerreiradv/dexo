import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import {
  ListingDispatcher,
  ListingDispatchRequest,
} from "../marketplaces/services/listing-dispatcher.service";
import {
  BulkListingJobRepository,
  type BulkListingPlatform,
  type BulkListingRequestSpec,
  type BulkOverrideTemplate,
} from "../marketplaces/repositories/bulk-listing-job.repository";
import { MarketplaceRepository } from "../marketplaces/repositories/marketplace.repository";
import { ProductRepositoryPrisma } from "../repositories/product.repository";
import { ShopeeApiService } from "../marketplaces/services/shopee-api.service";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import { Platform } from "@prisma/client";
import prisma from "../lib/prisma";

/**
 * Enriquece a config de aumento percentual escalonado entre contas ML antes de
 * persistir/disparar o job. O front envia apenas { enabled, percent }; aqui
 * resolvemos o percentual final (clamp 0..100, com fallback à preferência do
 * usuário) e congelamos `indexByAccountId` pela ordem de seleção das contas ML
 * (= ordem das entradas ML em `requests`; 1ª selecionada = índice 0 = preço
 * base). Persistir essa config no overrideTemplate faz o retry-failed reproduzir
 * preços idênticos, pois lê a config congelada em vez de recalcular.
 *
 * Devolve o template inalterado quando o recurso está desligado e remove a flag
 * (no-op, comportamento atual) quando o percentual resolvido é <= 0.
 */
async function enrichCrossAccountIncrease(
  userId: string,
  requests: Array<{ platform: BulkListingPlatform; accountId: string }>,
  template: BulkOverrideTemplate | null,
): Promise<BulkOverrideTemplate | null> {
  const ca = template?.crossAccountIncrease;
  if (!template || !ca?.enabled) return template;

  let percent =
    typeof ca.percent === "number" && Number.isFinite(ca.percent)
      ? ca.percent
      : NaN;
  if (!Number.isFinite(percent)) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { crossAccountPriceIncreasePercent: true },
    });
    percent = user?.crossAccountPriceIncreasePercent
      ? Number(user.crossAccountPriceIncreasePercent)
      : 0;
  }
  percent = Math.min(100, Math.max(0, percent));

  // Percentual 0 ⇒ no-op: remove a flag para preservar o comportamento atual.
  if (percent <= 0) {
    const rest = { ...template };
    delete rest.crossAccountIncrease;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  const indexByAccountId: Record<string, number> = {};
  let idx = 0;
  for (const r of requests) {
    if (
      r.platform === "MERCADO_LIVRE" &&
      !Object.prototype.hasOwnProperty.call(indexByAccountId, r.accountId)
    ) {
      indexByAccountId[r.accountId] = idx++;
    }
  }

  return {
    ...template,
    crossAccountIncrease: { enabled: true, percent, indexByAccountId },
  };
}

export async function listingRoutes(app: FastifyInstance) {
  /**
   * POST /listings/ml
   * Cria um anúncio no Mercado Livre para um produto
   */
  app.post<{
    Body: {
      productId: string;
      categoryId?: string;
    };
  }>(
    "/ml",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startedAt = Date.now();
      try {
        const userId = request.user!.dataOwnerId;
        const body = request.body as {
          productId: string;
          categoryId?: string;
          accountId?: string;
          listingType?: string;
          hasWarranty?: boolean;
          warrantyUnit?: string;
          warrantyDuration?: number;
          itemCondition?: string;
          shippingMode?: string;
          freeShipping?: boolean;
          localPickup?: boolean;
          manufacturingTime?: number;
        };
        const accountId =
          body.accountId ||
          ((request.query as any)?.accountId as string | undefined) ||
          undefined;

        // Validações básicas
        if (!body.productId) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "productId é obrigatório",
          });
        }
        if (!accountId) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "accountId é obrigatório para criar anúncio ML",
          });
        }
        // categoryId é opcional aqui: se o frontend não enviar, o backend
        // tenta resolver a partir de product.mlCategoryId e, como último recurso,
        // pede uma sugestão ao ML via domain_discovery dentro do ListingUseCase.

        const result = await ListingUseCase.createMLListing(
          userId,
          body.productId,
          body.categoryId,
          accountId,
          {
            listingType: body.listingType,
            hasWarranty: body.hasWarranty,
            warrantyUnit: body.warrantyUnit,
            warrantyDuration: body.warrantyDuration,
            itemCondition: body.itemCondition,
            shippingMode: body.shippingMode,
            freeShipping: body.freeShipping,
            localPickup: body.localPickup,
            manufacturingTime: body.manufacturingTime,
          },
        );

        if (!result.success) {
          // Registrar log de erro na criação de anúncio
          await SystemLogService.logSyncError(
            userId,
            "LISTING_CREATE",
            "MercadoLivre",
            result.error || "Erro desconhecido",
          );
          return reply.status(400).send({
            error: "Erro ao criar anúncio",
            message: result.error,
          });
        }

        // Registrar log de criação de anúncio
        if (result.listingId) {
          await SystemLogService.logListingCreate(
            userId,
            result.listingId,
            body.productId,
            "MercadoLivre",
          );
        }

        return reply.status(201).send({
          success: true,
          message: "Anúncio criado com sucesso",
          listingId: result.listingId,
          externalListingId: result.externalListingId,
        });
      } catch (error) {
        console.error("[Listing Routes] Error creating ML listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed > 5000) {
          console.warn(
            `[Listing Routes] /listings/ml lento: ${elapsed}ms (product=${(request.body as any)?.productId})`,
          );
        }
      }
    },
  );

  /**
   * POST /listings/shopee
   * Cria um anÃºncio no Shopee para um produto
   */
  app.post<{
    Body: {
      productId: string;
      categoryId?: string;
    };
  }>(
    "/shopee",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const body = request.body as {
          productId: string;
          categoryId?: string;
          accountId?: string;
        };
        const accountId =
          body.accountId ||
          ((request.query as any)?.accountId as string | undefined) ||
          undefined;

        if (!body.productId) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "productId Ã© obrigatÃ³rio",
          });
        }

        const result = await ListingUseCase.createShopeeListing(
          userId,
          body.productId,
          body.categoryId,
          accountId,
        );

        if (!result.success) {
          await SystemLogService.logSyncError(
            userId,
            "LISTING_CREATE",
            "Shopee",
            result.error || "Erro desconhecido",
          );
          return reply.status(400).send({
            error: "Erro ao criar anÃºncio Shopee",
            message: result.error,
          });
        }

        if (result.listingId) {
          await SystemLogService.logListingCreate(
            userId,
            result.listingId,
            body.productId,
            Platform.SHOPEE,
          );
        }

        return reply.status(201).send({
          success: true,
          message: "AnÃºncio Shopee criado com sucesso",
          listingId: result.listingId,
          externalListingId: result.externalListingId,
        });
      } catch (error) {
        console.error("[Listing Routes] Error creating Shopee listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * PUT /listings/:id/stock
   * Atualiza o estoque de um anúncio no ML
   */
  app.put<{
    Params: { id: string };
    Body: { quantity: number };
  }>(
    "/:id/stock",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const { quantity } = request.body as { quantity: number };

        if (quantity < 0) {
          return reply.status(400).send({
            error: "Quantidade inválida",
            message: "A quantidade deve ser maior ou igual a zero",
          });
        }

        // SEGURANÇA (multi-tenant): só o dono do anúncio (via product.userId)
        // pode alterar o estoque. Antes a rota não checava posse => IDOR.
        const userId = request.user!.dataOwnerId;
        const owned = await prisma.productListing.findFirst({
          where: { id, product: { userId } },
          select: { id: true },
        });
        if (!owned) {
          return reply.status(404).send({ error: "Anúncio não encontrado" });
        }

        const result = await ListingUseCase.updateMLListingStock(id, quantity);

        if (!result.success) {
          return reply.status(400).send({
            error: "Erro ao atualizar estoque",
            message: result.error,
          });
        }

        return reply.status(200).send({
          success: true,
          message: "Estoque atualizado com sucesso",
        });
      } catch (error) {
        console.error("[Listing Routes] Error updating stock:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /listings/:id
   * Retorna os dados completos de um anúncio (incluindo campos editáveis:
   * listingType, condition, warranty, shipping, manufacturing time).
   * Valida ownership.
   */
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { id } = request.params as { id: string };

        const prismaMod = await import("@/app/lib/prisma");
        const prisma = prismaMod.default;

        // Otimização: carrega listing + compatibilidades em paralelo. As
        // compatibilidades só são úteis se o listing existir e for do user,
        // mas o custo de uma 2ª query rápida vale para reduzir RTT.
        const [listing, productCompatibilitiesPreload] = await Promise.all([
          prisma.productListing.findUnique({
            where: { id },
            include: {
              product: true,
              marketplaceAccount: {
                select: { id: true, accountName: true, platform: true },
              },
            },
          }),
          // Lookup pelo listingId via subquery — não precisa esperar o produto.
          (prisma as any).productCompatibility
            .findMany({
              where: { product: { listings: { some: { id } } } },
              orderBy: { createdAt: "asc" },
            })
            .catch(() => [] as unknown[]),
        ]);

        if (!listing) {
          return reply.status(404).send({ error: "Anúncio não encontrado" });
        }

        if (listing.product?.userId !== userId) {
          return reply.status(403).send({ error: "Acesso negado" });
        }

        const productCompatibilities = productCompatibilitiesPreload;

        return reply.status(200).send({
          listing: {
            id: listing.id,
            externalListingId: listing.externalListingId,
            externalSku: listing.externalSku,
            permalink: listing.permalink,
            status: listing.status,
            listingType: listing.listingType,
            itemCondition: listing.itemCondition,
            hasWarranty: listing.hasWarranty,
            warrantyUnit: listing.warrantyUnit,
            warrantyDuration: listing.warrantyDuration,
            shippingMode: listing.shippingMode,
            freeShipping: listing.freeShipping,
            localPickup: listing.localPickup,
            manufacturingTime: listing.manufacturingTime,
            updatedAt: listing.updatedAt,
            // Override fields: NULL = herda do produto, valor = personalizado
            titleOverride: listing.titleOverride ?? null,
            descriptionOverride: listing.descriptionOverride ?? null,
            priceOverride: listing.priceOverride
              ? Number(listing.priceOverride)
              : null,
            brandOverride: listing.brandOverride ?? null,
            modelOverride: listing.modelOverride ?? null,
            yearOverride: listing.yearOverride ?? null,
            versionOverride: listing.versionOverride ?? null,
            categoryOverride: listing.categoryOverride ?? null,
            mlCategoryOverride: listing.mlCategoryOverride ?? null,
            shopeeCategoryOverride: listing.shopeeCategoryOverride ?? null,
            partNumberOverride: listing.partNumberOverride ?? null,
            qualityOverride: listing.qualityOverride ?? null,
            heightCmOverride: listing.heightCmOverride ?? null,
            widthCmOverride: listing.widthCmOverride ?? null,
            lengthCmOverride: listing.lengthCmOverride ?? null,
            weightKgOverride: listing.weightKgOverride ?? null,
            imageUrlsOverride: listing.imageUrlsOverride ?? null,
            attributesOverride: listing.attributesOverride ?? null,
            compatibilitiesOverride: listing.compatibilitiesOverride ?? null,
            sourceVehicleOverride: listing.sourceVehicleOverride ?? null,
            // Snapshot do produto para o frontend pré-popular sem 2nd request
            product: {
              id: listing.product.id,
              name: listing.product.name,
              sku: listing.product.sku,
              description: listing.product.description ?? null,
              price: Number(listing.product.price ?? 0),
              brand: listing.product.brand ?? null,
              model: listing.product.model ?? null,
              year: listing.product.year ?? null,
              version: listing.product.version ?? null,
              category: listing.product.category ?? null,
              mlCategory:
                (listing.product as { mlCategory?: string | null })
                  .mlCategory ??
                listing.product.mlCategoryId ??
                null,
              shopeeCategoryId:
                (listing.product as { shopeeCategoryId?: string | null })
                  .shopeeCategoryId ?? null,
              partNumber: listing.product.partNumber ?? null,
              quality: listing.product.quality ?? null,
              heightCm: listing.product.heightCm ?? null,
              widthCm: listing.product.widthCm ?? null,
              lengthCm: listing.product.lengthCm ?? null,
              weightKg: listing.product.weightKg ?? null,
              imageUrl: listing.product.imageUrl ?? null,
              imageUrls: Array.isArray(listing.product.imageUrls)
                ? listing.product.imageUrls
                : [],
              attributes: listing.product.attributes ?? null,
              sourceVehicle: listing.product.sourceVehicle ?? null,
              compatibilities: productCompatibilities,
            },
            account: {
              id: listing.marketplaceAccount.id,
              accountName: listing.marketplaceAccount.accountName,
              platform: listing.marketplaceAccount.platform,
            },
          },
        });
      } catch (error) {
        console.error("[Listing Routes] Error fetching listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * PUT /listings/:id
   * Atualiza UM anúncio específico. Aceita:
   *  - Settings ML existentes (listingType, itemCondition, garantia, frete...)
   *  - Overrides do produto (titleOverride, priceOverride, brandOverride...)
   *
   * Convenção:
   *  - undefined / chave ausente = não tocar
   *  - null = limpar override (anúncio volta a herdar do produto)
   *  - valor = aplicar
   */
  app.put<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as Record<string, unknown>;

        // Helpers:
        // - pickOverride: aceita null (que significa "remover override").
        // - pickSetting: para campos do MLListingSettings, que não usam null.
        //   Converte null → undefined silenciosamente.
        const pickOverride = <T>(key: string): T | undefined =>
          key in body ? (body[key] as T) : undefined;
        const pickSetting = <T>(key: string): T | undefined => {
          if (!(key in body)) return undefined;
          const v = body[key];
          if (v === null) return undefined;
          return v as T;
        };

        const fields = {
          // ML settings (não aceitam null no MLListingSettings)
          listingType: pickSetting<string>("listingType"),
          itemCondition: pickSetting<string>("itemCondition"),
          hasWarranty: pickSetting<boolean>("hasWarranty"),
          warrantyUnit: pickSetting<string>("warrantyUnit"),
          warrantyDuration: pickSetting<number>("warrantyDuration"),
          shippingMode: pickSetting<string>("shippingMode"),
          freeShipping: pickSetting<boolean>("freeShipping"),
          localPickup: pickSetting<boolean>("localPickup"),
          manufacturingTime: pickSetting<number>("manufacturingTime"),
          // Product overrides (null = limpar override)
          titleOverride: pickOverride<string | null>("titleOverride"),
          descriptionOverride: pickOverride<string | null>(
            "descriptionOverride",
          ),
          priceOverride: pickOverride<number | null>("priceOverride"),
          brandOverride: pickOverride<string | null>("brandOverride"),
          modelOverride: pickOverride<string | null>("modelOverride"),
          yearOverride: pickOverride<string | null>("yearOverride"),
          versionOverride: pickOverride<string | null>("versionOverride"),
          categoryOverride: pickOverride<string | null>("categoryOverride"),
          mlCategoryOverride: pickOverride<string | null>("mlCategoryOverride"),
          shopeeCategoryOverride: pickOverride<string | null>(
            "shopeeCategoryOverride",
          ),
          partNumberOverride: pickOverride<string | null>("partNumberOverride"),
          qualityOverride: pickOverride<string | null>("qualityOverride"),
          heightCmOverride: pickOverride<number | null>("heightCmOverride"),
          widthCmOverride: pickOverride<number | null>("widthCmOverride"),
          lengthCmOverride: pickOverride<number | null>("lengthCmOverride"),
          weightKgOverride: pickOverride<number | null>("weightKgOverride"),
          imageUrlsOverride: pickOverride<string[] | null>("imageUrlsOverride"),
          attributesOverride: pickOverride<Record<
            string,
            { value_id?: string; value_name?: string }
          > | null>("attributesOverride"),
          compatibilitiesOverride: pickOverride<Array<{
            brand?: string;
            model?: string;
            yearFrom?: number | null;
            yearTo?: number | null;
            version?: string | null;
          }> | null>("compatibilitiesOverride"),
          sourceVehicleOverride: pickOverride<string | null>(
            "sourceVehicleOverride",
          ),
        };

        const result = await ListingUseCase.updateListingFields(
          id,
          userId,
          fields,
        );

        if (!result.success) {
          const status = result.error?.includes("Acesso negado")
            ? 403
            : result.error?.includes("não encontrado")
              ? 404
              : 400;
          return reply.status(status).send({
            error: "Erro ao atualizar anúncio",
            message: result.error,
          });
        }

        return reply.status(200).send({
          success: true,
          message: result.error
            ? result.error
            : "Anúncio atualizado com sucesso",
          warning: result.error || undefined,
        });
      } catch (error) {
        console.error("[Listing Routes] Error updating listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * PATCH /listings/:id/status
   * Pausa ou reativa um anúncio publicado.
   * Body: { status: "active" | "paused" }.
   */
  app.patch<{
    Params: { id: string };
    Body: { status: "active" | "paused" };
  }>(
    "/:id/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { id } = request.params as { id: string };
        const { status } = request.body as { status?: string };

        if (status !== "active" && status !== "paused") {
          return reply.status(400).send({
            error: "Status inválido",
            message: 'Use "active" ou "paused"',
          });
        }

        const result = await ListingUseCase.updateListingStatus(
          id,
          userId,
          status,
        );

        if (!result.success) {
          const httpStatus = result.error?.includes("Acesso negado")
            ? 403
            : result.error?.includes("não encontrado")
              ? 404
              : 400;
          return reply.status(httpStatus).send({
            error: "Erro ao alterar status",
            message: result.error,
          });
        }

        return reply.status(200).send({
          success: true,
          message:
            status === "paused"
              ? "Anúncio pausado com sucesso"
              : "Anúncio reativado com sucesso",
        });
      } catch (error) {
        console.error("[Listing Routes] Error patching status:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * DELETE /listings/:id
   * Remove um anúncio do ML
   */
  app.delete<{
    Params: { id: string };
  }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        // SEGURANÇA (multi-tenant): só o dono do anúncio (via product.userId)
        // pode removê-lo. Antes a rota não checava posse => IDOR de deleção.
        const userId = request.user!.dataOwnerId;
        const owned = await prisma.productListing.findFirst({
          where: { id, product: { userId } },
          select: { id: true },
        });
        if (!owned) {
          return reply.status(404).send({ error: "Anúncio não encontrado" });
        }

        const result = await ListingUseCase.removeListing(id);

        if (!result.success) {
          return reply.status(400).send({
            error: "Erro ao remover anúncio",
            message: result.error,
          });
        }

        return reply.status(200).send({
          success: true,
          message: "Anúncio removido com sucesso",
        });
      } catch (error) {
        console.error("[Listing Routes] Error removing listing:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /listings/status?productId=X
   * Retorna o estado atual de todos os ProductListing associados a um
   * produto. Usado pelo frontend para fazer polling após POST /listings/dispatch
   * (fase 3 slice 2): o modal libera imediato e atualiza um badge quando
   * o status muda.
   *
   * Shape da resposta:
   *   { listings: [{ id, platform, accountId, accountName, status,
   *                  externalListingId, permalink, lastError,
   *                  retryAttempts, nextRetryAt, updatedAt }] }
   */
  app.get<{
    Querystring: { productId?: string };
  }>(
    "/status",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const productId = (request.query as any)?.productId as
          | string
          | undefined;

        if (!productId) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "productId é obrigatório",
          });
        }

        const prismaMod = await import("@/app/lib/prisma");
        const prisma = prismaMod.default;

        const product = await (prisma as any).product.findFirst({
          where: { id: productId, userId },
          select: { id: true },
        });
        if (!product) {
          return reply.status(404).send({
            error: "Produto não encontrado",
          });
        }

        const listings = await (prisma as any).productListing.findMany({
          where: { productId },
          select: {
            id: true,
            status: true,
            externalListingId: true,
            permalink: true,
            lastError: true,
            retryAttempts: true,
            retryEnabled: true,
            nextRetryAt: true,
            updatedAt: true,
            marketplaceAccount: {
              select: {
                id: true,
                accountName: true,
                platform: true,
              },
            },
          },
          orderBy: { updatedAt: "desc" },
        });

        return reply.status(200).send({
          productId,
          listings: listings.map((l: any) => ({
            id: l.id,
            platform: l.marketplaceAccount?.platform,
            accountId: l.marketplaceAccount?.id,
            accountName: l.marketplaceAccount?.accountName,
            status: l.status,
            externalListingId: l.externalListingId,
            permalink: l.permalink,
            lastError: l.lastError,
            retryAttempts: l.retryAttempts,
            retryEnabled: l.retryEnabled,
            nextRetryAt: l.nextRetryAt,
            updatedAt: l.updatedAt,
          })),
        });
      } catch (error) {
        console.error("[Listing Routes] Error fetching status:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /listings/dispatch
   * Orquestrador único para criação assíncrona de anúncios em múltiplos
   * marketplaces e múltiplas contas. Substitui as chamadas fire-and-forget
   * duplicadas nos fluxos de criação (POST /products) e edição
   * (PUT /products/:id) por um único endpoint.
   *
   * Comportamento: fire-and-forget — retorna imediatamente o snapshot do
   * que foi enfileirado. Status final deve ser consultado via
   * GET /listings/status?productId=X (próxima fase).
   */
  app.post<{
    Body: {
      productId: string;
      requests: ListingDispatchRequest[];
    };
  }>(
    "/dispatch",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const body = request.body as {
          productId: string;
          requests: ListingDispatchRequest[];
          crossAccountIncrease?: { enabled?: boolean; percent?: number };
        };

        if (!body.productId) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "productId é obrigatório",
          });
        }
        if (!Array.isArray(body.requests) || body.requests.length === 0) {
          return reply.status(400).send({
            error: "Dados incompletos",
            message: "requests deve ser um array não-vazio",
          });
        }

        for (const req of body.requests) {
          if (req.platform !== "MERCADO_LIVRE" && req.platform !== "SHOPEE") {
            return reply.status(400).send({
              error: "Dados inválidos",
              message: `platform desconhecido: ${req.platform}`,
            });
          }
        }

        // Aumento percentual escalonado entre contas ML (edição de produto):
        // monta o overrideTemplate a partir da ordem das contas ML nos
        // requests. Sem cfg habilitada, o dispatch segue idêntico ao de hoje.
        const caCfg = body.crossAccountIncrease;
        const overrideTemplate = caCfg?.enabled
          ? ListingDispatcher.buildCrossAccountOverride(
              body.requests,
              await ListingDispatcher.resolveCrossAccountPercent(
                userId,
                caCfg.percent,
              ),
            )
          : null;

        const snapshot = ListingDispatcher.dispatch({
          userId,
          productId: body.productId,
          requests: body.requests,
          overrideTemplate,
        });

        return reply.status(202).send({
          success: true,
          ...snapshot,
        });
      } catch (error) {
        console.error("[Listing Routes] Error dispatching listings:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /listings/bulk/preflight
   * Valida produtos antes do submit do bulk. Hoje cobre apenas o caso mais
   * frequente de falha: produto com shopeeCategoryId que NÃO é categoria
   * folha (Shopee rejeita add_item nesse caso). Reusa o cache de 1h em
   * `ShopeeApiService.assertLeafCategory` então é barato mesmo com N produtos.
   *
   * Body: { shopeeAccountId?: string; productIds: string[] }
   * Response: { issues: Array<{ productId, code, message }> }
   *   code = "shopee_category_missing" | "shopee_category_not_leaf"
   */
  app.post(
    "/bulk/preflight",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const body = request.body as {
          shopeeAccountId?: string;
          productIds?: string[];
        };
        if (
          !Array.isArray(body.productIds) ||
          body.productIds.length === 0 ||
          body.productIds.some((id) => typeof id !== "string" || !id)
        ) {
          return reply.status(400).send({
            error: "Dados inválidos",
            message: "productIds deve ser um array não-vazio de strings",
          });
        }

        const issues: Array<{
          productId: string;
          code: "shopee_category_missing" | "shopee_category_not_leaf";
          message: string;
        }> = [];

        if (body.shopeeAccountId) {
          const account = await MarketplaceRepository.findByIdAndUser(
            body.shopeeAccountId,
            userId,
          );
          if (!account || !account.accessToken || !account.shopId) {
            return reply.status(400).send({
              error: "Conta Shopee inválida",
              message:
                "Conta Shopee não encontrada ou sem credenciais para preflight",
            });
          }

          const productRepo = new ProductRepositoryPrisma();
          const products = await Promise.all(
            body.productIds.map((id) => productRepo.findById(id, userId)),
          );

          for (let i = 0; i < products.length; i++) {
            const p = products[i];
            const id = body.productIds![i];
            if (!p) continue; // produto sumiu — quem chamar `dispatchBatch` reporta
            const shopeeId = (p as any).shopeeCategoryId;
            if (!shopeeId) {
              issues.push({
                productId: id,
                code: "shopee_category_missing",
                message:
                  "Produto sem categoria Shopee — Shopee exige uma subcategoria final.",
              });
              continue;
            }
            const numId = Number(shopeeId);
            if (!Number.isFinite(numId)) {
              issues.push({
                productId: id,
                code: "shopee_category_not_leaf",
                message: `Categoria Shopee ${shopeeId} inválida.`,
              });
              continue;
            }
            try {
              await ShopeeApiService.assertLeafCategory(
                account.accessToken,
                account.shopId,
                numId,
              );
            } catch (e) {
              const msg = e instanceof Error ? e.message : "categoria inválida";
              issues.push({
                productId: id,
                code: "shopee_category_not_leaf",
                message: msg,
              });
            }
          }
        }

        return reply.send({ issues });
      } catch (error) {
        console.error("[Listing Routes] Bulk preflight error:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /listings/bulk
   * Cria um BulkListingJob e dispara processamento em background.
   * Retorna { jobId } imediatamente; cliente faz polling em GET /listings/bulk/:jobId.
   */
  app.post(
    "/bulk",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const body = request.body as {
          productIds?: string[];
          requests?: Array<{
            platform: BulkListingPlatform;
            accountId: string;
            categoryId?: string;
            mlSettings?: Record<string, unknown>;
          }>;
          overrideTemplate?: BulkOverrideTemplate | null;
        };

        if (
          !Array.isArray(body.productIds) ||
          body.productIds.length === 0 ||
          body.productIds.some((id) => typeof id !== "string" || !id)
        ) {
          return reply.status(400).send({
            error: "Dados inválidos",
            message: "productIds deve ser um array não-vazio de strings",
          });
        }
        if (
          !Array.isArray(body.requests) ||
          body.requests.length === 0 ||
          body.requests.some(
            (r) =>
              !r ||
              (r.platform !== "MERCADO_LIVRE" && r.platform !== "SHOPEE") ||
              typeof r.accountId !== "string" ||
              !r.accountId,
          )
        ) {
          return reply.status(400).send({
            error: "Dados inválidos",
            message:
              "requests deve conter ao menos um par platform+accountId válido",
          });
        }
        if (body.productIds.length * body.requests.length > 2000) {
          return reply.status(400).send({
            error: "Limite excedido",
            message:
              "Operação muito grande. Máximo de 2000 anúncios por job (produtos × contas).",
          });
        }

        // Enriquece a config de aumento escalonado entre contas ML (resolve o
        // percentual e congela a ordem de seleção das contas) ANTES de criar o
        // job, para que persistência e disparo usem a mesma config — e o
        // retry-failed, que relê o template persistido, reproduza preços iguais.
        const overrideTemplate = await enrichCrossAccountIncrease(
          userId,
          body.requests,
          body.overrideTemplate ?? null,
        );

        const job = await BulkListingJobRepository.create({
          userId,
          productIds: body.productIds,
          requests: body.requests as BulkListingRequestSpec[],
          overrideTemplate,
        });

        // Disparo fire-and-forget. O cliente faz polling pelo jobId.
        void (async () => {
          try {
            await BulkListingJobRepository.markRunning(job.id);
            const summary = await ListingDispatcher.dispatchBatch({
              userId,
              productIds: body.productIds!,
              requests: body.requests!.map((r) => ({
                platform: r.platform,
                accountId: r.accountId,
                categoryId: r.categoryId,
                mlSettings: r.mlSettings as
                  | BulkListingRequestSpec["mlSettings"]
                  | undefined,
              })),
              overrideTemplate,
              onItemDone: async (item) => {
                try {
                  await BulkListingJobRepository.appendResult(job.id, item);
                } catch (e) {
                  console.error(
                    `[Listing Routes] appendResult failed (job=${job.id}):`,
                    e instanceof Error ? e.message : e,
                  );
                }
              },
            });
            await BulkListingJobRepository.markFinal(job.id, summary);
            console.log(
              JSON.stringify({
                event: "listing.bulk.finished",
                jobId: job.id,
                userId,
                ...summary,
              }),
            );
          } catch (e) {
            console.error(
              `[Listing Routes] bulk job crashed (job=${job.id}):`,
              e instanceof Error ? e.message : e,
            );
            try {
              await BulkListingJobRepository.markFinal(job.id, {
                success: 0,
                failed: 0,
                lastError: e instanceof Error ? e.message : "crash",
              });
            } catch {
              // ignore
            }
          }
        })();

        return reply.status(202).send({
          success: true,
          jobId: job.id,
          totalItems: job.totalItems,
        });
      } catch (error) {
        console.error("[Listing Routes] Error creating bulk job:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * GET /listings/bulk/:jobId
   * Retorna o estado completo de um BulkListingJob para polling.
   */
  app.get<{ Params: { jobId: string } }>(
    "/bulk/:jobId",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { jobId } = request.params as { jobId: string };

        const job = await BulkListingJobRepository.findByIdAndUser(
          jobId,
          userId,
        );
        if (!job) {
          return reply.status(404).send({
            error: "Job não encontrado",
            message: `BulkListingJob ${jobId} não pertence ao usuário`,
          });
        }

        return reply.send({
          id: job.id,
          status: job.status,
          totalItems: job.totalItems,
          doneItems: job.doneItems,
          successItems: job.successItems,
          failedItems: job.failedItems,
          results: job.results,
          lastError: job.lastError,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        });
      } catch (error) {
        console.error("[Listing Routes] Error fetching bulk job:", error);
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );

  /**
   * POST /listings/bulk/:jobId/retry-failed
   * Re-enfileira apenas os itens com success=false do job original em um
   * NOVO job, sem mexer no histórico do job anterior.
   */
  app.post<{ Params: { jobId: string } }>(
    "/bulk/:jobId/retry-failed",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user!.dataOwnerId;
        const { jobId } = request.params as { jobId: string };

        const job = await BulkListingJobRepository.findByIdAndUser(
          jobId,
          userId,
        );
        if (!job) {
          return reply.status(404).send({
            error: "Job não encontrado",
            message: `BulkListingJob ${jobId} não pertence ao usuário`,
          });
        }

        const results = Array.isArray(job.results)
          ? (job.results as unknown as Array<{
              productId: string;
              platform: BulkListingPlatform;
              accountId: string;
              success: boolean;
            }>)
          : [];
        const failed = results.filter((r) => !r.success);
        if (failed.length === 0) {
          return reply.status(400).send({
            error: "Nada para reprocessar",
            message: "Não há itens falhos neste job",
          });
        }

        // Reconstrói requests a partir das tuplas falhas. Mantém categoryId/
        // mlSettings do request original quando o accountId bate.
        const originalRequests =
          (job.requests as unknown as BulkListingRequestSpec[]) || [];
        const findOriginal = (platform: string, accountId: string) =>
          originalRequests.find(
            (r) => r.platform === platform && r.accountId === accountId,
          );

        const productIdsSet = new Set<string>();
        const requestsKey = new Map<string, BulkListingRequestSpec>();
        for (const f of failed) {
          productIdsSet.add(f.productId);
          const key = `${f.platform}:${f.accountId}`;
          if (!requestsKey.has(key)) {
            const orig = findOriginal(f.platform, f.accountId);
            requestsKey.set(key, {
              platform: f.platform,
              accountId: f.accountId,
              categoryId: orig?.categoryId,
              mlSettings: orig?.mlSettings,
            });
          }
        }

        const newJob = await BulkListingJobRepository.create({
          userId,
          productIds: Array.from(productIdsSet),
          requests: Array.from(requestsKey.values()),
          overrideTemplate:
            (job.overrideTemplate as unknown as BulkOverrideTemplate | null) ??
            null,
        });

        void (async () => {
          try {
            await BulkListingJobRepository.markRunning(newJob.id);
            const summary = await ListingDispatcher.dispatchBatch({
              userId,
              productIds: Array.from(productIdsSet),
              requests: Array.from(requestsKey.values()),
              overrideTemplate:
                (job.overrideTemplate as unknown as BulkOverrideTemplate | null) ??
                null,
              onItemDone: async (item) => {
                try {
                  await BulkListingJobRepository.appendResult(newJob.id, item);
                } catch (e) {
                  console.error(
                    `[Listing Routes] appendResult retry failed (job=${newJob.id}):`,
                    e instanceof Error ? e.message : e,
                  );
                }
              },
            });
            await BulkListingJobRepository.markFinal(newJob.id, summary);
          } catch (e) {
            await BulkListingJobRepository.markFinal(newJob.id, {
              success: 0,
              failed: 0,
              lastError: e instanceof Error ? e.message : "crash",
            });
          }
        })();

        return reply.status(202).send({
          success: true,
          jobId: newJob.id,
          totalItems: newJob.totalItems,
          parentJobId: jobId,
        });
      } catch (error) {
        console.error(
          "[Listing Routes] Error retrying failed bulk items:",
          error,
        );
        return reply.status(500).send({
          error: "Erro interno do servidor",
          message: error instanceof Error ? error.message : "Erro desconhecido",
        });
      }
    },
  );
}
