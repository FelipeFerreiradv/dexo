/**
 * PACOTE COMPLETO do IBR Soft — uma request com os CSVs do export importa
 * TODAS as entidades na ordem de dependência, com os mapas em memória:
 *   clientes → localizações → sucatas → produtos (cria+vincula loc/sucata)
 *   → contas (pagar/receber) → NF-e histórica.
 *
 * Reusa 100% dos executores validados (customers/locations/scraps/finance/
 * nfe). O único caminho próprio é o de produtos, que combina criar-faltantes
 * + vínculo de localização + vínculo de sucata por placa/lote.
 *
 * Anti-duplicação: casamento por skuNormalized (+ preload dos legados sem
 * skuNormalized) e unique (userId, sku); markers de idempotência em todas as
 * entidades. Reimportar não duplica; a prévia (dryRun) não escreve nada.
 */

import prisma from "../../../lib/prisma";
import { normalizeSku } from "../../../lib/sku";
import { LocationUseCase } from "../../location.usercase";
import { ProductUseCase } from "../../product.usercase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "../import.types";
import { chunk } from "../lib/normalize";
import { fileOfKind } from "../import-detector";
import {
  executeCustomersPlan,
  defaultCustomersDeps,
  type CustomersExecDeps,
} from "./customers.executor";
import {
  executeLocationPlan,
  defaultLocationDeps,
  type LocationExecDeps,
} from "./locations.executor";
import {
  executeScrapsPlan,
  defaultScrapsDeps,
  type ScrapsExecDeps,
} from "./scraps.executor";
import {
  executeFinancePlan,
  defaultFinanceDeps,
  type FinanceExecDeps,
} from "./finance.executor";
import {
  executeNfeHistoricPlan,
  defaultNfeImportDeps,
  type NfeImportDeps,
} from "../nfe-import.usecase";
import {
  mapIbrsoftClientes,
  mapIbrsoftLocalizacoes,
  mapIbrsoftSucatas,
  mapIbrsoftProdutos,
  mapIbrsoftNfes,
  mapIbrsoftContas,
  buildIbrsoftLocationTree,
  type IbrsoftProdutoItem,
} from "../mappers/ibrsoft.mappers";

interface ExistingProductRef {
  id: string;
  sku: string;
  skuNormalized: string | null;
  locationId: string | null;
  scrapId: string | null;
}

export interface IbrsoftPacoteDeps {
  customers: CustomersExecDeps;
  locations: LocationExecDeps;
  scraps: ScrapsExecDeps;
  finance: FinanceExecDeps;
  nfe: NfeImportDeps;
  loadProductsBySkuNormalized: (
    userId: string,
    skusNormalized: string[],
  ) => Promise<ExistingProductRef[]>;
  productUseCase: Pick<ProductUseCase, "create">;
  attachProducts: LocationUseCase["attachProducts"];
  linkScrapMany: ProductUseCase["linkScrapMany"];
}

const locationUseCase = new LocationUseCase();
const productUseCase = new ProductUseCase();

export const defaultIbrsoftPacoteDeps: IbrsoftPacoteDeps = {
  customers: defaultCustomersDeps,
  locations: defaultLocationDeps,
  scraps: defaultScrapsDeps,
  finance: defaultFinanceDeps,
  nfe: defaultNfeImportDeps,
  loadProductsBySkuNormalized: async (userId, skusNormalized) => {
    const byNorm = await prisma.product.findMany({
      where: { userId, skuNormalized: { in: skusNormalized } },
      select: { id: true, sku: true, skuNormalized: true, locationId: true, scrapId: true },
    });
    // Legados com skuNormalized NULL não casam num IN — carrega-os para casar
    // por normalizeSku(sku) (mesma proteção anti-duplicação do IBR estoque).
    const legacy = await prisma.product.findMany({
      where: { userId, skuNormalized: null },
      select: { id: true, sku: true, skuNormalized: true, locationId: true, scrapId: true },
    });
    return [...byNorm, ...legacy];
  },
  productUseCase,
  attachProducts: locationUseCase.attachProducts.bind(locationUseCase),
  linkScrapMany: productUseCase.linkScrapMany.bind(productUseCase),
};

