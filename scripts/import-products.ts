import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";

type RawRow = Record<string, unknown>;

const prisma = new PrismaClient();

const DEFAULT_USER_ID = "cml7fm1v80000vsd8x0sbzf2o";
const DEFAULT_XLSX =
  "C:/Users/Casa/Downloads/69bfee21-25e9-4994-9876-4448d7babf54.xlsx";

const arg = (name: string) => {
  const prefix = `--${name}=`;
  const match = process.argv.find((v) => v.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
};

const userId =
  arg("user") ?? process.env.PRODUCT_USER_ID ?? DEFAULT_USER_ID;
const inputPath = path.resolve(
  arg("file") ?? process.env.PRODUCTS_XLSX ?? DEFAULT_XLSX,
);
const batchSize = Number(arg("batch") ?? 500);
const mode =
  (arg("mode") ?? process.env.PRODUCT_IMPORT_MODE ?? "upsert").toLowerCase();

if (!fs.existsSync(inputPath)) {
  console.error(`❌ Planilha não encontrada em ${inputPath}`);
  process.exit(1);
}

const toStringValue = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === "" ? null : str;
};

const toMoney = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return new Prisma.Decimal(num.toFixed(2));
};

const toInteger = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
};

const toWeightKg = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  // A planilha traz peso em gramas; converter para quilogramas com três casas.
  const kg = num / 1000;
  return new Prisma.Decimal(kg.toFixed(3));
};

const toUrl = (value: unknown) => {
  const str = toStringValue(value);
  if (!str) return null;
  if (str.startsWith("http://") || str.startsWith("https://")) return str;
  return null;
};

const toYearString = (value: unknown) => {
  const str = toStringValue(value);
  if (!str) return null;
  // Alguns registros vêm como "2013-2017" ou apenas "2013".
  return str;
};

const buildDescription = (get: (key: string) => unknown) => {
  const parts: string[] = [];

  const info = toStringValue(
    get("Informações Complementares", "Informacoes Complementares"),
  );
  const mercadoLivre = toStringValue(get("Mercado Livre"));
  const codigoMlb = toStringValue(get("Código MLB", "Codigo MLB"));
  const ncm = toStringValue(get("NCM"));
  const unidade = toStringValue(get("Unidade"));
  const sigla = toStringValue(get("Sigla"));
  const placa = toStringValue(get("Placa"));
  const lote = toStringValue(get("Lote"));

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
  const workbook = XLSX.readFile(inputPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows: RawRow[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

  console.log(
    `➡️  Lendo ${rawRows.length} linhas da planilha "${sheetName}" para o usuário ${userId}`,
  );

  const seenSkus = new Set<string>();
  const skippedDuplicates: string[] = [];
  const data: Prisma.ProductCreateManyInput[] = [];

  for (const rawRow of rawRows) {
    // Normalizar chaves removendo espaços extras e acentos
    const normalizedEntries = Object.entries(rawRow).map(([k, v]) => [
      k.trim(),
      v,
    ]);
    const row: RawRow = Object.fromEntries(normalizedEntries);
    const normMap = new Map<string, unknown>();
    for (const [k, v] of normalizedEntries) {
      const normKey = k
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      normMap.set(normKey, v);
    }
    const get = (...keys: string[]) => {
      for (const key of keys) {
        const normKey = key
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .trim();
        if (normMap.has(normKey)) return normMap.get(normKey);
      }
      return null;
    };

    const sku = toStringValue(get("Código", "Codigo"));
    if (!sku) continue;

    if (seenSkus.has(sku)) {
      skippedDuplicates.push(sku);
      continue;
    }
    seenSkus.add(sku);

    const price = toMoney(get("Valor Venda (R$)", "Valor Venda"));
    if (!price) continue;

    const product: Prisma.ProductCreateManyInput = {
      userId,
      sku,
      name: toStringValue(get("Produto")) ?? `Produto ${sku}`,
      price,
      stock: toInteger(get("Estoque")) ?? 0,
      costPrice: toMoney(get("Custo (R$)", "Custo")),
      brand: toStringValue(get("Marca")),
      model: toStringValue(get("Modelo")),
      year: toYearString(get("Ano")),
      location: toStringValue(get("Localização", "Localizacao")),
      partNumber: toStringValue(get("PartNumber", "Part Number")),
      weightKg: toWeightKg(get("Peso")),
      lengthCm: toInteger(get("Comprimento")),
      widthCm: toInteger(get("Largura")),
      heightCm: toInteger(get("Altura")),
      imageUrl: toUrl(get("Foto", "Imagem")),
      description: buildDescription(get),
    };

    data.push(product);
  }

  console.log(
    `➡️  Preparados ${data.length} produtos (duplicados ignorados: ${skippedDuplicates.length})`,
  );

  if (mode === "create") {
    let inserted = 0;
    for (let i = 0; i < data.length; i += batchSize) {
      const slice = data.slice(i, i + batchSize);
      const result = await prisma.product.createMany({
        data: slice,
        skipDuplicates: true,
      });
      inserted += result.count;
      const batchNumber = Math.floor(i / batchSize) + 1;
      console.log(
        `✅ Lote ${batchNumber}: inseridos ${result.count} produtos (acumulado ${inserted})`,
      );
    }

    console.log(
      `🎯 Finalizado: ${inserted} produtos inseridos/atualizados para o usuário ${userId}`,
    );
    if (skippedDuplicates.length) {
      console.log(
        `ℹ️  ${skippedDuplicates.length} SKUs estavam duplicados na planilha e foram ignorados (exemplo: ${skippedDuplicates.slice(0, 5).join(", ")})`,
      );
    }
    return;
  }

  // Modo upsert: corrige produtos existentes e cria os que faltam
  const upsertBatch = Number(arg("upsertBatch") ?? 50);
  let processed = 0;
  for (let i = 0; i < data.length; i += upsertBatch) {
    const slice = data.slice(i, i + upsertBatch);
    const tx = slice.map((item) => {
      const updateData: Prisma.ProductUpdateInput = {
        user: { connect: { id: userId } },
        name: item.name,
        price: item.price,
        stock: item.stock,
        description: item.description ?? undefined,
        brand: item.brand ?? undefined,
        model: item.model ?? undefined,
        year: item.year ?? undefined,
        location: item.location ?? undefined,
        partNumber: item.partNumber ?? undefined,
        costPrice: item.costPrice ?? undefined,
        weightKg: item.weightKg ?? undefined,
        lengthCm: item.lengthCm ?? undefined,
        widthCm: item.widthCm ?? undefined,
        heightCm: item.heightCm ?? undefined,
      };

      return prisma.product.upsert({
        where: { sku: item.sku },
        create: item,
        update: updateData,
      });
    });

    const result = await prisma.$transaction(tx);
    processed += result.length;
    console.log(
      `✅ Upsert lote ${Math.floor(i / upsertBatch) + 1}: ${result.length} produtos (acumulado ${processed})`,
    );
  }

  console.log(
    `🎯 Finalizado (modo ${mode}): ${processed} produtos criados/atualizados para o usuário ${userId}`,
  );
  if (skippedDuplicates.length) {
    console.log(
      `ℹ️  ${skippedDuplicates.length} SKUs estavam duplicados na planilha e foram ignorados (exemplo: ${skippedDuplicates.slice(0, 5).join(", ")})`,
    );
  }
}

main()
  .catch((err) => {
    console.error("❌ Erro durante a importação:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
