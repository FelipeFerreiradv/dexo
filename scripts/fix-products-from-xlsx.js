// Helper script (CommonJS) to upsert products from the XLSX source and fix names.
// Run with: node scripts/fix-products-from-xlsx.js

require("dotenv/config");
const path = require("node:path");
const crypto = require("node:crypto");
const { PrismaClient, Prisma } = require("@prisma/client");
const XLSX = require("xlsx");

const prisma = new PrismaClient();

const DEFAULT_USER_ID = "cml7fm1v80000vsd8x0sbzf2o";
const DEFAULT_XLSX =
  "C:/Users/Casa/Downloads/69bfee21-25e9-4994-9876-4448d7babf54.xlsx";

const userId = process.env.PRODUCT_USER_ID || DEFAULT_USER_ID;
const inputPath = path.resolve(process.env.PRODUCTS_XLSX || DEFAULT_XLSX);
const BATCH = Number(process.env.PRODUCT_UPSERT_BATCH || 100);

const normalizeKey = (key) =>
  key
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const toStringValue = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === "" ? null : str;
};

const toMoney = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return new Prisma.Decimal(num.toFixed(2));
};

const toInt = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
};

const toWeightKg = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return new Prisma.Decimal((num / 1000).toFixed(3));
};

const buildDescription = (get) => {
  const parts = [];
  const info = toStringValue(get("informacoes complementares"));
  const mercadoLivre = toStringValue(get("mercado livre"));
  const codigoMlb = toStringValue(get("codigo mlb"));
  const ncm = toStringValue(get("ncm"));
  const unidade = toStringValue(get("unidade"));
  const sigla = toStringValue(get("sigla"));
  const placa = toStringValue(get("placa"));
  const lote = toStringValue(get("lote"));

  if (info) parts.push(info);
  if (mercadoLivre) parts.push(`Mercado Livre: ${mercadoLivre}`);
  if (codigoMlb) parts.push(`Código MLB: ${codigoMlb}`);
  if (ncm) parts.push(`NCM: ${ncm}`);
  if (unidade) parts.push(`Unidade: ${unidade}`);
  if (sigla) parts.push(`Sigla: ${sigla}`);
  if (placa) parts.push(`Placa: ${placa}`);
  if (lote) parts.push(`Lote: ${lote}`);

  return parts.length ? parts.join(" | ") : null;
};

async function main() {
  console.log(`Lendo planilha de ${inputPath}...`);
const workbook = XLSX.readFile(inputPath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });
console.log(`Total de linhas: ${rawRows.length}`);

const existing = await prisma.product.findMany({
  select: { sku: true, id: true },
});
const idMap = new Map(existing.map((p) => [p.sku, p.id]));

  const seen = new Set();
  const data = [];

  for (const raw of rawRows) {
    const normMap = new Map();
    for (const [k, v] of Object.entries(raw)) {
      normMap.set(normalizeKey(k), v);
    }
    const get = (...keys) => {
      for (const key of keys) {
        const norm = normalizeKey(key);
        if (normMap.has(norm)) return normMap.get(norm);
      }
      return null;
    };

    const sku = toStringValue(get("codigo"));
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);

    const name = toStringValue(get("produto"));
    const price = toMoney(get("valor venda (r$)") ?? get("valor venda"));
    if (!price) continue;

    const entry = {
      id: idMap.get(sku) || crypto.randomUUID(),
      userId,
      sku,
      name: name ?? `Produto ${sku}`,
      price,
      stock: toInt(get("estoque")) ?? 0,
      costPrice: toMoney(get("custo (r$)") ?? get("custo")),
      brand: toStringValue(get("marca")),
      model: toStringValue(get("modelo")),
      year: toStringValue(get("ano")),
      location: toStringValue(get("localizacao") ?? get("localização")),
      partNumber: toStringValue(get("partnumber") ?? get("part number")),
      weightKg: toWeightKg(get("peso")),
      lengthCm: toInt(get("comprimento")),
      widthCm: toInt(get("largura")),
      heightCm: toInt(get("altura")),
      description: buildDescription(get),
    };

    data.push(entry);
  }

  console.log(`Preparados ${data.length} produtos para upsert (batch ${BATCH}).`);

  const COLUMNS = [
    "id",
    "sku",
    "name",
    "price",
    "stock",
    "costPrice",
    "brand",
    "model",
    "year",
    "location",
    "partNumber",
    "weightKg",
    "lengthCm",
    "widthCm",
    "heightCm",
    "description",
    "updatedAt",
    "userId",
  ];
  const colSql = COLUMNS.map((c) => `"${c}"`).join(", ");
  const updateSql = COLUMNS.filter((c) => c !== "sku" && c !== "id")
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");

  for (let i = 0; i < data.length; i += BATCH) {
    const slice = data.slice(i, i + BATCH);
    const params = [];
    const placeholders = slice.map((item, idx) => {
      const base = idx * COLUMNS.length;
      params.push(
        item.id,
        item.sku,
        item.name,
        item.price ? Number(item.price) : null,
        item.stock ?? 0,
        item.costPrice ? Number(item.costPrice) : null,
        item.brand ?? null,
        item.model ?? null,
        item.year ?? null,
        item.location ?? null,
        item.partNumber ?? null,
        item.weightKg ? Number(item.weightKg) : null,
        item.lengthCm ?? null,
        item.widthCm ?? null,
        item.heightCm ?? null,
        item.description ?? null,
        new Date(),
        item.userId ?? userId,
      );
      return `(${COLUMNS.map((_, j) => `$${base + j + 1}`).join(", ")})`;
    });

    const sql = `INSERT INTO "Product" (${colSql}) VALUES ${placeholders.join(
      ", ",
    )} ON CONFLICT ("sku") DO UPDATE SET ${updateSql};`;

    await prisma.$executeRawUnsafe(sql, ...params);
    console.log(`Upsert ${Math.min(i + slice.length, data.length)}/${data.length}`);
  }

  console.log("Concluído.");
}

main()
  .catch((err) => {
    console.error("Falhou:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
