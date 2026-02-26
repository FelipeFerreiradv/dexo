const prisma = require("../app/lib/prisma").default;
(async () => {
  const u = await prisma.user.findFirst();
  console.log("user", u);
  process.exit(0);
})();
