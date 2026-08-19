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
    u: PrismaUser & {
      parent?: {
        isActive: boolean;
        reopenListingsOnSaleCancel?: boolean;
      } | null;
    },
  ): User {
    // default-safe: só `false` explícito bloqueia; null/undefined/true => liberado.
    const ownActive = u.isActive ?? true;
    const parentActive = u.parent?.isActive ?? true;
    // Mesma disciplina para a reabertura de anúncio: ausente => LIGADO, que é o
    // comportamento de sempre. O `?? true` aqui não defende contra NULL no banco
    // (a coluna é NOT NULL) — defende contra projeção enxuta e mock de teste.
    const ownReopen = u.reopenListingsOnSaleCancel ?? true;
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

      reopenListingsOnSaleCancel: ownReopen,
      // HERANÇA, não cascata (diferente do isActive): a preferência é do TENANT,
      // então o colaborador exibe o valor do PAI, não a conjunção dos dois. A
      // linha do colaborador nunca é lida pelos motores de cancelamento — se a
      // tela mostrasse `ownReopen`, ela mentiria sobre o que vai acontecer.
      effectiveReopenListingsOnSaleCancel: u.parentUserId
        ? (u.parent?.reopenListingsOnSaleCancel ?? true)
        : ownReopen,

      // Permissões por página (colaboradores). null = acesso total.
      pagePermissions:
        (u.pagePermissions as Record<string, boolean> | null) ?? null,

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
          // Aditivos: só gravam quando enviados (Superadmin). Ausentes → role
          // cai no @default(USER) e defaultStock fica no @default(0) do schema,
          // mantendo o INSERT byte-idêntico para os chamadores atuais.
          ...(data.role !== undefined && { role: data.role }),
          ...(data.defaultStock !== undefined && {
            defaultStock: data.defaultStock,
          }),
          ...(data.pagePermissions !== undefined && {
            pagePermissions: data.pagePermissions ?? undefined,
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
        // `reopenListingsOnSaleCancel` do PAI entra aqui para o colaborador
        // enxergar o valor do tenant. O include já existia — nenhum round-trip
        // novo, só uma coluna a mais na projeção.
        include: {
          parent: {
            select: { isActive: true, reopenListingsOnSaleCancel: true },
          },
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
        // Status do admin pai junto (1 query, sem round-trip extra) p/ a
        // checagem de bloqueio em cascata. mapUser ignora `parent` fora disso.
        // `reopenListingsOnSaleCancel` do PAI entra aqui para o colaborador
        // enxergar o valor do tenant. O include já existia — nenhum round-trip
        // novo, só uma coluna a mais na projeção.
        include: {
          parent: {
            select: { isActive: true, reopenListingsOnSaleCancel: true },
          },
        },
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

  // EGRESS: lista enxuta de colaboradores p/ a tela de equipe — projeta só as
  // colunas exibidas (id/nome/e-mail/avatar/status), sem o hash de senha nem os
  // ~15 campos default* de anúncio que `findChildren` traz. Mesmo padrão das
  // demais listas do app (findAllForList/pipeline): a edição recarrega o
  // registro completo quando precisa. NÃO passa por mapUser (a lista usa só o
  // `isActive` próprio, não o effectiveActive em cascata).
  async findChildrenPublic(parentUserId: string): Promise<
    {
      id: string;
      email: string;
      name: string | null;
      avatarUrl: string | null;
      parentUserId: string | null;
      isActive: boolean;
      pagePermissions: Record<string, boolean> | null;
      createdAt: Date;
    }[]
  > {
    try {
      const rows = await prisma.user.findMany({
        where: { parentUserId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          parentUserId: true,
          isActive: true,
          pagePermissions: true,
          createdAt: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        pagePermissions:
          (r.pagePermissions as Record<string, boolean> | null) ?? null,
      }));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  // EGRESS: lista enxuta de TODOS os usuários p/ a área de Superadmin (Equipe
  // Dexo). Projeta só o necessário para a tela (hierarquia + defaults), sem o
  // hash de senha nem os ~15 campos default* de anúncio.
  async findAllForSuperadmin(): Promise<
    {
      id: string;
      email: string;
      name: string | null;
      role: Role;
      parentUserId: string | null;
      isActive: boolean;
      defaultCostPrice: number | null;
      defaultStock: number | null;
      pagePermissions: Record<string, boolean> | null;
      createdAt: Date;
    }[]
  > {
    try {
      const rows = await prisma.user.findMany({
        orderBy: [{ parentUserId: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          parentUserId: true,
          isActive: true,
          defaultCostPrice: true,
          defaultStock: true,
          pagePermissions: true,
          createdAt: true,
        },
      });
      return rows.map((u) => ({
        ...u,
        role: u.role as Role,
        defaultCostPrice:
          u.defaultCostPrice != null ? Number(u.defaultCostPrice) : null,
        pagePermissions:
          (u.pagePermissions as Record<string, boolean> | null) ?? null,
      }));
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

          // Reabrir anúncio ao cancelar venda (somente se fornecido).
          ...(data.reopenListingsOnSaleCancel !== undefined && {
            reopenListingsOnSaleCancel: data.reopenListingsOnSaleCancel,
          }),

          // Permissões por página (somente se fornecido; undefined → não altera)
          ...(data.pagePermissions !== undefined && {
            pagePermissions: data.pagePermissions ?? undefined,
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
