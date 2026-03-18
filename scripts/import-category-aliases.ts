/* eslint-disable no-console */
import "dotenv/config";
import path from "node:path";
import XLSX from "xlsx";
import CategoryRepository from "@/app/marketplaces/repositories/category.repository";
import { CategoryAliasRepository } from "@/app/marketplaces/repositories/category-alias.repository";

const DEFAULT_XLSX =
  "C:/Users/Casa/Downloads/categorizacao_mercado_livre_sugerida.xlsx";

const normalize = (s?: string | number | null) =>
  (s ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const tokenize = (text: string) =>
  normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const toInt = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

async function main() {
  const input = path.resolve(
    process.env.CATEGORY_ALIAS_XLSX || DEFAULT_XLSX,
  );
  console.log(`Lendo planilha: ${input}`);

  const workbook = XLSX.readFile(input);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  console.log(`Total de linhas: ${rows.length}`);

  const categories = await CategoryRepository.listFlattenedOptions("MLB");
  const byFullPath = new Map(
    categories.map((c: any) => [normalize(c.fullPath || c.name), c]),
  );

  const aliasEntries: {
    marketplaceCategoryId: string;
    tokens?: string[];
    synonyms?: string[];
    brandModelPatterns?: Record<string, any>;
  }[] = [];

  for (const row of rows) {
    const productName = row["Produto"] as string;
    const fullPath = row["Categoria_Oficial_ML_Sugerida"] as string;
    if (!productName || !fullPath) continue;

    const cat = byFullPath.get(normalize(fullPath));
    if (!cat) {
      console.warn(
        `[WARN] Categoria não encontrada no banco: ${fullPath} — execute sync-ml-categories.ts primeiro.`,
      );
      continue;
    }

    const brand = row["Marca"] ? String(row["Marca"]).trim() : undefined;
    const model = row["Modelo"] ? String(row["Modelo"]).trim() : undefined;
    const year =
      row["Ano"] && String(row["Ano"]).length >= 4
        ? String(row["Ano"]).trim()
        : undefined;
    const partNumber = row["PartNumber"]
      ? String(row["PartNumber"]).trim()
      : undefined;

    const measurements = {
      heightCm: toInt(row["Altura"]),
      widthCm: toInt(row["Largura"]),
      lengthCm: toInt(row["Comprimento"]),
      weightKg: row["Peso"]
        ? Number(row["Peso"]) > 100
          ? Number(row["Peso"]) / 1000
          : Number(row["Peso"])
        : undefined,
    };

    const tokens = Array.from(
      new Set([
        ...tokenize(productName),
        ...tokenize(row["Grupo_Categoria"] || ""),
        ...tokenize(row["Regra_Aplicada"] || ""),
        ...(brand ? [normalize(brand)] : []),
        ...(model ? [normalize(model)] : []),
        ...(year ? [normalize(year)] : []),
      ]),
    );

    const synonyms = Array.from(
      new Set([
        ...tokenize(row["Grupo_Categoria"] || ""),
        ...tokenize(row["Regra_Aplicada"] || ""),
      ]),
    );

    aliasEntries.push({
      marketplaceCategoryId: cat.id,
      tokens,
      synonyms,
      brandModelPatterns: {
        brand,
        model,
        years: year ? [year] : [],
        partNumber,
        measurements,
        sampleTitle: productName,
      },
    });
  }

  console.log(
    `Preparando ${aliasEntries.length} aliases — sobrescrevendo aliases existentes do site.`,
  );
  await CategoryAliasRepository.replaceForSite("MLB", aliasEntries);

  console.log("Finalizado. Total de aliases gravados:", aliasEntries.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
