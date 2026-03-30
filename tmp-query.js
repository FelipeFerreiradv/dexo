require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  try {
    const products = await prisma.product.findMany({ select: { sku: true, name: true, userId: true } });
    console.log('Total products:', products.length);
    console.log('Sample:', products.slice(0,5));
  } catch (e) { console.error(e); }
  finally { await prisma.$disconnect(); }
})();