const BATCH = 200;
const PRELOAD_CHUNK = 500;

/** Runner IBRSOFT/PACOTE. */
export async function runIbrsoftPacote(
  ctx: ImportContext,
  deps: IbrsoftPacoteDeps = defaultIbrsoftPacoteDeps,
): Promise<ImportReport> {
  const clientesFile = fileOfKind(ctx.files, "IBRSOFT_CLIENTES");
  const locFile = fileOfKind(ctx.files, "IBRSOFT_LOCALIZACOES");
  const sucatasFile = fileOfKind(ctx.files, "IBRSOFT_SUCATAS");
  const produtosFile = fileOfKind(ctx.files, "IBRSOFT_PRODUTOS");
  const nfeFile = fileOfKind(ctx.files, "IBRSOFT_NFE");
  const pagarFile = fileOfKind(ctx.files, "IBRSOFT_CONTAS_PAGAR");
  const receberFile = fileOfKind(ctx.files, "IBRSOFT_CONTAS_RECEBER");
  if (
    !clientesFile && !locFile && !sucatasFile && !produtosFile && !nfeFile &&
    !pagarFile && !receberFile
  ) {
    throw new ImportValidationError(
      "Envie ao menos um CSV do export IBR Soft.",
    );
  }

  const report = newReport("IBRSOFT", "PACOTE", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};
  const sub = () => newReport("IBRSOFT", "PACOTE", ctx.targetUserId, ctx.dryRun);

  /* Fase 1 — clientes. */
  if (clientesFile) {
    const r = sub();
    const mapped = mapIbrsoftClientes(clientesFile);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "placeholders_descartados", mapped.skippedPlaceholder);
    bump(r, "duplicados_na_planilha", mapped.skippedDuplicateInSheet);
    await executeCustomersPlan(ctx, r, mapped.items, deps.customers);
    report.porFase["clientes"] = r;
  }

  /* Fase 2 — localizações (das localizacoes.csv + as citadas nos produtos). */
  let locCodeToId = new Map<string, string>();
  {
    const r = sub();
    const items = [
      ...(locFile ? mapIbrsoftLocalizacoes(locFile).items : []),
      ...(produtosFile ? mapIbrsoftProdutos(produtosFile).locationItems : []),
    ];
    // Dedup por code (mantém a 1ª — a de localizacoes.csv, com maxCapacity).
    const seen = new Set<string>();
    const deduped = items.filter((it) =>
      seen.has(it.code) ? false : (seen.add(it.code), true),
    );
    // Reordena por profundidade (pais antes dos filhos após o merge).
    deduped.sort(
      (a, b) => a.code.split(">").length - b.code.split(">").length,
    );
    bump(r, "localizacoes_distintas", deduped.length);
    if (deduped.length > 0) {
      locCodeToId = await executeLocationPlan(ctx, r, deduped, deps.locations);
      report.porFase["localizacoes"] = r;
    }
  }

  /* Fase 3 — sucatas (mapas placa→id / lote→id para o vínculo dos produtos). */
  const plateToScrapId = new Map<string, string>();
  const loteToScrapId = new Map<string, string>();
  if (sucatasFile) {
    const r = sub();
    const mapped = mapIbrsoftSucatas(sucatasFile);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    const codToId = await executeScrapsPlan(
      ctx,
      r,
      mapped.items,
      deps.scraps,
      locCodeToId,
    );
    // Cruza o cod→id com placa/lote de cada sucata (para o vínculo por peça).
    for (const item of mapped.items) {
      const id = codToId.get(item.cod);
      if (!id || id.startsWith("<dry-")) continue;
      if (item.plate) plateToScrapId.set(item.plate, id);
      if (item.lot) loteToScrapId.set(item.lot.trim(), id);
    }
    report.porFase["sucatas"] = r;
  }

  /* Fase 4 — produtos (cria + vincula localização + vincula sucata). */
  if (produtosFile) {
    const r = sub();
    const mapped = mapIbrsoftProdutos(produtosFile);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "produtos_validos", mapped.produtos.length);
    bump(r, "sem_sku", mapped.semSku);
    bump(r, "sku_duplicado_no_arquivo", mapped.duplicadosSku);
    await executeIbrsoftProdutos(
      ctx,
      r,
      mapped.produtos,
      locCodeToId,
      plateToScrapId,
      loteToScrapId,
      deps,
    );
    report.porFase["produtos"] = r;
    report.semProduto = r.semProduto;
    bump(report, "produtos_criados", r.contadores.produtos_criados ?? 0);
    bump(report, "produtos_vinculados", r.contadores.produtos_casados ?? 0);
  }

  /* Fase 5 — contas a pagar e a receber. */
  for (const [file, kind, faseKey] of [
    [pagarFile, "payable", "contas_a_pagar"],
    [receberFile, "receivable", "contas_a_receber"],
  ] as const) {
    if (!file) continue;
    const r = sub();
    const mapped = mapIbrsoftContas(file, kind);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    for (const erro of mapped.erros) {
      bump(r, "erros");
      addIssue(r.erros, erro);
    }
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    await executeFinancePlan(ctx, r, mapped.items, deps.finance);
    report.porFase[faseKey] = r;
  }

  /* Fase 6 — NF-e históricas. */
  if (nfeFile) {
    const r = sub();
    const mapped = mapIbrsoftNfes(nfeFile);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "numeros_distintos", mapped.items.length);
    bump(r, "sem_chave", mapped.semChave);
    for (const [status, n] of Object.entries(mapped.porStatus)) {
      bump(r, `status_${status.toLowerCase()}`, n);
    }
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    await executeNfeHistoricPlan(ctx, r, mapped.items, deps.nfe);
    report.porFase["nfe"] = r;
  }

  // Roll-up de erros/avisos para o topo.
  for (const r of Object.values(report.porFase)) {
    bump(report, "erros", r.contadores.erros ?? 0);
    bump(report, "avisos", r.contadores.avisos ?? 0);
  }
  return report;
}

