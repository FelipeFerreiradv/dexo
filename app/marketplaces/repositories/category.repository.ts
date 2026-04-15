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

type FlattenedRow = {
  id: string;
  externalId: string;
  fullPath: string | null;
  name: string;
};
type WithParentsRow = FlattenedRow & { parentExternalId: string | null };

const LIST_CACHE_TTL_MS = 15 * 60 * 1000;
const flattenedCache = new Map<string, { data: FlattenedRow[]; ts: number }>();
const withParentsCache = new Map<
  string,
  { data: WithParentsRow[]; ts: number }
>();

function invalidateListCaches() {
  flattenedCache.clear();
  withParentsCache.clear();
}

export class CategoryRepository {
  static __invalidateListCachesForTests() {
    invalidateListCaches();
  }

  static async upsertMany(entries: CategoryUpsertEntry[]) {
    const chunkSize = 200;
    let processed = 0;

    const normalizeFullPath = (fp?: string) => {
      if (!fp) return fp;
      return fp
        .split(">")
        .map((p) => p.trim())
        .filter(Boolean)
        .join(" > ");
    };

    for (let i = 0; i < entries.length; i += chunkSize) {
      const slice = entries.slice(i, i + chunkSize);
      await Promise.all(
        slice.map((e) => {
          const normalizedFullPath =
            normalizeFullPath(e.fullPath) ?? e.fullPath ?? "";
          return prisma.marketplaceCategory.upsert({
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
        }),
      );
      processed += slice.length;
      if (processed % 1000 === 0 || processed === entries.length) {
        console.log(
          `[SYNC] Upsert de categorias: ${processed}/${entries.length}`,
        );
      }
    }
    invalidateListCaches();
  }

  static async findByExternalId(externalId: string) {
    return prisma.marketplaceCategory.findUnique({ where: { externalId } });
  }

  static async findById(id: string) {
    return prisma.marketplaceCategory.findUnique({ where: { id } });
  }

  static async listFlattenedOptions(siteId?: string) {
    const key = siteId || "__all__";
    const now = Date.now();
    const cached = flattenedCache.get(key);
    if (cached && now - cached.ts < LIST_CACHE_TTL_MS) {
      return cached.data;
    }
    const where = siteId ? { siteId } : {};
    const data = (await prisma.marketplaceCategory.findMany({
      where,
      select: { id: true, externalId: true, fullPath: true, name: true },
      orderBy: { fullPath: "asc" },
    })) as FlattenedRow[];
    flattenedCache.set(key, { data, ts: now });
    return data;
  }

  static async listWithParents(siteId?: string) {
    const key = siteId || "__all__";
    const now = Date.now();
    const cached = withParentsCache.get(key);
    if (cached && now - cached.ts < LIST_CACHE_TTL_MS) {
      return cached.data;
    }
    const where = siteId ? { siteId } : {};
    const data = (await prisma.marketplaceCategory.findMany({
      where,
      select: {
        id: true,
        externalId: true,
        fullPath: true,
        name: true,
        parentExternalId: true,
      },
      orderBy: { fullPath: "asc" },
    })) as WithParentsRow[];
    withParentsCache.set(key, { data, ts: now });
    return data;
  }

  static async findChildren(parentExternalId: string) {
    return prisma.marketplaceCategory.findMany({
      where: { parentExternalId },
      select: { id: true, externalId: true, fullPath: true, name: true },
      orderBy: { fullPath: "asc" },
    });
  }

  static async findByFullPath(fullPath: string) {
    return prisma.marketplaceCategory.findFirst({ where: { fullPath } });
  }
}

export default CategoryRepository;
