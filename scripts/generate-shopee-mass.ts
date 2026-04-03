
import "dotenv/config";
import axios from "axios";
import qs from "querystring";
import fs from "fs";
import path from "path";
import { PrismaClient, Platform } from "@prisma/client";

/**
 * Gera o CSV completo da Shopee para todos os produtos do usuário alvo.
 * - Busca produtos e listagens no banco (Prisma).
 * - Tenta recuperar fotos via API do Mercado Livre (batch /items?ids=...).
 * - Aplica heurística de categorias Shopee.
 * - Preenche medidas/fiscais padrão.
 * - Salva em shopee_mass_full_final.csv no diretório raiz.
 */

const prisma = new PrismaClient();
const USER_ID = "cmn5yc4rn0000vsasmwv9m8nc";
const OUTPUT = path.resolve("shopee_mass_full_final.csv");
const HEADERS = [
  "ps_category|0|0",
  "ps_product_name|1|0",
  "ps_product_description|1|0",
  "ps_sku_parent_short|0|0",
  "et_title_variation_integration_no|0|0",
  "et_title_variation_1|0|0",
  "et_title_option_for_variation_1|0|0",
  "et_title_image_per_variation|0|3",
  "et_title_variation_2|0|0",
  "et_title_option_for_variation_2|0|0",
  "ps_price|1|1",
  "ps_stock|0|1",
  "ps_sku_short|0|0",
  "ps_new_size_chart|0|1",
  "et_title_size_chart|0|3",
  "ps_gtin_code|0|0",
  "sl_tool_mass_upload_compatibility_title|0|0",
  "ps_item_cover_image|0|3",
  "ps_item_image_1|0|3",
  "ps_item_image_2|0|3",
  "ps_item_image_3|0|3",
  "ps_item_image_4|0|3",
  "ps_item_image_5|0|3",
  "ps_item_image_6|0|3",
  "ps_item_image_7|0|3",
  "ps_item_image_8|0|3",
  "ps_weight|1|1",
  "ps_length|0|1",
  "ps_width|0|1",
  "ps_height|0|1",
  "channel_id.90003|0|0",
  "ps_product_pre_order_dts|0|1",
  "ps_invoice_ncm|0|0",
  "ps_invoice_cfop_same|0|0",
  "ps_invoice_cfop_diff|0|0",
  "ps_invoice_origin|0|0",
  "ps_invoice_csosn|0|0",
  "ps_invoice_cest|0|0",
  "ps_invoice_measure_unit|0|0",
  "ps_pis_cofins_cst_default|0|0",
  "ps_federal_state_taxes_default|0|0",
  "ps_operation_type_default|0|0",
  "ps_ex_tipi_default|0|0",
  "ps_fci_num_default|0|0",
  "ps_recopi_num_default|0|0",
  "ps_additional_info_default|0|0",
  "sl_label_product_is_grouped_item|0|0",
  "sl_label_grouped_item_gtin_sscc|0|0",
  "sl_label_grouped_item_qty|0|0",
  "sl_label_grouped_item_measure_unity|0|0",
  "et_title_reason|0|0",
];

type ProductRow = Record<string, string>;

const ML_CLIENT_ID = process.env.ML_CLIENT_ID!;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET!;

