import "../lib/load-env";
/** Sonda descartavel: as orfas "sem log" sao ruido de updatedAt? Read-only. */
import { prisma, section, sub, printTable, withPrisma } from "./shared";

const OWNER = "cmrpbpswr0e6i18ncc97fv4ec";
const DE = new Date("2026-09-07T00:00:00-03:00");

async function main() {
  const orfas = await prisma.product.findMany({
    where: { userId: OWNER, locationId: null, updatedAt: { gte: DE } },
    select: { id: true, sku: true, stock: true, createdAt: true, updatedAt: true },
  });
  section("ORFAS COM ULTIMA ESCRITA NA JANELA");
  sub("total", orfas.length);
  sub("com estoque 0", orfas.filter((o) => o.stock === 0).length);

  const ids = orfas.map((o) => o.id);
  const logs = await prisma.stockLog.groupBy({
    by: ["productId"],
    where: { productId: { in: ids }, createdAt: { gte: DE } },
    _count: { _all: true },
  });
  const comVenda = new Set(logs.map((l) => l.productId));
  sub("com StockLog na janela (venda/baixa explica o updatedAt)", comVenda.size);
  sub("SEM StockLog na janela", orfas.length - comVenda.size);

  const semLog = orfas.filter((o) => !comVenda.has(o.id));
  sub("desses, criados ANTES da janela (ja existiam)", semLog.filter((o) => o.createdAt < DE).length);
  printTable(
    semLog.slice(0, 10).map((o) => ({
      sku: o.sku, estoque: o.stock,
      criado: o.createdAt.toISOString().slice(0, 10),
      atualizado: o.updatedAt.toISOString().slice(0, 16),
    })),
    10,
  );

  section("H3 HOJE: CAIXAS DA MK2 COM MAIS DE 50 PECAS");
  const porCaixa = await prisma.product.groupBy({
    by: ["locationId"],
    where: { userId: OWNER, locationId: { not: null } },
    _count: { _all: true },
  });
  const acima = porCaixa.filter((c) => c._count._all > 50);
  sub("caixas com peca vinculada", porCaixa.length);
  sub("caixas com MAIS de 50 pecas", acima.length);
  sub("pecas vinculadas no total", porCaixa.reduce((a, c) => a + c._count._all, 0));
  sub(
    "pecas INALCANCAVEIS pela gaveta (alem das 50 primeiras)",
    acima.reduce((a, c) => a + (c._count._all - 50), 0),
  );
  const locs = await prisma.location.findMany({
    where: { userId: OWNER, id: { in: acima.map((a) => a.locationId!) } },
    select: { id: true, code: true },
  });
  const nome = new Map(locs.map((l) => [l.id, l.code]));
  printTable(
    acima
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 12)
      .map((c) => ({
        caixa: nome.get(c.locationId!) ?? c.locationId,
        pecas: c._count._all,
        invisiveis: c._count._all - 50,
      })),
    12,
  );
}

if (require.main === module) {
  withPrisma(main)
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(2); });
}
