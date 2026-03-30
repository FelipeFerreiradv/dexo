const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();
(async () => {
  const csvPath = path.resolve('scripts/out/ml-products-report-2026-03-30.csv');
  const content = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1);
  const statuses = {};
  for (const line of content) {
    const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const status = (cols[6] || '').replace(/^"|"$/g, '');
    statuses[status] = (statuses[status] || 0) + 1;
  }
  const userId = 'cmn5yc4rn0000vsasmwv9m8nc';
  const totalUser = await prisma.product.count({ where: { userId } });
  const totalAll = await prisma.product.count();
  const noUser = await prisma.product.count({ where: { userId: null } });

  const sampleSkus = content.slice(0, 2000).map((line) => {
    const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    return (cols[3] || '').replace(/^"|"$/g, '');
  });
  const othersSample = await prisma.product.count({
    where: { sku: { in: sampleSkus }, NOT: { userId } },
  });

  console.log({ statuses, totalUser, totalAll, noUser, othersSample });
  await prisma.$disconnect();
})();