const csvEscape = (val: unknown) => {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const DEFAULTS = {
  weightKg: "1.0",
  lengthCm: "20",
  widthCm: "20",
  heightCm: "10",
  ncm: "87089990",
  cfopSame: "5102",
  cfopDiff: "6102",
  origin: "0",
  csosn: "102",
  cest: "0101230",
  measureUnit: "UN",
  pisCofins: "49",
};

const categoryHeuristic = (name: string, description: string, stored?: string) => {
  if (stored) return stored;
  const text = `${name} ${description}`.toLowerCase();
  const contains = (kw: string | RegExp) =>
    typeof kw === "string" ? text.includes(kw) : kw.test(text);

  if (contains("pneu")) return "102552";
  if (contains("roda")) return "102560";
  if (contains("calota")) return "102529";
  if (contains("estribo")) return "102530";
  if (contains("defletor")) return "102531";
  if (contains("alargador")) return "102532";
  if (contains(/para-?barro|lameir/)) return "102533";
  if (contains(/sensor de estacionamento|sensor de r[eé]|sensor estacionamento/)) return "102535";
  if (contains(/c(a|â)mera de r[eé]|c(a|â)mera/)) return "102535";
  if (contains("antena")) return "102412";
  if (contains(/amplificador|m[oó]dulo/)) return "102409";
  if (contains(/alto[- ]?falante|autofalante|tweeter|corneta/)) return "102410";
  if (contains(/caixa de som|subwoofer/)) return "102595";
  if (contains(/rádio|radio|player|som automotivo|multim(i|í)dia|dvd/)) return "102408";
  if (contains("controle remoto")) return "102413";
  if (contains(/cabo|fio|chicote/)) return "102411";
  if (contains("tapete")) return "102518";
  if (contains("capa banco")) return "102519";
  if (contains(/organizador|porta-copo/)) return "102520";
  if (contains("quebra sol")) return "102521";
  if (contains("capa volante")) return "102522";
  if (contains(/chaveiro|protetor de chave/)) return "102523";
  if (contains("bluetooth")) return "102525";
  if (contains(/camera veicular|dashcam/)) return "102526";
  if (contains("gps")) return "102527";
  if (contains(/carregador|suporte de celular/)) return "102593";
  return "102536";
};

const refreshMlToken = async (refreshToken: string): Promise<string> => {
  const body = qs.stringify({
    grant_type: "refresh_token",
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const resp = await axios.post("https://api.mercadolibre.com/oauth/token", body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return resp.data.access_token as string;
};

const fetchPicturesBatched = async (
  ids: string[],
  accessToken: string
): Promise<Map<string, string[]>> => {
  const result = new Map<string, string[]>();
  const chunkSize = 20;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    const resp = await axios.get("https://api.mercadolibre.com/items", {
      params: { ids: slice.join(","), access_token: accessToken },
    });
    for (const item of resp.data as any[]) {
      if (item.code !== 200 || !item.body) continue;
      const pics = (item.body.pictures || []).map((p: any) => p.url).filter(Boolean);
      result.set(item.body.id, pics);
    }
  }
  return result;
};

const main = async () => {
  console.log(">> Lendo produtos do usuário", USER_ID);
  const products = await prisma.product.findMany({
    where: { userId: USER_ID },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      price: true,
      stock: true,
      imageUrl: true,
      imageUrls: true,
      lengthCm: true,
      widthCm: true,
      heightCm: true,
      weightKg: true,
      shopeeCategoryId: true,
      listings: {
        select: {
          externalListingId: true,
          permalink: true,
          marketplaceAccount: { select: { platform: true, refreshToken: true } },
        },
      },
    },
  });

  const mlListings = products
    .flatMap((p) =>
      p.listings.filter((l) => l.marketplaceAccount.platform === Platform.MERCADO_LIVRE)
    )
    .map((l) => l.externalListingId);
  const uniqueMlIds = Array.from(new Set(mlListings)).filter(Boolean);

  let mlAccessToken: string | null = null;
  const mlRefresh =
    products
      .flatMap((p) => p.listings.map((l) => l.marketplaceAccount.refreshToken).filter(Boolean))
      .find(Boolean) || process.env.ML_REFRESH_TOKEN;

  if (uniqueMlIds.length > 0 && mlRefresh) {
    console.log(`>> Atualizando token ML e buscando fotos para ${uniqueMlIds.length} anúncios`);
    mlAccessToken = await refreshMlToken(mlRefresh as string);
  } else {
    console.log(">> Nenhum refresh token ML encontrado; fotos via ML serão puladas");
  }

  const pictureMap =
    mlAccessToken && uniqueMlIds.length
      ? await fetchPicturesBatched(uniqueMlIds, mlAccessToken)
      : new Map<string, string[]>();

  const ws = fs.createWriteStream(OUTPUT, "utf8");
  ws.write(HEADERS.join(",") + "\n");

  let missingImages = 0;
  let fallbackCategories = 0;
  const sample: any[] = [];

  for (const p of products) {
    const name = (p.name || "").trim().slice(0, 120);
    const description = (p.description || p.name || "").trim();
    const category = categoryHeuristic(name, description, p.shopeeCategoryId || undefined);
    if (!p.shopeeCategoryId) fallbackCategories += 1;

    const images: string[] = [];
    if (p.imageUrls && p.imageUrls.length) images.push(...p.imageUrls);
    if (p.imageUrl) images.push(p.imageUrl);

    const mlListing = p.listings.find(
      (l) => l.marketplaceAccount.platform === Platform.MERCADO_LIVRE
    );
    if (images.length < 8 && mlListing && mlListing.externalListingId) {
      const pics = pictureMap.get(mlListing.externalListingId) || [];
      for (const pic of pics) {
        if (!images.includes(pic)) images.push(pic);
        if (images.length >= 8) break;
      }
    }

    const hasImages = images.length > 0;
    if (!hasImages) missingImages += 1;
    const filledImages = [...images].slice(0, 8);
    while (filledImages.length < 8) filledImages.push("");

    const weight = p.weightKg ? String(p.weightKg) : DEFAULTS.weightKg;
    const length = p.lengthCm ? String(p.lengthCm) : DEFAULTS.lengthCm;
    const width = p.widthCm ? String(p.widthCm) : DEFAULTS.widthCm;
    const height = p.heightCm ? String(p.heightCm) : DEFAULTS.heightCm;

    const price = p.price ? p.price.toString() : "0";
    const stock = p.stock ?? 0;

    const row: ProductRow = {
      "ps_category|0|0": category,
      "ps_product_name|1|0": name,
      "ps_product_description|1|0": description,
      "ps_sku_parent_short|0|0": p.sku,
      "et_title_variation_integration_no|0|0": "",
      "et_title_variation_1|0|0": "",
      "et_title_option_for_variation_1|0|0": "",
      "et_title_image_per_variation|0|3": "",
      "et_title_variation_2|0|0": "",
      "et_title_option_for_variation_2|0|0": "",
      "ps_price|1|1": price,
      "ps_stock|0|1": String(stock),
      "ps_sku_short|0|0": p.sku,
      "ps_new_size_chart|0|1": "",
      "et_title_size_chart|0|3": "",
      "ps_gtin_code|0|0": "",
      "sl_tool_mass_upload_compatibility_title|0|0": "",
      "ps_item_cover_image|0|3": filledImages[0],
      "ps_item_image_1|0|3": filledImages[1],
      "ps_item_image_2|0|3": filledImages[2],
      "ps_item_image_3|0|3": filledImages[3],
      "ps_item_image_4|0|3": filledImages[4],
      "ps_item_image_5|0|3": filledImages[5],
      "ps_item_image_6|0|3": filledImages[6],
      "ps_item_image_7|0|3": filledImages[7],
      "ps_item_image_8|0|3": "",
      "ps_weight|1|1": weight,
      "ps_length|0|1": length,
      "ps_width|0|1": width,
      "ps_height|0|1": height,
      "channel_id.90003|0|0": "",
      "ps_product_pre_order_dts|0|1": "",
      "ps_invoice_ncm|0|0": DEFAULTS.ncm,
      "ps_invoice_cfop_same|0|0": DEFAULTS.cfopSame,
      "ps_invoice_cfop_diff|0|0": DEFAULTS.cfopDiff,
      "ps_invoice_origin|0|0": DEFAULTS.origin,
      "ps_invoice_csosn|0|0": DEFAULTS.csosn,
      "ps_invoice_cest|0|0": DEFAULTS.cest,
      "ps_invoice_measure_unit|0|0": DEFAULTS.measureUnit,
      "ps_pis_cofins_cst_default|0|0": DEFAULTS.pisCofins,
      "ps_federal_state_taxes_default|0|0": "",
      "ps_operation_type_default|0|0": "",
      "ps_ex_tipi_default|0|0": "",
      "ps_fci_num_default|0|0": "",
      "ps_recopi_num_default|0|0": "",
      "ps_additional_info_default|0|0": "",
      "sl_label_product_is_grouped_item|0|0": "",
      "sl_label_grouped_item_gtin_sscc|0|0": "",
      "sl_label_grouped_item_qty|0|0": "",
      "sl_label_grouped_item_measure_unity|0|0": "",
      "et_title_reason|0|0": "",
    };

    const line = HEADERS.map((h) => csvEscape(row[h])).join(",") + "\n";
    ws.write(line);

    if (sample.length < 5) {
      sample.push({
        sku: p.sku,
        name,
        category,
        hasImages,
        images: filledImages.filter(Boolean),
      });
    }
  }

  ws.end();
  await prisma.$disconnect();

  console.log(">> CSV gerado em", OUTPUT);
  console.log(">> Total produtos:", products.length);
  console.log(">> Categorias por heurística (sem shopeeCategoryId):", fallbackCategories);
  console.log(">> SKUs sem nenhuma imagem:", missingImages);
  console.log(">> Amostra:", sample);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
