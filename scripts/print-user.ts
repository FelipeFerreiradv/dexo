import prisma from "../app/lib/prisma";

(async () => {
  const u = await prisma.user.findFirst();
  console.log("user", u);
  process.exit(0);
})();
