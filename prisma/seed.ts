import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // User admin
  const hash = await bcrypt.hash("admin123", 10);
  const user = await prisma.user.upsert({
    where: { email: "admin@dexo.com" },
    update: {},
    create: {
      email: "admin@dexo.com",
      password: hash,
      name: "Admin Dexo",
      role: "ADMIN",
      defaultItemCondition: "used",
      defaultShippingMode: "me2",
      defaultFreeShipping: false,
      defaultHasWarranty: false,
    },
  });
  console.log("User:", user.email);

  // Locations
  const loc1 = await prisma.location.upsert({
    where: { userId_code: { userId: user.id, code: "A1" } },
    update: {},
    create: {
      userId: user.id,
      code: "A1",
      description: "Prateleira A1",
      maxCapacity: 50,
    },
  });
  const loc2 = await prisma.location.upsert({
    where: { userId_code: { userId: user.id, code: "B2" } },
    update: {},
    create: {
      userId: user.id,
      code: "B2",
      description: "Prateleira B2",
      maxCapacity: 30,
    },
  });
  console.log("Locations:", loc1.code, loc2.code);

  // Products
  const products = [
    {
      sku: "AUT-001",
      name: "Motor de Arranque Fiat Palio",
      price: 280,
      costPrice: 120,
      stock: 3,
      brand: "Fiat",
      model: "Palio",
      year: "2010",
      category: "Motor",
      locationId: loc1.id,
    },
    {
      sku: "AUT-002",
      name: "Alternador Volkswagen Gol",
      price: 350,
      costPrice: 180,
      stock: 2,
      brand: "Volkswagen",
      model: "Gol",
      year: "2012",
      category: "Elétrica",
      locationId: loc1.id,
    },
    {
      sku: "AUT-003",
      name: "Caixa de Direção Chevrolet Celta",
      price: 420,
      costPrice: 200,
      stock: 1,
      brand: "Chevrolet",
      model: "Celta",
      year: "2008",
      category: "Direção",
      locationId: loc2.id,
    },
    {
      sku: "AUT-004",
      name: "Bomba de Combustível Ford Ka",
      price: 190,
      costPrice: 80,
      stock: 5,
      brand: "Ford",
      model: "Ka",
      year: "2015",
      category: "Combustível",
      locationId: loc2.id,
    },
    {
      sku: "AUT-005",
      name: "Radiador Honda Civic",
      price: 650,
      costPrice: 300,
      stock: 1,
      brand: "Honda",
      model: "Civic",
      year: "2014",
      category: "Arrefecimento",
      locationId: loc1.id,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { userId_sku: { userId: user.id, sku: p.sku } },
      update: {},
      create: { ...p, userId: user.id, quality: "SEMINOVO" },
    });
  }
  console.log("Products:", products.length, "created");

  // Customers
  const customers = [
    {
      name: "Carlos Silva",
      email: "carlos@email.com",
      phone: "11999990001",
      cpf: "123.456.789-00",
      city: "São Paulo",
      state: "SP",
    },
    {
      name: "Ana Oliveira",
      email: "ana@email.com",
      phone: "21999990002",
      cpf: "987.654.321-00",
      city: "Rio de Janeiro",
      state: "RJ",
    },
    {
      name: "Pedro Santos",
      email: "pedro@email.com",
      phone: "31999990003",
      cpf: "456.789.123-00",
      city: "Belo Horizonte",
      state: "MG",
    },
  ];

  for (const c of customers) {
    await prisma.customer
      .create({ data: { ...c, userId: user.id } })
      .catch(() => {});
  }
  console.log("Customers:", customers.length, "created");

  console.log("\n✓ Seed completo! Login: admin@dexo.com / admin123");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
