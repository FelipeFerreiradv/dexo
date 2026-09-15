import "../lib/load-env";
/** Sonda descartavel: tamanho REAL do payload de uma pagina da gaveta. Read-only. */
import { prisma, section, sub, withPrisma } from "./shared";
import { gzipSync } from "zlib";

const OWNER = "cmrpbpswr0e6i18ncc97fv4ec";

async function main() {
  const caixa = await prisma.location.findFirst({
    where: { userId: OWNER, code: "1P2CX102" },
    select: { id: true, code: true },
  });
  if (!caixa) throw new Error("caixa nao achada");

  const pagina = await prisma.product.findMany({
    where: { locationId: caixa.id, userId: OWNER },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 50,
    select: {
      id: true, sku: true, name: true, imageUrl: true,
      stock: true, price: true, location: true,
    },
  });
  const corpo = JSON.stringify({
    products: pagina.map((p) => ({ ...p, price: Number(p.price) })),
    pagination: { page: 1, limit: 50, total: 168, totalPages: 4 },
  });
  const bruto = Buffer.byteLength(corpo, "utf8");
  const comprimido = gzipSync(Buffer.from(corpo, "utf8")).length;

  section("PAYLOAD DE UMA PAGINA DA GAVETA (" + caixa.code + ", 50 itens)");
  sub("bruto (bytes)", bruto);
  sub("gzip (bytes)", comprimido);
  sub("gzip por item (bytes)", Math.round(comprimido / pagina.length));

  section("COMPARACAO COM A ALTERNATIVA DESCARTADA (carregar tudo de uma vez)");
  const todos = await prisma.product.count({
    where: { locationId: caixa.id, userId: OWNER },
  });
  sub("itens na caixa", todos);
  sub(
    "gzip se carregasse TUDO de uma vez (estimado)",
    Math.round((comprimido / pagina.length) * todos),
  );
  sub(
    "gzip do fluxo real (pagina 1 apenas, o caso comum)",
    comprimido,
  );
  const grande = await prisma.location.findFirst({
    where: { userId: OWNER, code: "P1-ACABAMENTODIVERSOS" },
    select: { id: true },
  });
  const nGrande = await prisma.product.count({
    where: { locationId: grande!.id, userId: OWNER },
  });
  sub("itens na maior caixa", nGrande);
  sub(
    "gzip se a maior caixa carregasse TUDO (estimado)",
    Math.round((comprimido / pagina.length) * nGrande),
  );
}

if (require.main === module) {
  withPrisma(main).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(2); });
}
