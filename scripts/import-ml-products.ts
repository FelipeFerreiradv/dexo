import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import { normalizeSku as buildSkuNormalized } from "../app/lib/sku";

type RawRow = {
  sourceFile: string;
  rowNumber: number;
  sku: string;
  title: string;
  price: number;
  quantity: number;
  description?: string;
  status: string;
  reason?: string;
  productId?: string;
  existingProductId?: string;
  existingUserId?: string | null;
};

const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const INPUT_FILES = [
  path.resolve("C:/Users/Casa/Downloads/Anuncios-2026_03_28-23_52.xlsx"),
  path.resolve("C:/Users/Casa/Downloads/Anuncios-2026_03_28-22_26.xlsx"),
];
const OUTPUT_DIR = path.resolve("scripts/out");
const OUTPUT_CSV = path.join(
  OUTPUT_DIR,
  `ml-products-report-${new Date().toISOString().slice(0, 10)}.csv`,
);

const prisma = new PrismaClient();

const normalizeSku = (sku: string) => sku.trim().toUpperCase();
const normalizeName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const parseNumber = (value: any): number => {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/\./g, "").replace(/,/g, ".");
    const parsed = Number(cleaned);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
};

const loadRows = (): RawRow[] => {
  const rows: RawRow[] = [];

  for (const file of INPUT_FILES) {
    if (!fs.existsSync(file)) {
      console.warn(`[WARN] File not found, skipping: ${file}`);
      continue;
    }

    const workbook = XLSX.readFile(file);
    const sheet =
      workbook.Sheets["Anúncios"] || workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, {
      defval: null,
    });

    json.forEach((row, idx) => {
      const rawSku = row["SKU"];
      const rawTitle = row["TITLE"];
      const rawPrice = row["PRICE"];
      const rawQty = row["QUANTITY"];

      const sku = typeof rawSku === "string" ? rawSku.trim() : String(rawSku || "").trim();
      const title = typeof rawTitle === "string" ? rawTitle.trim() : "";

      if (!sku || !title) return;

      const price = parseNumber(rawPrice);
      const quantity = parseNumber(rawQty);
      const description =
        typeof row["DESCRIPTION"] === "string" ? row["DESCRIPTION"] : undefined;

      rows.push({
        sourceFile: path.basename(file),
        rowNumber: idx + 2, // +2 to compensate header + 1-based
        sku,
        title,
        price: Number.isNaN(price) ? 0 : price,
        quantity: Number.isNaN(quantity) ? 0 : Math.max(0, Math.trunc(quantity)),
        description,
        status: "pending",
      });
    });
  }

  return rows;
};

const deduplicate = (rows: RawRow[]) => {
  const bySku = new Map<string, RawRow[]>();

  for (const row of rows) {
    const key = normalizeSku(row.sku);
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key)!.push(row);
  }

  const candidates: RawRow[] = [];
  for (const [skuKey, items] of bySku.entries()) {
    const names = new Set(items.map((i) => normalizeName(i.title)));
    if (names.size > 1) {
      for (const item of items) {
        item.status = "descartado por conflito de SKU";
        item.reason = "SKU com nomes diferentes no arquivo";
      }
      continue;
    }

    const sorted = [...items].sort((a, b) => b.price - a.price);
    const winner = sorted[0];
    winner.status = "candidato";
    candidates.push(winner);

    for (const dup of sorted.slice(1)) {
      dup.status = "descartado por duplicidade";
      dup.reason = "Mesmo SKU e nome; preço menor";
    }
  }

  return { candidates, allRows: rows };
};

const writeCsv = (rows: RawRow[]) => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const headers = [
    "source_file",
    "row",
    "title",
    "sku",
    "price",
    "quantity",
    "status",
    "reason",
    "product_id",
    "existing_product_id",
    "existing_user_id",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const values = [
      r.sourceFile,
      r.rowNumber,
      `"${(r.title || "").replace(/"/g, '""')}"`,
      `"${(r.sku || "").replace(/"/g, '""')}"`,
      r.price,
      r.quantity,
      `"${(r.status || "").replace(/"/g, '""')}"`,
      `"${(r.reason || "").replace(/"/g, '""')}"`,
      r.productId ?? "",
      r.existingProductId ?? "",
      r.existingUserId ?? "",
    ];
    lines.push(values.join(","));
  }
  fs.writeFileSync(OUTPUT_CSV, lines.join("\n"), "utf8");
};

