import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { authMiddleware } from "../middlewares/auth.middleware";
import { parseScannedPayload } from "../lib/qr-payloads";
import { normalizeSku } from "../lib/sku";

/**
 * Rotas para o fluxo de scan via QR Code.
 * - GET /scan/resolve?payload=<urlencoded> — interpreta um QR escaneado e
 *   resolve para um produto ou uma localização do tenant atual.
 */
export const scanRoutes = async (fastify: FastifyInstance) => {
  fastify.get(
    "/resolve",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const { payload } = request.query as { payload?: string };

        const scannedAt = Date.now();
        const parsed = parseScannedPayload(payload ?? null);

        // Parser não conseguiu classificar por URL/CUID (ex.: SKU digitado no
        // campo manual do Passo 2). Antes de desistir, tenta resolver como SKU
        // do tenant — padrão canônico `skuNormalized` + `normalizeSku` (case/
        // space-insensitive, coberto por @@index([userId, skuNormalized])).
        // Escopado por `userId`: SKU inexistente/de outro tenant → null →
        // devolve `unknown` (200), sem vazar existência. Retrocompatível: os
        // ramos de URL/CUID abaixo seguem intactos.
        if (parsed.kind === "unknown" && !parsed.id) {
          const normalized = normalizeSku(payload ?? null);
          if (normalized) {
            const prod = await prisma.product.findFirst({
              where: { userId, skuNormalized: normalized },
              select: {
                id: true,
                sku: true,
                name: true,
                imageUrl: true,
                locationId: true,
                productLocation: { select: { code: true } },
              },
            });
            if (prod) {
              return reply.status(200).send({
                kind: "product",
                scannedAt,
                product: {
                  id: prod.id,
                  sku: prod.sku,
                  name: prod.name,
                  imageUrl: prod.imageUrl ?? null,
                  currentLocationId: prod.locationId ?? null,
                  currentLocationCode: prod.productLocation?.code ?? null,
                },
              });
            }
          }
          return reply.status(200).send({ kind: "unknown", scannedAt });
        }

        if (parsed.kind === "location" && parsed.id) {
          const loc = await prisma.location.findFirst({
            where: { id: parsed.id, userId },
            include: { _count: { select: { products: true } } },
          });
          if (!loc) {
            return reply.status(404).send({
              error: "Localização não encontrada",
              kind: "location",
              scannedAt,
            });
          }
          const productsCount = loc._count?.products ?? 0;
          return reply.status(200).send({
            kind: "location",
            scannedAt,
            location: {
              id: loc.id,
              code: loc.code,
              description: loc.description ?? null,
              maxCapacity: loc.maxCapacity,
              productsCount,
              isFull:
                loc.maxCapacity > 0 && productsCount >= loc.maxCapacity,
            },
          });
        }

        if (parsed.kind === "product" && parsed.id) {
          const prod = await prisma.product.findFirst({
            where: { id: parsed.id, userId },
            select: {
              id: true,
              sku: true,
              name: true,
              imageUrl: true,
              locationId: true,
              productLocation: { select: { code: true } },
            },
          });
          if (!prod) {
            return reply.status(404).send({
              error: "Produto não encontrado",
              kind: "product",
              scannedAt,
            });
          }
          return reply.status(200).send({
            kind: "product",
            scannedAt,
            product: {
              id: prod.id,
              sku: prod.sku,
              name: prod.name,
              imageUrl: prod.imageUrl ?? null,
              currentLocationId: prod.locationId ?? null,
              currentLocationCode: prod.productLocation?.code ?? null,
            },
          });
        }

        // CUID puro (unknown com id): tenta resolver como location E product
        // em paralelo (location prevalece). Útil para leitores que cortam o
        // prefixo da URL.
        if (parsed.kind === "unknown" && parsed.id) {
          const [loc, prod] = await Promise.all([
            prisma.location.findFirst({
              where: { id: parsed.id, userId },
              include: { _count: { select: { products: true } } },
            }),
            prisma.product.findFirst({
              where: { id: parsed.id, userId },
              select: {
                id: true,
                sku: true,
                name: true,
                imageUrl: true,
                locationId: true,
                productLocation: { select: { code: true } },
              },
            }),
          ]);
          if (loc) {
            const productsCount = loc._count?.products ?? 0;
            return reply.status(200).send({
              kind: "location",
              scannedAt,
              location: {
                id: loc.id,
                code: loc.code,
                description: loc.description ?? null,
                maxCapacity: loc.maxCapacity,
                productsCount,
                isFull:
                  loc.maxCapacity > 0 && productsCount >= loc.maxCapacity,
              },
            });
          }
          if (prod) {
            return reply.status(200).send({
              kind: "product",
              scannedAt,
              product: {
                id: prod.id,
                sku: prod.sku,
                name: prod.name,
                imageUrl: prod.imageUrl ?? null,
                currentLocationId: prod.locationId ?? null,
                currentLocationCode: prod.productLocation?.code ?? null,
              },
            });
          }
          return reply
            .status(404)
            .send({ error: "Recurso não encontrado", kind: "unknown", scannedAt });
        }

        return reply.status(200).send({ kind: "unknown", scannedAt });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Erro ao resolver scan";
        return reply.status(500).send({ error: message });
      }
    },
  );
};
