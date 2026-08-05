/**
 * Executor do RELATÓRIO DE PRODUTOS do Vaapt (export novo). Mesmo contrato do
 * `ibr-estoque.executor.ts`, que é o precedente validado — as diferenças estão
 * marcadas abaixo. Faz, em ordem, na MESMA execução:
 *   1. cria as localizações distintas do arquivo (planas, idempotente);
 *   2. casa cada linha por `skuNormalized` contra os produtos do tenant;
 *   3. produto existente → vincula a localização (`attachProducts`);
 *   4. produto ausente → cria via `ProductUseCase.create`, já com a localização.
 *
 * O QUE MUDA EM RELAÇÃO AO IBR:
 * - o dono é resolvido UMA vez e injetado no `ProductUseCase`. O executor do
 *   IBR não faz isso e paga um `findById` POR PRODUTO CRIADO — com 28.910
 *   peças seriam 28.910 consultas a mais, contra a regra de egress da casa.
 * - grava `description` a partir da planilha (é o 1º importador com descrição
 *   na origem). Sem descrição, `applyUserDefaults` cai no padrão do tenant,
 *   como antes.
 *
 * Anti-duplicação: casamento por `skuNormalized` + unique `(userId, sku)` +
 * P2002 tratado como "já existe → vincula". Reimportar não duplica.
 * A PRÉVIA (dryRun) não escreve nada e mostra criar/vincular/já-correto.
 */

import prisma from "../../../lib/prisma";
import { normalizeSku } from "../../../lib/sku";
import type { User } from "../../../interfaces/user.interface";
import { UserRepositoryPrisma } from "../../../repositories/user.repository";
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
  mapVaaptProdutos,
  type VaaptProdutoPlanItem,
} from "../mappers/vaapt-produtos.mapper";
import {
  executeLocationPlan,
  defaultLocationDeps,
  type LocationExecDeps,
} from "./locations.executor";

interface ExistingProductRef {
  id: string;
  sku: string;
  skuNormalized: string | null;
  locationId: string | null;
}

export interface VaaptProdutosDeps {
  locations: LocationExecDeps;
  /**
   * Fábrica em vez de instância: o dono entra pré-resolvido no construtor, e é
   * isso que evita um `findById` por produto criado.
   */
  makeProductUseCase: (owner: User | null) => Pick<ProductUseCase, "create">;
  loadOwner: (userId: string) => Promise<User | null>;
  loadProductsBySkuNormalized: (
    userId: string,
    skusNormalized: string[],
  ) => Promise<ExistingProductRef[]>;
  /**
   * Produtos LEGADOS com `skuNormalized` NULL — carregados UMA vez, fora do
   * laço de lotes.
   *
   * ⚠️ No `ibr-estoque.executor.ts`, que é o precedente deste arquivo, esta
   * consulta mora DENTRO de `loadProductsBySkuNormalized` e portanto roda uma
   * vez POR LOTE de 500 SKUs, sempre devolvendo o mesmo conjunto. Com os
   * 28.910 SKUs deste export seriam 58 varreduras idênticas e sem filtro de
   * SKU. Separar custa nada e é o que a regra de egress da casa manda.
   */
  loadLegacyProducts: (userId: string) => Promise<ExistingProductRef[]>;
  attachProducts: LocationUseCase["attachProducts"];
}

const locationUseCase = new LocationUseCase();
const userRepository = new UserRepositoryPrisma();

export const defaultVaaptProdutosDeps: VaaptProdutosDeps = {
  locations: defaultLocationDeps,
  makeProductUseCase: (owner) => new ProductUseCase(owner),
  loadOwner: (userId) => userRepository.findById(userId),
  loadProductsBySkuNormalized: (userId, skusNormalized) =>
    prisma.product.findMany({
      where: { userId, skuNormalized: { in: skusNormalized } },
      select: { id: true, sku: true, skuNormalized: true, locationId: true },
    }),
  // ANTI-DUPLICAÇÃO: produtos LEGADOS com skuNormalized NULL (coluna
  // adicionada via SQL, backfill não rodado para o tenant) nunca casam num
  // `IN` sobre skuNormalized. Sem isto, o executor os trataria como
  // "faltantes" e CRIARIA um 2º produto para o mesmo SKU (o unique
  // (userId, sku) é case-sensitive). Num tenant com backfill, volta vazia.
  loadLegacyProducts: (userId) =>
    prisma.product.findMany({
      where: { userId, skuNormalized: null },
      select: { id: true, sku: true, skuNormalized: true, locationId: true },
    }),
  attachProducts: locationUseCase.attachProducts.bind(locationUseCase),
};

const BATCH = 200; // limite hard do attachProducts
const PRELOAD_CHUNK = 500;

