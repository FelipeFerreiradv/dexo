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
      imageUrl?: string | null;
      location?: string | null;
      productLocation?: {
        id: string;
        code: string;
        description: string | null;
      } | null;
      listings?: {
        id: string;
        externalListingId: string;
        permalink: string | null;
        status?: string | null;
        marketplaceAccount?: { platform: string } | null;
      }[];
    };
    listing?: {
      id: string;
      externalListingId: string;
      permalink: string | null;
      status?: string | null;
      marketplaceAccount?: { platform: string } | null;
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
      imageUrl?: string | null;
      location?: string | null;
      productLocation?: {
        id: string;
        code: string;
        description: string | null;
      } | null;
      listings?: {
        id: string;
        externalListingId: string;
        permalink: string | null;
        status?: string | null;
        marketplaceAccount?: { platform: string } | null;
      }[];
    };
    listing?: {
      id: string;
      externalListingId: string;
      permalink: string | null;
      status?: string | null;
      marketplaceAccount?: { platform: string } | null;
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
          imageUrl: item.product.imageUrl ?? null,
          location: item.product.location ?? null,
          productLocation: item.product.productLocation
            ? {
                id: item.product.productLocation.id,
                code: item.product.productLocation.code,
                description: item.product.productLocation.description ?? null,
              }
            : null,
          listings: item.product.listings?.map((l) => ({
            id: l.id,
            externalListingId: l.externalListingId,
            permalink: l.permalink ?? null,
            status: l.status ?? null,
            platform: l.marketplaceAccount?.platform ?? null,
          })),
        }
      : undefined,
    listing: item.listing
      ? {
          id: item.listing.id,
          externalListingId: item.listing.externalListingId,
          permalink: item.listing.permalink ?? undefined,
          status: item.listing.status ?? undefined,
          platform: item.listing.marketplaceAccount?.platform ?? undefined,
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
                  location: true,
                  productLocation: {
                    select: {
                      id: true,
                      code: true,
                      description: true,
                    },
                  },
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
      // P2002 (unique constraint) acontece em race entre webhooks ML duplicados
      // do mesmo pedido (vimos isso causar acúmulo de stacktraces e OOM em prod).
      // O caller (processOrder) trata como `already_exists` quando o erro
      // carrega `code === "P2002"`. ANTES desta fix, o `throw new Error(...)`
      // descartava o `code` original, então o catch superior nunca pegava o
      // ramo concurrent — caía no ramo genérico e logava o stack inteiro 2x
      // (uma no repository, outra no usecase).
      const isPrismaUniqueError =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as any).code === "P2002";
      if (isPrismaUniqueError) {
        // Log compacto: sem stack, sem objeto inteiro. Reduz pressão de memória
        // quando centenas de webhooks chegam simultaneamente.
        console.warn(
          `[OrderRepository] race P2002 ao criar order (já existe): account=${data.marketplaceAccountId} externalOrderId=${data.externalOrderId}`,
        );
        const dupErr = new Error("Pedido já existe (concurrent)");
        (dupErr as any).code = "P2002";
        throw dupErr;
      }
      console.error("Erro Prisma ao criar pedido:", error);
      throw new Error(
        error instanceof Error ? error.message : "Erro ao criar pedido",
      );
    }
  }

  /**
   * Buscar pedido por ID interno.
   * SEGURANÇA (multi-tenant): quando `userId` é informado, escopa pelo dono via
   * `marketplaceAccount.userId` — impede ler pedido de outro tenant por id.
   * As rotas HTTP SEMPRE passam o userId; chamadas internas de sync podem omitir.
   */
  async findById(id: string, userId?: string): Promise<Order | null> {
    try {
      const result = await prisma.order.findFirst({
        where: {
          id,
          ...(userId ? { marketplaceAccount: { userId } } : {}),
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
                  // imageUrl só aqui (detalhe) e no findAllForList (vitrine) —
                  // os demais selects não exibem imagem (egress enxuto).
                  imageUrl: true,
                  location: true,
                  productLocation: {
                    select: {
                      id: true,
                      code: true,
                      description: true,
                    },
                  },
                  // Fallback do "Ver anúncio" quando o OrderItem não tem listing
                  // vinculado (import legado/fallback): o sheet resolve o anúncio
                  // preferido do PRODUTO. Só no detalhe (egress bounded).
                  listings: {
                    select: {
                      id: true,
                      externalListingId: true,
                      permalink: true,
                      status: true,
                      marketplaceAccount: { select: { platform: true } },
                    },
                    orderBy: { updatedAt: "desc" },
                  },
                },
              },
              // status + platform da conta permitem o detalhe do pedido usar o
              // MESMO resolvedor de link do modal (URL correta / gating).
              listing: {
                select: {
                  id: true,
                  externalListingId: true,
                  permalink: true,
                  status: true,
                  marketplaceAccount: { select: { platform: true } },
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
   * Leitura ENXUTA p/ pré-popular o rascunho de NF-e a partir do pedido.
   * Seleciona SÓ o que o autopreenchimento usa (cliente + itens com produto)
   * — não puxa imageUrl/localização/listing/conta do `findById` (egress).
   * Escopada por `userId` (multi-tenant). `unitPrice` Decimal → number.
   */
  async findForFiscalDraft(
    id: string,
    userId: string,
  ): Promise<{
    id: string;
    externalOrderId: string;
    customerName: string | null;
    customerEmail: string | null;
    // Conta de origem: permite ao prefill buscar os dados fiscais reais do
    // comprador no marketplace (ex.: ML billing_info) quando não há Customer.
    marketplaceAccount: {
      id: string;
      platform: string;
      shopId: number | null;
      accessToken: string | null;
      refreshToken: string | null;
      expiresAt: Date | null;
    } | null;
    items: Array<{
      productId: string;
      quantity: number;
      unitPrice: number;
      product: { sku: string; name: string } | null;
    }>;
  } | null> {
    const result = await prisma.order.findFirst({
      where: { id, marketplaceAccount: { userId } },
      select: {
        id: true,
        externalOrderId: true,
        customerName: true,
        customerEmail: true,
        marketplaceAccount: {
          select: {
            id: true,
            platform: true,
            shopId: true,
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
          },
        },
        items: {
          select: {
            productId: true,
            quantity: true,
            unitPrice: true,
            product: { select: { sku: true, name: true } },
          },
        },
      },
    });
    if (!result) return null;
    return {
      id: result.id,
      externalOrderId: result.externalOrderId,
      customerName: result.customerName,
      customerEmail: result.customerEmail,
      marketplaceAccount: result.marketplaceAccount
        ? {
            id: result.marketplaceAccount.id,
            platform: result.marketplaceAccount.platform,
            shopId: result.marketplaceAccount.shopId,
            accessToken: result.marketplaceAccount.accessToken,
            refreshToken: result.marketplaceAccount.refreshToken,
            expiresAt: result.marketplaceAccount.expiresAt,
          }
        : null,
      items: result.items.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: Number(it.unitPrice),
        product: it.product
          ? { sku: it.product.sku, name: it.product.name }
          : null,
      })),
    };
  }

  /**
   * Buscar pedido por ID externo (ex: ID do ML)
   */
  async findByExternalOrderId(externalOrderId: string): Promise<Order | null> {
    try {
      const result = await prisma.order.findFirst({
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
                  location: true,
                  productLocation: {
                    select: {
                      id: true,
                      code: true,
                      description: true,
                    },
                  },
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
      marketplaceAccount?: { userId?: string; platform?: any };
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

    if (options?.platform) {
      where.marketplaceAccount = {
        ...where.marketplaceAccount,
        platform: options.platform,
      };
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
      const includeItems = options?.includeItems ?? true;
      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            items: includeItems
              ? {
                  include: {
                    product: {
                      select: {
                        id: true,
                        name: true,
                        sku: true,
                        stock: true,
                        location: true,
                        productLocation: {
                          select: {
                            id: true,
                            code: true,
                            description: true,
                          },
                        },
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
                }
              : false,
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
   * Listar pedidos para a VITRINE (lista). Espelha os filtros do `findAll`
   * (escopo do tenant, plataforma, status, período e busca) e adiciona faixa de
   * valor (`totalAmount`). Em vez de trafegar o grafo completo de itens, traz só
   * uma miniatura leve do 1º item (`thumbnail`) + a contagem (`itemCount`).
   * `findAll`/`mapPrismaToOrder` ficam intocados — zero regressão nas demais
   * leituras, que continuam sem `thumbnail`/`itemCount`.
   */
  async findAllForList(options?: OrderFindOptions): Promise<OrderFindResult> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: {
      marketplaceAccountId?: string;
      marketplaceAccount?: { userId?: string; platform?: any };
      status?: PrismaOrderStatus;
      createdAt?: {
        gte?: Date;
        lte?: Date;
      };
      totalAmount?: {
        gte?: number;
        lte?: number;
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

    if (options?.platform) {
      where.marketplaceAccount = {
        ...where.marketplaceAccount,
        platform: options.platform,
      };
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

    // Faixa de valor: só aplica quando vier número finito (ignora NaN/undefined),
    // garantindo no-op idêntico ao de hoje quando o filtro está vazio.
    const hasMin =
      typeof options?.amountMin === "number" &&
      Number.isFinite(options.amountMin);
    const hasMax =
      typeof options?.amountMax === "number" &&
      Number.isFinite(options.amountMax);
    if (hasMin || hasMax) {
      where.totalAmount = {};
      if (hasMin) where.totalAmount.gte = options!.amountMin;
      if (hasMax) where.totalAmount.lte = options!.amountMax;
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
            // Miniatura do 1º item para o card — NUNCA o grafo inteiro de itens.
            // `OrderItem` não tem createdAt; `id` (cuid ≈ ordem de inserção) é o
            // orderBy determinístico para "primeiro item".
            items: {
              take: 1,
              orderBy: { id: "asc" },
              select: {
                product: {
                  select: {
                    imageUrl: true,
                    name: true,
                    sku: true,
                    location: true,
                    productLocation: { select: { code: true } },
                  },
                },
              },
            },
            _count: { select: { items: true } },
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
        orders: orders.map((o) => {
          // Remove `items`/`_count` antes do mapper compartilhado: sem `items`,
          // `mapPrismaToOrder` deixa `order.items` undefined (egress enxuto; o
          // sheet segue recarregando o pedido completo via GET /orders/:id).
          const { items, _count, ...rest } = o;
          const base = mapPrismaToOrder(rest as PrismaOrderWithRelations);
          const first = items?.[0]?.product;
          return {
            ...base,
            thumbnail: first
              ? {
                  imageUrl: first.imageUrl ?? null,
                  name: first.name,
                  sku: first.sku,
                  location:
                    first.productLocation?.code ?? first.location ?? null,
                }
              : undefined,
            itemCount: _count?.items ?? 0,
          };
        }),
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
                  location: true,
                  productLocation: {
                    select: {
                      id: true,
                      code: true,
                      description: true,
                    },
                  },
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
   * Atualizar pedido.
   * SEGURANÇA (multi-tenant): quando `userId` é informado, verifica a posse via
   * `marketplaceAccount.userId` antes de escrever — impede alterar pedido de
   * outro tenant por id. Rotas HTTP SEMPRE passam o userId.
   */
  async update(id: string, data: OrderUpdate, userId?: string): Promise<Order> {
    try {
      if (userId) {
        const owned = await prisma.order.findFirst({
          where: { id, marketplaceAccount: { userId } },
          select: { id: true },
        });
        if (!owned) throw new Error("Pedido não encontrado");
      }
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
                  location: true,
                  productLocation: {
                    select: {
                      id: true,
                      code: true,
                      description: true,
                    },
                  },
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
   * Verificar se pedido já existe para (marketplaceAccountId, externalOrderId).
   * Usa o unique composto do schema — externalOrderId sozinho NÃO é unique.
   */
  async exists(
    marketplaceAccountId: string,
    externalOrderId: string,
  ): Promise<boolean> {
    const found = await prisma.order.findUnique({
      where: {
        marketplaceAccountId_externalOrderId: {
          marketplaceAccountId,
          externalOrderId,
        },
      },
      select: { id: true },
    });
    return found !== null;
  }
}

// Exportar instância singleton
export const orderRepository = new OrderRepositoryPrisma();

// Exportar classe para testes
export { OrderRepositoryPrisma };
