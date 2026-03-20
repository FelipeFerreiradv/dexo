import {
  Location,
  LocationCreate,
  LocationUpdate,
  LocationRepository,
} from "../interfaces/location.interface";
import prisma from "../lib/prisma";
import { Location as PrismaLocation } from "@prisma/client";

function mapPrismaToLocation(
  item: PrismaLocation & {
    children?: PrismaLocation[];
    parent?: PrismaLocation | null;
    _count?: { products?: number; children?: number };
  },
): Location {
  return {
    id: item.id,
    userId: item.userId,
    code: item.code,
    description: item.description ?? undefined,
    maxCapacity: item.maxCapacity,
    parentId: item.parentId ?? undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    productsCount: item._count?.products ?? 0,
    children: item.children?.map((c) =>
      mapPrismaToLocation(
        c as PrismaLocation & {
          _count?: { products?: number; children?: number };
        },
      ),
    ),
    parent: item.parent
      ? mapPrismaToLocation(
          item.parent as PrismaLocation & {
            _count?: { products?: number; children?: number };
          },
        )
      : undefined,
  };
}

export class LocationRepositoryPrisma implements LocationRepository {
  async create(data: LocationCreate): Promise<Location> {
    const result = await prisma.location.create({
      data: {
        userId: data.userId,
        code: data.code,
        description: data.description ?? null,
        maxCapacity: data.maxCapacity,
        parentId: data.parentId ?? null,
      },
      include: {
        _count: { select: { products: true, children: true } },
      },
    });
    return mapPrismaToLocation(result);
  }

  async findById(id: string, userId?: string): Promise<Location | null> {
    const where: any = { id };
    if (userId) where.userId = userId;

    const result = await prisma.location.findFirst({
      where,
      include: {
        parent: true,
        children: {
          include: {
            _count: { select: { products: true, children: true } },
          },
          orderBy: { code: "asc" },
        },
        _count: { select: { products: true, children: true } },
      },
    });

    if (!result) return null;
    return mapPrismaToLocation(result);
  }

  async findAll(
    options?: {
      search?: string;
      parentId?: string | null;
      page?: number;
      limit?: number;
    },
    userId?: string,
  ): Promise<{ locations: Location[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (userId) where.userId = userId;

    // parentId filter: null = only root locations, string = children of specific parent
    if (options?.parentId === null || options?.parentId === undefined) {
      // When no parentId specified and no search, show only roots
      if (!options?.search) {
        where.parentId = null;
      }
    } else {
      where.parentId = options.parentId;
    }

    if (options?.search) {
      where.OR = [
        { code: { contains: options.search, mode: "insensitive" } },
        { description: { contains: options.search, mode: "insensitive" } },
      ];
    }

    const [locations, total] = await Promise.all([
      prisma.location.findMany({
        where,
        skip,
        take: limit,
        orderBy: { code: "asc" },
        include: {
          children: {
            include: {
              _count: { select: { products: true, children: true } },
            },
            orderBy: { code: "asc" },
          },
          _count: { select: { products: true, children: true } },
        },
      }),
      prisma.location.count({ where }),
    ]);

    return {
      locations: locations.map(mapPrismaToLocation),
      total,
    };
  }

  async findByCode(code: string, userId: string): Promise<Location | null> {
    const result = await prisma.location.findFirst({
      where: { code, userId },
      include: {
        _count: { select: { products: true, children: true } },
      },
    });
    if (!result) return null;
    return mapPrismaToLocation(result);
  }

  async update(
    id: string,
    data: LocationUpdate,
    userId?: string,
  ): Promise<Location> {
    const where: any = { id };
    if (userId) {
      // Verify ownership first
      const existing = await prisma.location.findFirst({
        where: { id, userId },
      });
      if (!existing) throw new Error("Localização não encontrada");
    }

    const result = await prisma.location.update({
      where: { id },
      data: {
        ...(data.code !== undefined && { code: data.code }),
        ...(data.description !== undefined && {
          description: data.description,
        }),
        ...(data.maxCapacity !== undefined && {
          maxCapacity: data.maxCapacity,
        }),
        ...(data.parentId !== undefined && { parentId: data.parentId }),
      },
      include: {
        children: {
          include: {
            _count: { select: { products: true, children: true } },
          },
          orderBy: { code: "asc" },
        },
        _count: { select: { products: true, children: true } },
      },
    });
    return mapPrismaToLocation(result);
  }

  async delete(id: string, userId?: string): Promise<void> {
    if (userId) {
      const existing = await prisma.location.findFirst({
        where: { id, userId },
      });
      if (!existing) throw new Error("Localização não encontrada");
    }

    // Recursively delete children and unlink products
    await this.deleteRecursive(id);
  }

  private async deleteRecursive(id: string): Promise<void> {
    // Find all children
    const children = await prisma.location.findMany({
      where: { parentId: id },
      select: { id: true },
    });

    // Recursively delete children
    for (const child of children) {
      await this.deleteRecursive(child.id);
    }

    // Unlink products from this location
    await prisma.product.updateMany({
      where: { locationId: id },
      data: { locationId: null },
    });

    // Delete the location
    await prisma.location.delete({ where: { id } });
  }

  async getChildrenCount(id: string): Promise<number> {
    return prisma.location.count({ where: { parentId: id } });
  }

  async getProductsCount(id: string): Promise<number> {
    return prisma.product.count({ where: { locationId: id } });
  }

  async getDescendantProductsCount(id: string): Promise<number> {
    // Count products directly in this location
    let count = await prisma.product.count({ where: { locationId: id } });

    // Count products in all descendant locations
    const children = await prisma.location.findMany({
      where: { parentId: id },
      select: { id: true },
    });

    for (const child of children) {
      count += await this.getDescendantProductsCount(child.id);
    }

    return count;
  }

  async getProductsByLocationId(
    locationId: string,
    userId: string,
    options?: { search?: string; page?: number; limit?: number },
  ): Promise<{
    products: Array<{
      id: string;
      sku: string;
      name: string;
      imageUrl?: string;
      stock: number;
      price: number;
      location?: string;
    }>;
    total: number;
  }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: any = { locationId, userId };
    if (options?.search) {
      where.OR = [
        { name: { contains: options.search, mode: "insensitive" } },
        { sku: { contains: options.search, mode: "insensitive" } },
      ];
      // When searching, remove the top-level AND and merge
      const searchWhere = {
        locationId,
        userId,
        OR: where.OR,
      };
      Object.assign(where, searchWhere);
    }

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: "asc" },
        select: {
          id: true,
          sku: true,
          name: true,
          imageUrl: true,
          stock: true,
          price: true,
          location: true,
        },
      }),
      prisma.product.count({ where }),
    ]);

    return {
      products: items.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        imageUrl: p.imageUrl ?? undefined,
        stock: p.stock,
        price: Number(p.price),
        location: p.location ?? undefined,
      })),
      total,
    };
  }

  async moveProducts(
    productIds: string[],
    targetLocationId: string | null,
    userId: string,
    locationText?: string | null,
  ): Promise<number> {
    const result = await prisma.product.updateMany({
      where: {
        id: { in: productIds },
        userId,
      },
      data: {
        locationId: targetLocationId,
        location: locationText ?? null,
      },
    });
    return result.count;
  }
}
