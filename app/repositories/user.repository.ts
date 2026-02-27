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
      defaultProductDescription: u.defaultProductDescription ?? null,
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
          defaultProductDescription: data.defaultProductDescription,
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
          defaultProductDescription: data.defaultProductDescription,
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
