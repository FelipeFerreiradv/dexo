import prisma from "../lib/prisma";
import {
  SystemLogCreate,
  SystemLogFilters,
} from "../interfaces/system-log.interface";

/**
 * Repositório para gerenciar SystemLogs
 * Logs gerais do sistema (login, CRUD, sincronizações, etc.)
 */
export class SystemLogRepository {
  /**
   * Cria um novo log do sistema
   */
  static async create(data: SystemLogCreate) {
    try {
      const log = await prisma.systemLog.create({
        data: {
          userId: data.userId || null,
          action: data.action,
          resource: data.resource || null,
          resourceId: data.resourceId || null,
          details: data.details || null,
          ipAddress: data.ipAddress || null,
          userAgent: data.userAgent || null,
          level: data.level || "INFO",
          message: data.message,
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });
      return log;
    } catch (error) {
      throw new Error(
        `Erro ao criar log do sistema: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Busca logs do sistema com filtros e paginação
   */
  static async findMany(filters: SystemLogFilters = {}) {
    try {
      const {
        userId,
        userIds,
        action,
        resource,
        level,
        startDate,
        endDate,
        page = 1,
        limit = 50,
      } = filters;

      const where: any = {};

      // Escopo multi-tenant tem precedência: `userIds` (mesmo vazio = fail-closed,
      // não retorna nada de outros tenants). Sem ele, mantém o filtro escalar.
      if (userIds) where.userId = { in: userIds };
      else if (userId) where.userId = userId;
      if (action) where.action = action;
      if (resource) where.resource = resource;
      if (level) where.level = level;

      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = startDate;
        if (endDate) where.createdAt.lte = endDate;
      }

      const [logs, total] = await Promise.all([
        prisma.systemLog.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.systemLog.count({ where }),
      ]);

      return {
        logs,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      throw new Error(
        `Erro ao buscar logs do sistema: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Busca um log específico por ID
   */
  static async findById(id: string) {
    try {
      return await prisma.systemLog.findUnique({
        where: { id },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });
    } catch (error) {
      throw new Error(
        `Erro ao buscar log do sistema: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Remove logs antigos (para limpeza).
   * `userIds` (opcional) restringe a exclusão ao tenant — sem ele a operação
   * é global e deve ser reservada a manutenção administrativa.
   */
  static async deleteOldLogs(olderThanDays: number = 90, userIds?: string[]) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const result = await prisma.systemLog.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
          ...(userIds ? { userId: { in: userIds } } : {}),
        },
      });

      return result.count;
    } catch (error) {
      throw new Error(
        `Erro ao remover logs antigos: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
