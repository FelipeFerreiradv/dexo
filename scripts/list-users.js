const prisma=require('../app/lib/prisma').default;
(async()=>{
  const users=await prisma.user.findMany({take:5});
  console.log(users);
  process.exit(0);
})();