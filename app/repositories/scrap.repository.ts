import {
  Scrap,
  ScrapCreate,
  ScrapUpdate,
  ScrapRepository,
} from "../interfaces/scrap.interface";
import prisma from "../lib/prisma";
import { Scrap as PrismaScrap, ScrapStatus } from "@prisma/client";

function mapPrismaToScrap(
  item: PrismaScrap & {
    _count?: { products: number };
    location?: { code: string } | null;
  },
): Scrap {
  return {
    id: item.id,
    userId: item.userId,

    brand: item.brand,
    model: item.model,
    year: item.year ?? undefined,
    version: item.version ?? undefined,
    color: item.color ?? undefined,
    plate: item.plate ?? undefined,
    chassis: item.chassis ?? undefined,
    engineNumber: item.engineNumber ?? undefined,
    renavam: item.renavam ?? undefined,
    lot: item.lot ?? undefined,
    deregistrationCert: item.deregistrationCert ?? undefined,

    cost: item.cost?.toNumber() ?? undefined,
    paymentMethod: item.paymentMethod ?? undefined,

    locationId: item.locationId ?? undefined,
    locationCode: item.location?.code ?? undefined,

    ncm: item.ncm ?? undefined,
    supplierCnpj: item.supplierCnpj ?? undefined,
    accessKey: item.accessKey ?? undefined,
    issueDate: item.issueDate ?? undefined,
    entryDate: item.entryDate ?? undefined,
    nfeNumber: item.nfeNumber ?? undefined,
    nfeProtocol: item.nfeProtocol ?? undefined,
    operationNature: item.operationNature ?? undefined,
    nfeSeries: item.nfeSeries ?? undefined,
    fiscalModel: item.fiscalModel ?? undefined,
    icmsValue: item.icmsValue?.toNumber() ?? undefined,
    icmsCtValue: item.icmsCtValue?.toNumber() ?? undefined,
    freightMode: item.freightMode ?? undefined,
    issuePurpose: item.issuePurpose ?? undefined,

    imageUrls: item.imageUrls ?? [],

    status: item.status,
    notes: item.notes ?? undefined,

    createdAt: item.createdAt,
    updatedAt: item.updatedAt,

    productsCount: item._count?.products ?? 0,
  };
}

export class ScrapRepositoryPrisma implements ScrapRepository {
  async create(data: ScrapCreate): Promise<Scrap> {
    try {
      const result = await prisma.scrap.create({
        data: {
          userId: data.userId,
          brand: data.brand,
          model: data.model,
          year: data.year ?? null,
          version: data.version ?? null,
          color: data.color ?? null,
          plate: data.plate ?? null,
          chassis: data.chassis ?? null,
          engineNumber: data.engineNumber ?? null,
          renavam: data.renavam ?? null,
          lot: data.lot ?? null,
          deregistrationCert: data.deregistrationCert ?? null,
          cost: data.cost ?? null,
          paymentMethod: data.paymentMethod ?? null,
          locationId: data.locationId ?? null,
          ncm: data.ncm ?? null,
          supplierCnpj: data.supplierCnpj ?? null,
          accessKey: data.accessKey ?? null,
          issueDate: data.issueDate ?? null,
          entryDate: data.entryDate ?? null,
          nfeNumber: data.nfeNumber ?? null,
          nfeProtocol: data.nfeProtocol ?? null,
          operationNature: data.operationNature ?? null,
          nfeSeries: data.nfeSeries ?? null,
          fiscalModel: data.fiscalModel ?? null,
          icmsValue: data.icmsValue ?? null,
          icmsCtValue: data.icmsCtValue ?? null,
          freightMode: data.freightMode ?? null,
          issuePurpose: data.issuePurpose ?? null,
          imageUrls: data.imageUrls ?? [],
          status: data.status ?? "AVAILABLE",
          notes: data.notes ?? null,
        },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });

      return mapPrismaToScrap(result);
    } catch (error) {
      console.error("Erro Prisma ao criar sucata:", error);
      throw new Error(
        error instanceof Error ? error.message : "Erro ao criar sucata",
      );
    }
  }