const main = async () => {
  const args = process.argv.slice(2);
  const shouldCreate = args.includes("--create");

  const rawRows = loadRows();
  console.log(`[INFO] Loaded ${rawRows.length} rows from Excel files`);

  const { candidates, allRows } = deduplicate(rawRows);
  console.log(
    `[INFO] After dedup: ${candidates.length} candidates, ${
      allRows.filter((r) => r.status.startsWith("descartado")).length
    } discarded`,
  );

  // Invalidate candidates with inconsistent data
  for (const item of candidates) {
    if (item.price <= 0) {
      item.status = "ignorado por inconsistencia";
      item.reason = "Preco invalido (<= 0)";
    }
  }

  const filteredCandidates = candidates.filter(
    (c) => c.status === "pronto para criar" || c.status === "candidato",
  );
  const candidateSkus = filteredCandidates.map((c) => c.sku);
  const existing = await prisma.product.findMany({
    where: { sku: { in: candidateSkus }, userId: USER_ID },
    select: { id: true, sku: true, userId: true, name: true },
  });
  const existingMap = new Map<string, { id: string; userId: string | null; name: string }>(
    existing.map((p) => [normalizeSku(p.sku), { id: p.id, userId: p.userId, name: p.name }]),
  );

  const toCreate: RawRow[] = [];
  for (const item of candidates) {
    const match = existingMap.get(normalizeSku(item.sku));
    if (match) {
      item.status = "ja existia";
      item.reason = `Produto existente (user ${match.userId ?? "N/A"})`;
      item.existingProductId = match.id;
      item.existingUserId = match.userId;
    } else {
      item.status = "pronto para criar";
      toCreate.push(item);
    }
  }

  console.log(
    `[INFO] Existing in DB: ${candidates.length - toCreate.length}, to create: ${toCreate.length}`,
  );

  if (shouldCreate && toCreate.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < toCreate.length; i += BATCH) {
      const batch = toCreate.slice(i, i + BATCH);
      try {
        const created = await prisma.product.createMany({
          data: batch.map((item) => ({
            userId: USER_ID,
            sku: item.sku.trim(),
            skuNormalized: buildSkuNormalized(item.sku),
            name: item.title.trim(),
            price: new Prisma.Decimal(item.price),
            stock: item.quantity,
            description: item.description || null,
            mlCategorySource: "imported",
            mlCategoryChosenAt: new Date(),
          })),
          skipDuplicates: true,
        });
        batch.forEach((item) => {
          item.status = "criado";
          item.reason = `Batch insert OK (${created.count} inseridos, skipDuplicates=true)`;
        });
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        batch.forEach((item) => {
          item.status = "erro ao criar";
          item.reason = message;
        });
        console.error(`[ERROR] Failed batch ${i / BATCH + 1}: ${message}`);
      }
    }

    // Pós-verificação: confirmar que todos os candidatos agora existem
    const postCheck = await prisma.product.findMany({
      where: { sku: { in: toCreate.map((c) => c.sku) } },
      select: { id: true, sku: true },
    });
    const postMap = new Map(postCheck.map((p) => [normalizeSku(p.sku), p.id]));
    for (const item of toCreate) {
      if (postMap.has(normalizeSku(item.sku))) {
        item.productId = postMap.get(normalizeSku(item.sku));
      } else if (item.status === "criado") {
        item.status = "erro ao criar";
        item.reason = "Não encontrado após createMany";
      }
    }
  }

  writeCsv(allRows);

  const summary = allRows.reduce(
    (acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log("[SUMMARY]", summary);
  console.log(`[INFO] Report saved to ${OUTPUT_CSV}`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