/** Runner VAAPT/PRODUTOS. */
export async function runVaaptProdutos(
  ctx: ImportContext,
  deps: VaaptProdutosDeps = defaultVaaptProdutosDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "VAAPT_PRODUTOS");
  if (!file) {
    throw new ImportValidationError(
      "Relatório de produtos (Vaapt) não encontrado.",
    );
  }
  const report = newReport("VAAPT", "PRODUTOS", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};

  const mapped = mapVaaptProdutos(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "produtos_validos", mapped.produtos.length);
  bump(report, "sem_sku", mapped.semSku);
  bump(report, "sku_duplicado_no_arquivo", mapped.duplicadosSku);
  bump(report, "linhas_excluidas_na_origem", mapped.excluidos);
  bump(report, "sem_localizacao_no_arquivo", mapped.semLocalizacao);
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }

  /* Fase 1 — localizações (planas, do próprio arquivo; idempotente). */
  const locReport = newReport("VAAPT", "PRODUTOS", ctx.targetUserId, ctx.dryRun);
  bump(locReport, "localizacoes_distintas", mapped.locationItems.length);
  const codeToId = await executeLocationPlan(
    ctx,
    locReport,
    mapped.locationItems,
    deps.locations,
  );
  report.porFase["localizacoes"] = locReport;

  /* Fase 2 — produtos (casar por SKU → vincular existentes / criar faltantes). */
  const prodReport = newReport("VAAPT", "PRODUTOS", ctx.targetUserId, ctx.dryRun);
  await executeProdutosPlan(ctx, prodReport, mapped.produtos, codeToId, deps);
  report.porFase["produtos"] = prodReport;

  // Roll-up dos destaques para o topo.
  bump(report, "produtos_criados", prodReport.contadores.produtos_criados ?? 0);
  bump(
    report,
    "produtos_vinculados",
    prodReport.contadores.produtos_casados ?? 0,
  );
  bump(
    report,
    "erros",
    (locReport.contadores.erros ?? 0) + (prodReport.contadores.erros ?? 0),
  );
  return report;
}

