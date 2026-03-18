import prisma from "@/app/lib/prisma";

export interface CategoryAliasInput {
  marketplaceCategoryId: string;
  tokens?: string[];
  synonyms?: string[];
  brandModelPatterns?: Record<string, any> | null;
}

export class CategoryAliasRepository {
  static async replaceForSite(
    siteId: string,
    aliases: CategoryAliasInput[],
  ): Promise<void> {
    // Limpa aliases antigos para o site antes de inserir novos
    await prisma.categoryAlias.deleteMany({
      where: { marketplaceCategory: { siteId } },
    });

    if (!aliases || aliases.length === 0) return;

    await prisma.categoryAlias.createMany({
      data: aliases.map((a) => ({
        marketplaceCategoryId: a.marketplaceCategoryId,
        tokens: a.tokens?.filter(Boolean).join(",") || null,
        synonyms: a.synonyms?.filter(Boolean).join(",") || null,
        brandModelPatterns: a.brandModelPatterns
          ? JSON.stringify(a.brandModelPatterns)
          : null,
      })),
      skipDuplicates: false,
    });
  }

  static async listWithCategory(siteId?: string) {
    return prisma.categoryAlias.findMany({
      where: siteId ? { marketplaceCategory: { siteId } } : {},
      include: {
        marketplaceCategory: {
          select: {
            id: true,
            externalId: true,
            fullPath: true,
            name: true,
            parentExternalId: true,
            siteId: true,
          },
        },
      },
    });
  }
}

export default CategoryAliasRepository;
