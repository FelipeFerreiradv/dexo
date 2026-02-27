import prisma from "@/app/lib/prisma";

export interface CategoryUpsertEntry {
  externalId: string;
  siteId: string;
  name: string;
  fullPath: string;
  pathFromRoot: any;
  parentExternalId?: string | null;
  keywords?: string | null;
}

export class CategoryRepository {
  static async upsertMany(entries: CategoryUpsertEntry[]) {
    // Upsert sequentially to avoid DB write contention; number of categories is manageable
    for (const e of entries) {
      // Normalize fullPath: ensure a consistent ' > ' separator and trimmed segments
      function normalizeFullPath(fp?: string) {
        if (!fp) return fp;
        // Accept both '>' and '>' with spaces; collapse multiple whitespace
        return fp
          .split(">")
          .map((p) => p.trim())
          .filter(Boolean)
          .join(" > ");
      }
      const normalizedFullPath =
        normalizeFullPath(e.fullPath) ?? e.fullPath ?? "";
      await prisma.marketplaceCategory.upsert({
        where: { externalId: e.externalId },
        create: {
          externalId: e.externalId,
          siteId: e.siteId,
          name: e.name,
          fullPath: normalizedFullPath,
          pathFromRoot: e.pathFromRoot,
          parentExternalId: e.parentExternalId || null,
          keywords: e.keywords || null,
        },
        update: {
          name: e.name,
          fullPath: normalizedFullPath,
          pathFromRoot: e.pathFromRoot,
          parentExternalId: e.parentExternalId || null,
          keywords: e.keywords || null,
          updatedAt: new Date(),
        },
      });
    }
  }

  static async findByExternalId(externalId: string) {
    return prisma.marketplaceCategory.findUnique({ where: { externalId } });
  }

  static async listFlattenedOptions(siteId?: string) {
    const where = siteId ? { siteId } : {};
    return prisma.marketplaceCategory.findMany({
      where,
      select: { id: true, externalId: true, fullPath: true, name: true },
      orderBy: { fullPath: "asc" },
    });
  }

  static async findByFullPath(fullPath: string) {
    return prisma.marketplaceCategory.findFirst({ where: { fullPath } });
  }
}

export default CategoryRepository;
