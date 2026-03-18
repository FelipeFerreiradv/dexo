/**
 * Repositório Prisma para Orders (Pedidos)
 * Implementa a interface OrderRepository
 */

import prisma from "../lib/prisma";
import {
  Order,
  OrderItem,
  OrderCreate,
  OrderUpdate,
  OrderFindOptions,
  OrderFindResult,
  OrderRepository,
  OrderStatus,
} from "../interfaces/order.interface";
import {
  Order as PrismaOrder,
  OrderItem as PrismaOrderItem,
  OrderStatus as PrismaOrderStatus,
} from "@prisma/client";

// Tipo do Prisma Order com relações
type PrismaOrderWithRelations = PrismaOrder & {
  items?: (PrismaOrderItem & {
    product?: {
      id: string;
      name: string;
      sku: string;
      stock: number;
    };
    listing?: {
      id: string;
      externalListingId: string;
      permalink: string | null;
    };
  })[];
  marketplaceAccount?: {
    id: string;
    platform: string;
    accountName: string;
  };
};

// Helper para converter PrismaOrderItem para OrderItem
function mapPrismaToOrderItem(
  item: PrismaOrderItem & {
    product?: {
      id: string;
      name: string;
      sku: string;
      stock: number;
    };
    listing?: {
      id: string;
      externalListingId: string;
      permalink: string | null;
    };
  },
): OrderItem {
  return {
    id: item.id,
    orderId: item.orderId,
    productId: item.productId,
    listingId: item.listingId ?? undefined,
    quantity: item.quantity,
    unitPrice: item.unitPrice.toNumber(),
    product: item.product
      ? {
          id: item.product.id,
          name: item.product.name,
          sku: item.product.sku,
          stock: item.product.stock,
        }
      : undefined,
    listing: item.listing
      ? {
          id: item.listing.id,
          externalListingId: item.listing.externalListingId,
          permalink: item.listing.permalink ?? undefined,
        }
      : undefined,
  };
}

// Helper para converter Prisma Order para interface Order
function mapPrismaToOrder(order: PrismaOrderWithRelations): Order {
  return {
    id: order.id,
    marketplaceAccountId: order.marketplaceAccountId,
    externalOrderId: order.externalOrderId,
    status: order.status as OrderStatus,
    totalAmount: order.totalAmount.toNumber(),
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items?.map(mapPrismaToOrderItem),
    marketplaceAccount: order.marketplaceAccount
      ? {
          id: order.marketplaceAccount.id,
          platform: order.marketplaceAccount.platform,
          accountName: order.marketplaceAccount.accountName,
        }
      : undefined,
  };
}

