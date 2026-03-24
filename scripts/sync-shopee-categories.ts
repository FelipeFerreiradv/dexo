import "dotenv/config";
import prisma from "@/app/lib/prisma";
import { Platform } from "@prisma/client";
import { ShopeeApiService } from "@/app/marketplaces/services/shopee-api.service";
import CategoryRepository from "@/app/marketplaces/repositories/category.repository";

async function run() {
  // 1. Buscar conta Shopee ativa
  const account = await prisma.marketplaceAccount.findFirst({
    where: { platform: Platform.SHOPEE, status: "ACTIVE" },
  });

  if (!account || !account.accessToken || !account.shopId) {
    console.error("Nenhuma conta Shopee ativa encontrada.");
    process.exit(1);
  }

  const shopId =
    typeof account.shopId === "string"
      ? parseInt(account.shopId)
      : (account.shopId as number);

  console.log(
    `Usando conta: ${account.accountName || account.id} (shopId=${shopId})`,
  );

  // 2. Buscar categorias da API do Shopee
  console.log("Buscando categorias da API do Shopee...");
  const categoryResponse = await ShopeeApiService.getCategories(
    account.accessToken,
    shopId,
    "pt-BR",
  );

  const categoryList = (categoryResponse.category_list || []) as any[];
  console.log(`${categoryList.length} categorias retornadas pela API.`);

  if (categoryList.length === 0) {
    console.warn("Nenhuma categoria retornada. Verifique o token.");
    process.exit(1);
  }

  // Debug: mostrar campos da primeira categoria para identificar o nome correto
  if (categoryList[0]) {
    console.log("Campos da 1ª categoria:", Object.keys(categoryList[0]));
    console.log("Amostra:", JSON.stringify(categoryList[0], null, 2));
  }

  // A API v2 do Shopee pode usar display_category_name ou original_category_name
  const getName = (cat: any): string =>
    cat.display_category_name ||
    cat.category_name ||
    cat.original_category_name ||
    `Cat_${cat.category_id}`;

  // 3. Construir mapa de nomes para fullPath
  const nameMap = new Map<number, string>();
  for (const cat of categoryList) {
    nameMap.set(cat.category_id, getName(cat));
  }

  const buildFullPath = (cat: any): string => {
    const parts: string[] = [];
    let currentParentId = cat.parent_category_id;
    parts.unshift(getName(cat));
    while (currentParentId && currentParentId > 0) {
      const parentName = nameMap.get(currentParentId);
      if (parentName) {
        parts.unshift(parentName);
      }
      const parentCat = categoryList.find(
        (c: any) => c.category_id === currentParentId,
      );
      currentParentId = parentCat?.parent_category_id ?? 0;
    }
    return parts.join(" > ");
  };

  // 4. Montar entries para upsert
  const entries = categoryList.map((cat: any) => ({
    externalId: `SHP_${cat.category_id}`,
    siteId: "SHP",
    name: getName(cat),
    fullPath: buildFullPath(cat),
    pathFromRoot: [cat.parent_category_id, cat.category_id],
    parentExternalId:
      cat.parent_category_id > 0 ? `SHP_${cat.parent_category_id}` : null,
    keywords: null,
  }));

  // 5. Upsert no banco
  console.log(`Salvando ${entries.length} categorias no banco (siteId=SHP)...`);
  await CategoryRepository.upsertMany(entries);

  console.log(`✅ ${entries.length} categorias do Shopee sincronizadas.`);
}

run()
  .catch((err) => {
    console.error("Erro:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
