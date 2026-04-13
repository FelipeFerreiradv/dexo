/**
 * Audit: integridade do catálogo de produtos
 *
 * Read-only. Detecta:
 *  - produtos sem SKU
 *  - SKUs duplicados (deveria ser único por usuário)
 *  - produtos sem categoria
 *  - produtos sem localização
 *  - produtos sem compatibilidade
 *  - produtos com dimensões fora do permitido pelo ML (limite padrão)
 *  - produtos com preço <= 0
 *  - produtos sem imagem
 */
import {
  DEFAULT_USER_ID,
  prisma,
  section,
  sub,
  printTable,
  newOutcome,
  logFinding,
  withPrisma,
  type AuditOutcome,
} from "./shared";

const ML_MAX_DIM_CM = Number(process.env.ML_MAX_DIM_CM ?? "150");
const ML_MAX_WEIGHT_KG = Number(process.env.ML_MAX_WEIGHT_KG ?? "30");

export async function auditProductsIntegrity(
  userId = DEFAULT_USER_ID,
): Promise<AuditOutcome> {
  const outcome = newOutcome("products-integrity");
  section(`PRODUCTS INTEGRITY — user ${userId}`);

  const total = await prisma.product.count({ where: { userId } });
  sub("total de produtos", total);

  const noSku = await prisma.product.findMany({
    where: { userId, OR: [{ sku: "" }, { sku: { equals: "" } }] },
    select: { id: true, name: true },
    take: 30,
  });
  sub("produtos sem SKU", noSku.length);
  if (noSku.length > 0) {
    logFinding(outcome, `${noSku.length} produto(s) sem SKU`);
    printTable(noSku);
  }

  const dupSku = await prisma.product.groupBy({
    by: ["sku"],
    where: { userId },
    _count: { _all: true },
    having: { sku: { _count: { gt: 1 } } },
  });
  sub("SKUs duplicados", dupSku.length);
  if (dupSku.length > 0) {
    logFinding(
      outcome,
      `${dupSku.length} SKU(s) duplicado(s) — viola unicidade esperada`,
    );
    printTable(dupSku);
  }

  const noCategory = await prisma.product.count({
    where: { userId, OR: [{ category: null }, { category: "" }] },
  });
  sub("produtos sem category", noCategory);
  if (noCategory > 0) {
    logFinding(outcome, `${noCategory} produto(s) sem categoria`);
  }

  const noMlCategory = await prisma.product.count({
    where: { userId, mlCategoryId: null },
  });
  sub("produtos sem mlCategoryId", noMlCategory);

  const noLocation = await prisma.product.count({
    where: { userId, locationId: null },
  });
  sub("produtos sem locationId", noLocation);

  const withoutCompat = await prisma.product.count({
    where: { userId, compatibilities: { none: {} } },
  });
  sub("produtos sem compatibilidade", withoutCompat);
  if (withoutCompat > 0) {
    logFinding(
      outcome,
      `${withoutCompat} produto(s) sem compatibilidade — pode bloquear publicação ML`,
    );
  }

  const noImage = await prisma.product.count({
    where: {
      userId,
      OR: [{ imageUrl: null }, { imageUrl: "" }],
      imageUrls: { isEmpty: true },
    },
  });
  sub("produtos sem imagem", noImage);
  if (noImage > 0) {
    logFinding(outcome, `${noImage} produto(s) sem imagem`);
  }

  const badPrice = await prisma.product.findMany({
    where: { userId, price: { lte: 0 } },
    select: { id: true, sku: true, price: true },
    take: 30,
  });
  sub("produtos com preço <= 0", badPrice.length);
  if (badPrice.length > 0) {
    logFinding(outcome, `${badPrice.length} produto(s) com preço <= 0`);
    printTable(badPrice);
  }

  const oversize = await prisma.product.findMany({
    where: {
      userId,
      OR: [
        { heightCm: { gt: ML_MAX_DIM_CM } },
        { lengthCm: { gt: ML_MAX_DIM_CM } },
        { widthCm: { gt: ML_MAX_DIM_CM } },
        { weightKg: { gt: ML_MAX_WEIGHT_KG } },
      ],
    },
    select: {
      id: true,
      sku: true,
      heightCm: true,
      lengthCm: true,
      widthCm: true,
      weightKg: true,
    },
    take: 30,
  });
  sub(
    `produtos com dimensões > ${ML_MAX_DIM_CM}cm ou peso > ${ML_MAX_WEIGHT_KG}kg`,
    oversize.length,
  );
  if (oversize.length > 0) {
    logFinding(
      outcome,
      `${oversize.length} produto(s) fora do limite ML — precisam de transportadora específica`,
    );
    printTable(oversize);
  }

  const noDimensions = await prisma.product.count({
    where: {
      userId,
      OR: [
        { heightCm: null },
        { lengthCm: null },
        { widthCm: null },
        { weightKg: null },
      ],
    },
  });
  sub("produtos com dimensões incompletas", noDimensions);
  if (noDimensions > 0) {
    logFinding(
      outcome,
      `${noDimensions} produto(s) com dimensões incompletas — bloqueia publicação`,
    );
  }

  return outcome;
}

if (require.main === module) {
  withPrisma(() => auditProductsIntegrity())
    .then((o) => process.exit(o.findings.length > 0 ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
