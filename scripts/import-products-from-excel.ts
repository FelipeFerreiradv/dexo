import 'dotenv/config';
import path from 'path';
import XLSX from 'xlsx';
import { Prisma, PrismaClient, Quality } from '@prisma/client';

const prisma = new PrismaClient();

type RawRow = Record<string, unknown>;

const FILE_PATH =
  process.env.PRODUCTS_XLSX ??
  path.resolve(
    'C:/Users/Casa/Downloads/Anuncios-2026_03_27-14_37 (1).xlsx',
  );

const TARGET_USER_ID =
  process.env.PRODUCTS_USER_ID ?? 'cmn5yc4rn0000vsasmwv9m8nc';

const DRY_RUN = process.argv.includes('--dry-run');

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str.length === 0 ? undefined : str;
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toQuality(condition: unknown): Quality | undefined {
  const text = asString(condition)?.toLowerCase();
  if (!text) return undefined;
  if (text.includes('novo') || text === 'new') return Quality.NOVO;
  if (text.includes('usado') || text === 'used') return Quality.SEMINOVO;
  if (text.includes('recond')) return Quality.RECONDICIONADO;
  if (text.includes('sucata')) return Quality.SUCATA;
  return undefined;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = value;
    }
  }
  return result;
}

function getSheet(workbook: XLSX.WorkBook): XLSX.WorkSheet {
  const preferred = workbook.SheetNames.find((name) =>
    name.toLowerCase().includes('an'),
  );
  if (!preferred) {
    throw new Error('Sheet containing products was not found.');
  }
  const sheet = workbook.Sheets[preferred];
  if (!sheet) {
    throw new Error(`Sheet '${preferred}' not found in workbook.`);
  }
  return sheet;
}

async function main() {
  console.log(`Reading workbook: ${FILE_PATH}`);
  const workbook = XLSX.readFile(FILE_PATH);
  const sheet = getSheet(workbook);
  const rows: RawRow[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const productsMap = new Map<
    string,
    {
      sku: string;
      name: string;
      description?: string;
      price: Prisma.Decimal;
      stock: number;
      category?: string;
      quality?: Quality;
    }
  >();

  for (const row of rows) {
    const sku = asString(row['SKU']);
    if (!sku) continue;
    if (sku.toLowerCase() === 'sku') continue; // header row safeguard

    const name = asString(row['TITLE']) ?? sku;
    const price = new Prisma.Decimal(asNumber(row['PRICE']) ?? 0);
    const stock = Math.max(0, Math.floor(asNumber(row['QUANTITY']) ?? 0));

    const description = asString(row['DESCRIPTION']);
    const category = asString(row['CATEGORY']);
    const quality = toQuality(row['CONDITION']);

    if (!productsMap.has(sku)) {
      productsMap.set(sku, {
        sku,
        name,
        description,
        price,
        stock,
        category,
        quality,
      });
    }
  }

  const products = Array.from(productsMap.values());
  console.log(`Parsed ${products.length} unique SKUs from sheet.`);

  const existingMap = new Map<string, string | null>();
  const skuChunks = chunk(
    products.map((p) => p.sku),
    1000,
  );

  for (const part of skuChunks) {
    const existing = await prisma.product.findMany({
      where: { sku: { in: part } },
      select: { sku: true, userId: true },
    });
    existing.forEach((item) => existingMap.set(item.sku, item.userId));
  }

  const toCreate: typeof products = [];
  const toUpdate: typeof products = [];
  const toReassign: typeof products = [];

  for (const product of products) {
    const owner = existingMap.get(product.sku);
    if (!owner) {
      toCreate.push(product);
    } else if (owner === TARGET_USER_ID) {
      toUpdate.push(product);
    } else {
      toReassign.push(product);
    }
  }

  console.log(
    `Will create ${toCreate.length}, update ${toUpdate.length}, reassign ${toReassign.length} (from other users).`,
  );

  if (DRY_RUN) {
    console.log('Dry run enabled. No changes were made.');
    await prisma.$disconnect();
    return;
  }

  for (const part of chunk(toCreate, 200)) {
    await prisma.product.createMany({
      data: part.map((data) => ({
        sku: data.sku,
        name: data.name,
        description: data.description,
        price: data.price,
        stock: data.stock,
        category: data.category,
        quality: data.quality,
        userId: TARGET_USER_ID,
      })),
      skipDuplicates: true,
    });
  }

  for (const part of chunk(toUpdate, 100)) {
    await prisma.$transaction(
      part.map((data) =>
        prisma.product.update({
          where: { sku: data.sku },
          data: compact({
            name: data.name,
            description: data.description,
            price: data.price,
            stock: data.stock,
            category: data.category,
            quality: data.quality,
            userId: TARGET_USER_ID,
          }),
        }),
      ),
    );
  }

  for (const part of chunk(toReassign, 100)) {
    await prisma.$transaction(
      part.map((data) =>
        prisma.product.update({
          where: { sku: data.sku },
          data: compact({
            userId: TARGET_USER_ID,
            name: data.name,
            description: data.description,
            price: data.price,
            stock: data.stock,
            category: data.category,
            quality: data.quality,
          }),
        }),
      ),
    );
  }

  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
