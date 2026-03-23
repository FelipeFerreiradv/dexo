import { Prisma, Role, User as PrismaUser } from "@prisma/client";
import {
  User,
  UserCreate,
  UserRepository,
  UserUpdate,
} from "../interfaces/user.interface";
import prisma from "../lib/prisma";

class UserRepositoryPrisma implements UserRepository {
  private mapUser(u: PrismaUser): User {
    return {
      id: u.id,
      email: u.email,
      password: u.password,
      role: u.role as Role,
      name: u.name,
      avatarUrl: u.avatarUrl ?? null,
      defaultProductDescription: u.defaultProductDescription ?? null,
      defaultCostPrice: u.defaultCostPrice ? Number(u.defaultCostPrice) : null,

      // Padrões de anúncio ML
      defaultListingType: u.defaultListingType ?? null,
      defaultHasWarranty: u.defaultHasWarranty ?? null,
      defaultWarrantyUnit: u.defaultWarrantyUnit ?? null,
      defaultWarrantyDuration: u.defaultWarrantyDuration ?? null,
      defaultItemCondition: u.defaultItemCondition ?? null,
      defaultShippingMode: u.defaultShippingMode ?? null,
      defaultFreeShipping: u.defaultFreeShipping ?? null,
      defaultLocalPickup: u.defaultLocalPickup ?? null,
      defaultManufacturingTime: u.defaultManufacturingTime ?? null,

      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }

  async create(data: UserCreate): Promise<User> {
    try {
      const result = await prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          password: data.password,
          avatarUrl: data.avatarUrl,
          defaultProductDescription: data.defaultProductDescription,
          defaultCostPrice: data.defaultCostPrice,
        },
      });
      return this.mapUser(result);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        console.error("PrismaCode:", err.code);
        console.error("PrismaMeta:", err.meta);
        console.error(err.message);
      } else {
        console.error(err);
      }
      throw err;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    try {
      const data = await prisma.user.findUnique({
        where: {
          email,
        },
      });
      return data ? this.mapUser(data) : null;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findById(id: string): Promise<User | null> {
    try {
      const data = await prisma.user.findUnique({
        where: {
          id,
        },
      });
      return data ? this.mapUser(data) : null;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async update(id: string, data: UserUpdate): Promise<User> {
    try {
      const result = await prisma.user.update({
        where: { id },
        data: {
          name: data.name,
          password: data.password,
          avatarUrl: data.avatarUrl,
          defaultProductDescription: data.defaultProductDescription,
          defaultCostPrice: data.defaultCostPrice,

          // Padrões de anúncio ML (somente se fornecidos, não sobrescrever com undefined)
          ...(data.defaultListingType !== undefined && {
            defaultListingType: data.defaultListingType,
          }),
          ...(data.defaultHasWarranty !== undefined && {
            defaultHasWarranty: data.defaultHasWarranty,
          }),
          ...(data.defaultWarrantyUnit !== undefined && {
            defaultWarrantyUnit: data.defaultWarrantyUnit,
          }),
          ...(data.defaultWarrantyDuration !== undefined && {
            defaultWarrantyDuration: data.defaultWarrantyDuration,
          }),
          ...(data.defaultItemCondition !== undefined && {
            defaultItemCondition: data.defaultItemCondition,
          }),
          ...(data.defaultShippingMode !== undefined && {
            defaultShippingMode: data.defaultShippingMode,
          }),
          ...(data.defaultFreeShipping !== undefined && {
            defaultFreeShipping: data.defaultFreeShipping,
          }),
          ...(data.defaultLocalPickup !== undefined && {
            defaultLocalPickup: data.defaultLocalPickup,
          }),
          ...(data.defaultManufacturingTime !== undefined && {
            defaultManufacturingTime: data.defaultManufacturingTime,
          }),
        },
      });
      return this.mapUser(result);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        console.error("PrismaCode:", err.code);
        console.error("PrismaMeta:", err.meta);
        console.error(err.message);
      } else {
        console.error(err);
      }
      throw err;
    }
  }
}

export { UserRepositoryPrisma };
export type { UserRepository };
