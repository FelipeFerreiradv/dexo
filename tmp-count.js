const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const userId = 'cmn5yc4rn0000vsasmwv9m8nc';
  const csv = require('fs').readFileSync('scripts/out/ml-products-report-2026-03-30.csv','utf8').trim().split(/\r?\n/).slice(1);
  const skus = csv.map(line => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)[3].replace(/^"|"$/g,''));
  const conflicts = await prisma.product.groupBy({
    by: ['userId'],
    where: { sku: { in: skus }, NOT: { userId } },
    _count: { _all: true },
  });
  const totalNotUser = await prisma.product.count({ where: { sku: { in: skus }, NOT: { userId } } });
  console.log({ totalNotUser, breakdown: conflicts });
  await prisma.$disconnect();
})();
