import prisma from "../app/lib/prisma";
import { Platform } from "@prisma/client";
(async () => {
  const accounts = await prisma.marketplaceAccount.findMany({ where: { userId: "cmn5yc4rn0000vsasmwv9m8nc", platform: Platform.SHOPEE }, select: { id:true, accountName:true, shopId:true, status:true, createdAt:true, updatedAt:true } });
  console.log(accounts);
  await prisma.$disconnect();
})();