class OrderRepositoryPrisma implements OrderRepository {
  /**
   * Criar pedido com itens (transação atômica)
   */
  async create(data: OrderCreate): Promise<Order> {
    try {
      const result = await prisma.order.create({
        data: {
          marketplaceAccountId: data.marketplaceAccountId,
          externalOrderId: data.externalOrderId,
          status: (data.status as PrismaOrderStatus) ?? "PENDING",
          totalAmount: data.totalAmount,
          customerName: data.customerName ?? null,
          customerEmail: data.customerEmail ?? null,
          items: {
            create: data.items.map((item) => ({
              productId: item.productId,
              listingId: item.listingId ?? null,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          },
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  stock: true,
                },
              },
              listing: {
                select: {
                  id: true,
                  externalListingId: true,
                  permalink: true,
                },
              },
            },
          },
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accountName: true,
            },
          },
        },
      });

      return mapPrismaToOrder(result);
    } catch (error) {
      console.error("Erro Prisma ao criar pedido:", error);
      throw new Error(
        error instanceof Error ? error.message : "Erro ao criar pedido",
      );
    }
  }

  /**
   * Buscar pedido por ID interno
   */
  async findById(id: string): Promise<Order | null> {
    try {
      const result = await prisma.order.findUnique({
        where: { id },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  stock: true,
                },
              },
              listing: {
                select: {
                  id: true,
                  externalListingId: true,
                  permalink: true,
                },
              },
            },
          },
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accountName: true,
            },
          },
        },
      });

      if (!result) return null;
      return mapPrismaToOrder(result);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao buscar pedido",
      );
    }
  }

  /**
   * Buscar pedido por ID externo (ex: ID do ML)
   */
  async findByExternalOrderId(externalOrderId: string): Promise<Order | null> {
    try {
      const result = await prisma.order.findUnique({
        where: { externalOrderId },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  stock: true,
                },
              },
              listing: {
                select: {
                  id: true,
                  externalListingId: true,
                  permalink: true,
                },
              },
            },
          },
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accountName: true,
            },
          },
        },
      });

      if (!result) return null;
      return mapPrismaToOrder(result);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao buscar pedido",
      );
    }
  }

  /**
   * Listar pedidos com filtros e paginação
   */
  async findAll(options?: OrderFindOptions): Promise<OrderFindResult> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 10;
    const skip = (page - 1) * limit;

    // Construir filtros
    const where: {
      marketplaceAccountId?: string;
      marketplaceAccount?: { userId?: string };
      status?: PrismaOrderStatus;
      createdAt?: {
        gte?: Date;
        lte?: Date;
      };
      OR?: Array<{
        customerName?: { contains: string; mode: "insensitive" };
        externalOrderId?: { contains: string; mode: "insensitive" };
      }>;
    } = {};

    if (options?.marketplaceAccountId) {
      where.marketplaceAccountId = options.marketplaceAccountId;
    } else if (options?.userId) {
      where.marketplaceAccount = { userId: options.userId };
    }

    if (options?.status) {
      where.status = options.status as PrismaOrderStatus;
    }

    if (options?.dateFrom || options?.dateTo) {
      where.createdAt = {};
      if (options.dateFrom) {
        where.createdAt.gte = options.dateFrom;
      }
      if (options.dateTo) {
        where.createdAt.lte = options.dateTo;
      }
    }

    if (options?.search) {
      where.OR = [
        { customerName: { contains: options.search, mode: "insensitive" } },
        { externalOrderId: { contains: options.search, mode: "insensitive" } },
      ];
    }

    try {
      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    sku: true,
                    stock: true,
                  },
                },
                listing: {
                  select: {
                    id: true,
                    externalListingId: true,
                    permalink: true,
                  },
                },
              },
            },
            marketplaceAccount: {
              select: {
                id: true,
                platform: true,
                accountName: true,
              },
            },
          },
        }),
        prisma.order.count({ where }),
      ]);

      return {
        orders: orders.map(mapPrismaToOrder),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao listar pedidos",
      );
    }
  }

  /**
   * Listar pedidos de uma conta de marketplace específica
   */
  async findByMarketplaceAccount(
    marketplaceAccountId: string,
  ): Promise<Order[]> {
    try {
      const orders = await prisma.order.findMany({
        where: { marketplaceAccountId },
        orderBy: { createdAt: "desc" },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  stock: true,
                },
              },
              listing: {
                select: {
                  id: true,
                  externalListingId: true,
                  permalink: true,
                },
              },
            },
          },
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accountName: true,
            },
          },
        },
      });

      return orders.map(mapPrismaToOrder);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao listar pedidos",
      );
    }
  }

  /**
   * Atualizar pedido
   */
  async update(id: string, data: OrderUpdate): Promise<Order> {
    try {
      const result = await prisma.order.update({
        where: { id },
        data: {
          status: data.status as PrismaOrderStatus | undefined,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
        },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    name: true,
                    sku: true,
                    stock: true,
                  },
                },
                listing: {
                  select: {
                    id: true,
                    externalListingId: true,
                    permalink: true,
                  },
                },
              },
            },
            marketplaceAccount: {
              select: {
                id: true,
              platform: true,
              accountName: true,
            },
          },
        },
      });

      return mapPrismaToOrder(result);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao atualizar pedido",
      );
    }
  }

  /**
   * Contar pedidos
   */
  async count(marketplaceAccountId?: string): Promise<number> {
    try {
      return await prisma.order.count({
        where: marketplaceAccountId ? { marketplaceAccountId } : undefined,
      });
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao contar pedidos",
      );
    }
  }

  /**
   * Verificar se pedido já existe por ID externo
   */
  async exists(externalOrderId: string): Promise<boolean> {
    try {
      const count = await prisma.order.count({
        where: { externalOrderId },
      });
      return count > 0;
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Erro ao verificar pedido",
      );
    }
  }
}

// Exportar instância singleton
export const orderRepository = new OrderRepositoryPrisma();

// Exportar classe para testes
export { OrderRepositoryPrisma };