/**
 * Produtos do IBR Soft: casa por skuNormalized, cria os faltantes (com
 * localização) e vincula localização + sucata (por placa/lote) aos que já
 * existem. Espelha o executor de estoque IBR, com a etapa extra de sucata.
 */
async function executeIbrsoftProdutos(
  ctx: ImportContext,
  report: ImportReport,
  produtos: IbrsoftProdutoItem[],
  codeToId: Map<string, string>,
  plateToScrapId: Map<string, string>,
  loteToScrapId: Map<string, string>,
  deps: IbrsoftPacoteDeps,
): Promise<void> {
  // 1. Preload por skuNormalized (+ legados null).
  const normToItem = new Map<string, IbrsoftProdutoItem>();
  for (const p of produtos) {
    const norm = normalizeSku(p.sku);
    if (!norm) continue;
    if (!normToItem.has(norm)) normToItem.set(norm, p);
  }
  const allNorms = Array.from(normToItem.keys());
  const bySkuNorm = new Map<string, ExistingProductRef[]>();
  const seenIds = new Set<string>();
  let preloaded = 0;
  for (const part of chunk(allNorms, PRELOAD_CHUNK)) {
    const refs = await deps.loadProductsBySkuNormalized(ctx.targetUserId, part);
    for (const ref of refs) {
      const key = ref.skuNormalized ?? normalizeSku(ref.sku);
      if (!key || seenIds.has(ref.id)) continue;
      seenIds.add(ref.id);
      const arr = bySkuNorm.get(key) ?? [];
      arr.push(ref);
      bySkuNorm.set(key, arr);
    }
    preloaded += part.length;
    ctx.onProgress?.({ fase: "casando produtos por SKU", processadas: preloaded, total: allNorms.length });
  }

  const byLocation = new Map<string, string[]>();
  const byScrap = new Map<string, string[]>();
  const aCriar: Array<{ item: IbrsoftProdutoItem; locationId: string | null; scrapId: string | null }> = [];

  const resolveScrap = (item: IbrsoftProdutoItem): string | null => {
    if (item.scrapPlate) {
      const s = plateToScrapId.get(item.scrapPlate);
      if (s) return s;
    }
    if (item.scrapLote) {
      const s = loteToScrapId.get(item.scrapLote.trim());
      if (s) return s;
    }
    return null;
  };

  for (const [norm, item] of normToItem) {
    const resolved = item.locationCode ? (codeToId.get(item.locationCode) ?? null) : null;
    const isDry = !!resolved && resolved.startsWith("<dry-");
    const locationId = resolved && !isDry ? resolved : null;
    const scrapId = resolveScrap(item);

    const refs = bySkuNorm.get(norm) ?? [];
    if (refs.length > 1) {
      bump(report, "sku_ambiguo");
      continue;
    }
    if (refs.length === 1) {
      bump(report, "produtos_casados");
      const product = refs[0];
      // Localização.
      if (resolved) {
        if (ctx.dryRun) {
          if (isDry || product.locationId !== resolved) bump(report, "local_a_vincular");
          else bump(report, "local_ja_correto");
        } else if (product.locationId === locationId) {
          bump(report, "local_ja_correto");
        } else {
          const arr = byLocation.get(locationId!) ?? [];
          arr.push(product.id);
          byLocation.set(locationId!, arr);
        }
      }
      // Sucata.
      if (scrapId) {
        if (product.scrapId === scrapId) {
          bump(report, "sucata_ja_correta");
        } else if (ctx.dryRun) {
          bump(report, "sucata_a_vincular");
        } else {
          const arr = byScrap.get(scrapId) ?? [];
          arr.push(product.id);
          byScrap.set(scrapId, arr);
        }
      }
    } else {
      aCriar.push({ item, locationId, scrapId });
    }
  }
  bump(report, "a_criar", aCriar.length);

  if (!ctx.dryRun) {
    // Vínculo de localização (existentes) em chunks ≤200.
    for (const [locationId, ids] of byLocation) {
      for (const part of chunk(ids, BATCH)) {
        try {
          const res = await deps.attachProducts(locationId, part, ctx.targetUserId);
          bump(report, "local_vinculado", res.attached.length);
          bump(report, "local_ja_correto", res.alreadyAttached.length);
        } catch (err) {
          bump(report, "erros", part.length);
          addIssue(report.erros, {
            motivo: `Falha ao vincular ${part.length} produto(s) à localização: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    // Vínculo de sucata (existentes) em chunks ≤200.
    for (const [scrapId, ids] of byScrap) {
      for (const part of chunk(ids, BATCH)) {
        try {
          const res = await deps.linkScrapMany(scrapId, part, ctx.targetUserId);
          bump(report, "sucata_vinculada", res.count);
        } catch (err) {
          bump(report, "erros", part.length);
          addIssue(report.erros, {
            motivo: `Falha ao vincular ${part.length} produto(s) à sucata: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    // Criação dos faltantes (com localização; sucata via linkScrap depois).
    for (const { item, locationId, scrapId } of aCriar) {
      try {
        const created = await deps.productUseCase.create({
          userId: ctx.targetUserId,
          sku: item.sku,
          name: item.name,
          price: item.price,
          stock: item.stock,
          costPrice: item.cost ?? undefined,
          brand: item.brand ?? undefined,
          model: item.model ?? undefined,
          quality: "SEMINOVO",
          imageUrl: "",
          ...(locationId ? { locationId, location: item.locationText ?? undefined } : {}),
          ...(scrapId ? { scrapId } : {}),
          attributes: {
            migration: { value_name: "IBRSOFT" },
            ncm: { value_name: item.ncm ?? "" },
            barcode: { value_name: item.barcode ?? "" },
          },
        });
        void created;
        bump(report, "produtos_criados");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/já existe/i.test(msg) || /unique/i.test(msg)) {
          bump(report, "ja_existiam_corrida");
          continue;
        }
        bump(report, "erros");
        addIssue(report.erros, { linha: item.linha, motivo: `Produto SKU ${item.sku}: ${msg}` });
      }
    }
  } else {
    // Prévia: amostra dos que serão criados.
    for (const { item } of aCriar.slice(0, 20)) {
      addSample(report, {
        sku: item.sku,
        nome: item.name,
        preco: item.price,
        localizacao: item.locationText ?? null,
      });
    }
  }
}

// Reexporta o builder p/ o runner de localização standalone, se necessário.
export { buildIbrsoftLocationTree };
