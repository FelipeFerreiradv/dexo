import { Prisma, Role, User as PrismaUser } from "@prisma/client";
import {
  User,
  UserCreate,
  UserRepository,
  UserUpdate,
} from "../interfaces/user.interface";
import prisma from "../lib/prisma";
import { hashPassword, isHashed } from "../lib/password";

class UserRepositoryPrisma implements UserRepository {
  private mapUser(
    u: PrismaUser & { parent?: { isActive: boolean } | null },
  ): User {
    // default-safe: só `false` explícito bloqueia; null/undefined/true => liberado.
    const ownActive = u.isActive ?? true;
    const parentActive = u.parent?.isActive ?? true;
    return {
      id: u.id,
      email: u.email,
      password: u.password,
      role: u.role as Role,
      parentUserId: u.parentUserId ?? null,
      name: u.name,
      avatarUrl: u.avatarUrl ?? null,
      defaultProductDescription: u.defaultProductDescription ?? null,
      defaultCostPrice: u.defaultCostPrice ? Number(u.defaultCostPrice) : null,
      defaultStock: u.defaultStock ?? null,

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

      // Aumento percentual escalonado entre contas ML (default 0)
      crossAccountPriceIncreasePercent: u.crossAccountPriceIncreasePercent
        ? Number(u.crossAccountPriceIncreasePercent)
        : 0,

      isActive: ownActive,
      // Cascata: colaborador cai junto quando o admin pai é bloqueado.
      effectiveActive: ownActive && parentActive,

      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }

  async create(data: UserCreate): Promise<User> {
    try {
      // Senha SEMPRE armazenada como hash bcrypt (nunca texto plano).
      const hashedPassword = await hashPassword(data.password);
      const result = await prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          password: hashedPassword,
          avatarUrl: data.avatarUrl,
          defaultProductDescription: data.defaultProductDescription,
          defaultCostPrice: data.defaultCostPrice,
          ...(data.parentUserId !== undefined && {
            parentUserId: data.parentUserId,
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

  async findByEmail(email: string): Promise<User | null> {
    try {
      const data = await prisma.user.findUnique({
        where: {
          email,
        },
        // Status do admin pai junto (1 query, sem round-trip extra) p/ a
        // checagem de bloqueio em cascata. mapUser ignora `parent` fora disso.
        include: { parent: { select: { isActive: true } } },
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
        // Status do admin pai junto (1 query, sem round-trip extra) p/ a
        // checagem de bloqueio em cascata. mapUser ignora `parent` fora disso.
        include: { parent: { select: { isActive: true } } },
      });
      return data ? this.mapUser(data) : null;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findChildren(parentUserId: string): Promise<User[]> {
    try {
      const data = await prisma.user.findMany({
        where: { parentUserId },
        orderBy: { createdAt: "asc" },
      });
      return data.map((u) => this.mapUser(u));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async update(id: string, data: UserUpdate): Promise<User> {
    try {
      // Hash da senha quando fornecida em texto plano (troca de senha ou rehash
      // transparente). `undefined` => Prisma ignora o campo (não sobrescreve).
      // Valor já hasheado (rehash vindo do login) é gravado como está.
      const passwordToStore =
        data.password === undefined
          ? undefined
          : isHashed(data.password)
            ? data.password
            : await hashPassword(data.password);
      const result = await prisma.user.update({
        where: { id },
        data: {
          name: data.name,
          password: passwordToStore,
          avatarUrl: data.avatarUrl,
          defaultProductDescription: data.defaultProductDescription,
          defaultCostPrice: data.defaultCostPrice,

          // defaultStock: somente se fornecido (não sobrescrever com undefined)
          ...(data.defaultStock !== undefined && {
            defaultStock: data.defaultStock,
          }),

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

          // Aumento percentual escalonado entre contas ML
          ...(data.crossAccountPriceIncreasePercent !== undefined && {
            crossAccountPriceIncreasePercent:
              data.crossAccountPriceIncreasePercent,
          }),

          // Acesso liberado/bloqueado (somente se fornecido)
          ...(data.isActive !== undefined && { isActive: data.isActive }),
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

  async getLastSkuSequential(id: string): Promise<number | null> {
    const u = await prisma.user.findUnique({
      where: { id },
      select: { lastSkuSequential: true },
    });
    return u?.lastSkuSequential ?? null;
  }

  async bumpLastSkuSequential(id: string, candidate: number): Promise<void> {
    // Bump atômico: nunca regride o contador. Dois inserts paralelos com
    // valores diferentes resolvem na ordem que chegarem ao DB, mas o
    // resultado final é sempre o maior dos dois.
    await prisma.$executeRaw`
      UPDATE "User"
      SET "lastSkuSequential" = ${candidate}
      WHERE id = ${id}
        AND ("lastSkuSequential" IS NULL OR "lastSkuSequential" < ${candidate})
    `;
  }

  async reserveNextSkuSequential(id: string): Promise<number> {
    // Reserva atômica: COALESCE(...,0)+1 numa única instrução UPDATE. Duas
    // chamadas concorrentes serializam no lock da linha do User e recebem
    // números DISTINTOS. O RETURNING devolve exatamente o valor que ESTA
    // instrução gravou — sem segunda leitura, sem corrida.
    const rows = await prisma.$queryRaw<
      Array<{ lastSkuSequential: number | bigint }>
    >(
      Prisma.sql`
        UPDATE "User"
        SET "lastSkuSequential" = COALESCE("lastSkuSequential", 0) + 1
        WHERE id = ${id}
        RETURNING "lastSkuSequential"
      `,
    );
    if (rows.length === 0 || rows[0].lastSkuSequential == null) {
      throw new Error("Usuário não encontrado");
    }
    // Coerção obrigatória: int4 via $queryRaw pode chegar como number OU bigint
    // dependendo do driver. Number() é lossless aqui (limite de 6 dígitos).
    return Number(rows[0].lastSkuSequential);
  }
}

export { UserRepositoryPrisma };
export type { UserRepository };