  async findById(id: string, userId?: string): Promise<Scrap | null> {
    try {
      const item = await prisma.scrap.findFirst({
        where: { id, ...(userId ? { userId } : {}) },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });
      if (!item) return null;
      return mapPrismaToScrap(item);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async findAll(
    options?: {
      search?: string;
      status?: ScrapStatus;
      page?: number;
      limit?: number;
    },
    userId?: string,
  ): Promise<{ scraps: Scrap[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 10;
    const skip = (page - 1) * limit;
    const search = options?.search ?? "";

    const where: any = userId ? { userId } : {};

    if (options?.status) {
      where.status = options.status;
    }

    if (search) {
      where.OR = [
        { brand: { contains: search, mode: "insensitive" as const } },
        { model: { contains: search, mode: "insensitive" as const } },
        { plate: { contains: search, mode: "insensitive" as const } },
        { chassis: { contains: search, mode: "insensitive" as const } },
        { lot: { contains: search, mode: "insensitive" as const } },
      ];
    }

    try {
      const [items, total] = await Promise.all([
        prisma.scrap.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            location: { select: { code: true } },
            _count: { select: { products: true } },
          },
        }),
        prisma.scrap.count({ where }),
      ]);

      const scraps = items.map(mapPrismaToScrap);
      return { scraps, total };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async update(id: string, data: ScrapUpdate, userId?: string): Promise<Scrap> {
    try {
      if (userId) {
        const owner = await prisma.scrap.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Sucata não encontrada para este usuário");
      }

      const result = await prisma.scrap.update({
        where: { id },
        data: {
          ...(data.brand !== undefined && { brand: data.brand }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.year !== undefined && { year: data.year }),
          ...(data.version !== undefined && { version: data.version }),
          ...(data.color !== undefined && { color: data.color }),
          ...(data.plate !== undefined && { plate: data.plate }),
          ...(data.chassis !== undefined && { chassis: data.chassis }),
          ...(data.engineNumber !== undefined && {
            engineNumber: data.engineNumber,
          }),
          ...(data.renavam !== undefined && { renavam: data.renavam }),
          ...(data.lot !== undefined && { lot: data.lot }),
          ...(data.deregistrationCert !== undefined && {
            deregistrationCert: data.deregistrationCert,
          }),
          ...(data.cost !== undefined && { cost: data.cost }),
          ...(data.paymentMethod !== undefined && {
            paymentMethod: data.paymentMethod,
          }),
          ...(data.locationId !== undefined && { locationId: data.locationId }),
          ...(data.ncm !== undefined && { ncm: data.ncm }),
          ...(data.supplierCnpj !== undefined && {
            supplierCnpj: data.supplierCnpj,
          }),
          ...(data.accessKey !== undefined && { accessKey: data.accessKey }),
          ...(data.issueDate !== undefined && { issueDate: data.issueDate }),
          ...(data.entryDate !== undefined && { entryDate: data.entryDate }),
          ...(data.nfeNumber !== undefined && { nfeNumber: data.nfeNumber }),
          ...(data.nfeProtocol !== undefined && {
            nfeProtocol: data.nfeProtocol,
          }),
          ...(data.operationNature !== undefined && {
            operationNature: data.operationNature,
          }),
          ...(data.nfeSeries !== undefined && { nfeSeries: data.nfeSeries }),
          ...(data.fiscalModel !== undefined && {
            fiscalModel: data.fiscalModel,
          }),
          ...(data.icmsValue !== undefined && { icmsValue: data.icmsValue }),
          ...(data.icmsCtValue !== undefined && {
            icmsCtValue: data.icmsCtValue,
          }),
          ...(data.freightMode !== undefined && {
            freightMode: data.freightMode,
          }),
          ...(data.issuePurpose !== undefined && {
            issuePurpose: data.issuePurpose,
          }),
          ...(data.imageUrls !== undefined && { imageUrls: data.imageUrls }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
        include: {
          location: { select: { code: true } },
          _count: { select: { products: true } },
        },
      });

      return mapPrismaToScrap(result);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async delete(id: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        const owner = await prisma.scrap.findFirst({
          where: { id, userId },
          select: { id: true },
        });
        if (!owner) throw new Error("Sucata não encontrada para este usuário");
      }

      // Desvincula produtos antes de excluir (SET NULL)
      await prisma.product.updateMany({
        where: { scrapId: id },
        data: { scrapId: null },
      });

      await prisma.scrap.delete({ where: { id } });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async count(userId?: string): Promise<number> {
    try {
      return await prisma.scrap.count({ where: userId ? { userId } : {} });
    } catch {
      throw new Error("Erro ao contar sucatas");
    }
  }
}