export async function executeProdutosPlan(
  ctx: ImportContext,
  report: ImportReport,
  produtos: VaaptProdutoPlanItem[],
  codeToId: Map<string, string>,
  deps: VaaptProdutosDeps = defaultVaaptProdutosDeps,
): Promise<void> {
  bump(report, "linhas", produtos.length);

  /* 1. Preload dos produtos existentes por skuNormalized (chunks em lote). */
  const normToItem = new Map<string, VaaptProdutoPlanItem>();
  for (const p of produtos) {
    const norm = normalizeSku(p.sku);
    if (!norm) {
      bump(report, "erros");
      addIssue(report.erros, { linha: p.linha, motivo: "SKU vazio" });
      continue;
    }
    // Dedup já garantido no mapper; se colidir, a 1ª vence.
    if (!normToItem.has(norm)) normToItem.set(norm, p);
  }
  const allNorms = Array.from(normToItem.keys());
  const bySkuNorm = new Map<string, ExistingProductRef[]>();
  const seenProductIds = new Set<string>();

  const indexar = (refs: ExistingProductRef[]): void => {
    for (const ref of refs) {
      // Indexa por skuNormalized do banco quando existe; para o legado com
      // skuNormalized NULL, deriva de normalizeSku(sku) — a MESMA chave que o
      // item do arquivo usa. Assim o legado casa e é vinculado (não recriado).
      const key = ref.skuNormalized ?? normalizeSku(ref.sku);
      if (!key) continue;
      if (seenProductIds.has(ref.id)) continue;
      seenProductIds.add(ref.id);
      const arr = bySkuNorm.get(key) ?? [];
      arr.push(ref);
      bySkuNorm.set(key, arr);
    }
  };

  // UMA vez, não uma por lote (ver o comentário em `loadLegacyProducts`).
  indexar(await deps.loadLegacyProducts(ctx.targetUserId));

  let preloaded = 0;
  for (const part of chunk(allNorms, PRELOAD_CHUNK)) {
    indexar(await deps.loadProductsBySkuNormalized(ctx.targetUserId, part));
    preloaded += part.length;
    ctx.onProgress?.({
      fase: "casando produtos por SKU",
      processadas: preloaded,
      total: allNorms.length,
    });
  }

  /* 2. Resolve o destino de localização e separa vincular vs criar. */
  const byLocation = new Map<string, string[]>(); // locationId → productIds
  const aCriar: Array<{
    item: VaaptProdutoPlanItem;
    locationId: string | null;
  }> = [];

  for (const [norm, item] of normToItem) {
    // Destino de localização. No APPLY o id é sempre real; na PRÉVIA, uma
    // localização a ser criada tem id placeholder "<dry-...>".
    const resolved = item.locationCode
      ? (codeToId.get(item.locationCode) ?? null)
      : null;
    const isDry = !!resolved && resolved.startsWith("<dry-");
    const locationId = resolved && !isDry ? resolved : null;

    const refs = bySkuNorm.get(norm) ?? [];
    if (refs.length > 1) {
      bump(report, "sku_ambiguo");
      bump(report, "avisos");
      addIssue(report.avisos, {
        linha: item.linha,
        motivo: `SKU "${item.sku}" casa ${refs.length} produtos no Dexo — não vinculado (revise manualmente)`,
      });
      continue;
    }

    if (refs.length === 1) {
      // Produto JÁ existe → só vincula a localização (nunca recria, nunca
      // sobrescreve nome/preço/estoque de um cadastro que já está em uso).
      bump(report, "produtos_casados");
      const product = refs[0];
      if (!resolved) continue; // sem localização no arquivo → nada a fazer

      if (ctx.dryRun) {
        if (isDry || product.locationId !== resolved) {
          bump(report, "local_a_vincular");
          if (product.locationId) bump(report, "local_sobrescrito");
        } else {
          bump(report, "local_ja_correto");
        }
        continue;
      }
      if (product.locationId === locationId) {
        bump(report, "local_ja_correto");
        continue;
      }
      if (product.locationId) bump(report, "local_sobrescrito");
      const arr = byLocation.get(locationId!) ?? [];
      arr.push(product.id);
      byLocation.set(locationId!, arr);
    } else {
      aCriar.push({ item, locationId });
    }
  }

  bump(report, "a_criar", aCriar.length);

  /* 3. Vínculo dos EXISTENTES (attachProducts, chunks ≤200, serial). */
  const totalLoc = Array.from(byLocation.values()).reduce(
    (a, ids) => a + ids.length,
    0,
  );
  let locDone = 0;
  for (const [locationId, productIds] of byLocation) {
    if (ctx.dryRun) {
      bump(report, "local_a_vincular", productIds.length);
      locDone += productIds.length;
      continue;
    }
    for (const partIds of chunk(productIds, BATCH)) {
      try {
        const res = await deps.attachProducts(
          locationId,
          partIds,
          ctx.targetUserId,
        );
        bump(report, "local_vinculado", res.attached.length);
        bump(report, "local_ja_correto", res.alreadyAttached.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bump(report, "erros", partIds.length);
        addIssue(report.erros, {
          motivo: `Falha ao vincular ${partIds.length} produto(s) à localização: ${msg}`,
        });
      }
      locDone += partIds.length;
      ctx.onProgress?.({
        fase: "vinculando localizações",
        processadas: locDone,
        total: totalLoc,
      });
    }
  }

  /* 4. Criação dos FALTANTES. */
  if (aCriar.length === 0) return;

  if (ctx.dryRun) {
    for (const { item } of aCriar) {
      addSample(report, {
        sku: item.sku,
        nome: item.name,
        preco: item.price,
        estoque: item.stock,
        localizacao: item.locationText ?? null,
      });
    }
    return;
  }

  // Dono resolvido UMA vez — é o que evita 28.910 findById.
  const owner = await deps.loadOwner(ctx.targetUserId);
  if (!owner) {
    throw new ImportValidationError(
      "Usuário de destino não encontrado — a importação foi interrompida antes de criar qualquer produto.",
    );
  }
  const productUseCase = deps.makeProductUseCase(owner);

  let criados = 0;
  for (let idx = 0; idx < aCriar.length; idx++) {
    const { item, locationId } = aCriar[idx];
    if (idx % 100 === 0 || idx === aCriar.length - 1) {
      ctx.onProgress?.({
        fase: "criando produtos",
        processadas: idx + 1,
        total: aCriar.length,
      });
    }
    try {
      await productUseCase.create({
        userId: ctx.targetUserId,
        sku: item.sku,
        name: item.name,
        price: item.price,
        stock: item.stock,
        // Sem descrição na planilha, `applyUserDefaults` usa a padrão do
        // tenant — mesmo comportamento dos outros importadores.
        ...(item.description ? { description: item.description } : {}),
        quality: "SEMINOVO",
        imageUrl: "",
        ...(locationId
          ? { locationId, location: item.locationText ?? undefined }
          : {}),
        attributes: {
          migration: { value_name: "VAAPT" },
          // Rastro da origem. NÃO cria anúncio nem resolve categoria:
          // importar é povoar o catálogo, publicar é outro ato.
          vaaptMlb: { value_name: item.mlb ?? "" },
          vaaptCategoriaMl: { value_name: item.mlCategoriaExterna ?? "" },
        },
      });
      bump(report, "produtos_criados");
      criados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Backstop: o SKU passou a existir entre o preload e o create (corrida
      // real) → NÃO duplica (o unique barrou), conta como já-existente.
      if (/já existe/i.test(msg) || /unique/i.test(msg)) {
        bump(report, "ja_existiam_corrida");
        continue;
      }
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Produto SKU ${item.sku}: ${msg}`,
      });
    }
  }
  bump(report, "produtos_criados_total", criados);
}
