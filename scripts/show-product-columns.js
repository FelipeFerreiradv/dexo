const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT column_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name='Product'
     ORDER BY ordinal_position`,
  );
  console.log(rows);
  await prisma.$disconnect();
})();
