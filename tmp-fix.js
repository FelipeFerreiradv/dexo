const {PrismaClient}=require('@prisma/client');
(async()=>{
  const prisma=new PrismaClient();
  const prod=await prisma.product.findFirst({where:{name:{contains:'Tampa Reservatorio Partida frio Volkswagen Fox 2001'}}});
  const cat=await prisma.marketplaceCategory.findUnique({where:{externalId:'MLB194016'}});
  if(prod && cat){
    await prisma.product.update({where:{id:prod.id},data:{mlCategoryId:cat.id,mlCategorySource:'auto',mlCategoryChosenAt:new Date(),category:cat.fullPath}});
    console.log('updated',prod.id);
  } else {
    console.log('prod or cat missing');
  }
  await prisma["$disconnect"]();
})();
