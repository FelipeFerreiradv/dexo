/**
 * PACOTE Vaapt — uma request com as planilhas do export (peças, clientes,
 * veículos, notas emitidas — qualquer subconjunto) executa as fases NA ORDEM
 * DE DEPENDÊNCIA com os mapas vivendo em memória:
 * clientes → localizações → sucatas → vínculo de produtos → fotos das peças →
 * NF-e históricas.
 *
 * Espelha o PACOTE do WebDesmonte (`wd-pacote.executor.ts`): mesma estrutura,
 * mesmos `execute*Plan` já validados, mesmo relatório `porFase`. O operador
 * anexa tudo de uma vez e o detector classifica cada arquivo pela ASSINATURA
 * DE COLUNAS — não precisa mais escolher Clientes/Localizações/… a cada envio.
 *
 * Por que as fases compartilham mapas (e não são só runners empilhados):
 * - `locCodeToId` (fase 2) alimenta as sucatas E o vínculo, então uma
 *   localização criada agora é resolvida sem ir ao banco — e na PRÉVIA, onde
 *   nada foi gravado, é o único jeito de não acusar "localização não existe";
 * - `scrapKeyToId` (fase 3) alimenta o vínculo de sucata por peça.
 *
 * O arquivo de peças é lido DUAS vezes (fase 2 = árvore de localizações,
 * fase 4 = vínculos) — é o mesmo desenho do VAAPT/VINCULOS atual, barato em
 * memória e mantém as fases isoladas.
 *
 * Idempotência e prévia (dryRun sem escrita) são herdadas integralmente dos
 * executores compostos: markers de código legado em clientes/sucatas, código
 * único por tenant em localizações, casamento por `skuNormalized` no vínculo e
 * dedup por chave/(série,número) na NF-e.
 */

import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  bump,
  newReport,
} from "../import.types";
import { fileOfKind } from "../import-detector";
import { mapVaaptCustomers } from "../mappers/vaapt-clientes.mapper";
import { mapVaaptLocations } from "../mappers/vaapt-localizacoes.mapper";
import { mapVaaptScraps } from "../mappers/sucatas.mapper";
import { mapVaaptLinks } from "../mappers/vinculos.mapper";
import { mapVaaptProdutos } from "../mappers/vaapt-produtos.mapper";
import { mapVaaptPhotos } from "../mappers/vaapt-fotos.mapper";
import {
  executeCustomersPlan,
  defaultCustomersDeps,
  type CustomersExecDeps,
} from "./customers.executor";
import { executeLocationPlan } from "./locations.executor";
import { executeScrapsPlan } from "./scraps.executor";
import {
  executeLinksPlan,
  defaultLinksRunnerDeps,
  type LinksRunnerDeps,
} from "./product-links.executor";
import {
  executePhotosPlan,
  defaultPhotosDeps,
  type PhotosExecDeps,
} from "./product-photos.executor";
import {
  executeProdutosPlan,
  defaultVaaptProdutosDeps,
  type VaaptProdutosDeps,
} from "./vaapt-produtos.executor";
import {
  runVaaptNfes,
  defaultNfeImportDeps,
  type NfeImportDeps,
} from "../nfe-import.usecase";

export interface VaaptPacoteDeps extends LinksRunnerDeps {
  customers: CustomersExecDeps;
  nfe: NfeImportDeps;
  photos: PhotosExecDeps;
  produtos: VaaptProdutosDeps;
}

export const defaultVaaptPacoteDeps: VaaptPacoteDeps = {
  ...defaultLinksRunnerDeps,
  customers: defaultCustomersDeps,
  nfe: defaultNfeImportDeps,
  photos: defaultPhotosDeps,
  produtos: defaultVaaptProdutosDeps,
};

export async function runVaaptPacote(
  ctx: ImportContext,
  deps: VaaptPacoteDeps = defaultVaaptPacoteDeps,
): Promise<ImportReport> {
  const clientes = fileOfKind(ctx.files, "VAAPT_CLIENTES");
  const pecas = fileOfKind(ctx.files, "VAAPT_PECAS");
  const produtos = fileOfKind(ctx.files, "VAAPT_PRODUTOS");
  const veiculos = fileOfKind(ctx.files, "VAAPT_VEICULOS");
  const nfe = fileOfKind(ctx.files, "VAAPT_NFE");
  const fotos = fileOfKind(ctx.files, "VAAPT_PECAS_IMAGENS");
  if (!clientes && !pecas && !produtos && !veiculos && !nfe && !fotos) {
    throw new ImportValidationError(
      "Envie ao menos uma planilha do export Vaapt (peças, relatório de produtos, clientes, veículos, notas emitidas ou fotos das peças).",
    );
  }

  const report = newReport("VAAPT", "PACOTE", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};
  const sub = () => newReport("VAAPT", "PACOTE", ctx.targetUserId, ctx.dryRun);

  // Fase 1 — clientes (não dependem de nada).
  if (clientes) {
    const r = sub();
    const mapped = mapVaaptCustomers(clientes);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "clientes_validos", mapped.items.length);
    bump(r, "placeholders_descartados", mapped.skippedPlaceholder);
    bump(r, "duplicados_na_planilha", mapped.skippedDuplicateInSheet);
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    await executeCustomersPlan(ctx, r, mapped.items, deps.customers);
    report.porFase["clientes"] = r;
  }

  // Fase 2 — localizações (derivadas do próprio arquivo de peças).
  let locCodeToId: Map<string, string> | undefined;
  if (pecas) {
    const r = sub();
    const mapped = mapVaaptLocations(pecas);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "linhas_sem_localizacao", mapped.rowsWithoutLocation);
    bump(r, "localizacoes_distintas", mapped.items.length);
    locCodeToId = await executeLocationPlan(ctx, r, mapped.items, deps.locations);
    report.porFase["localizacoes"] = r;
  }

  // Fase 2b — relatório de produtos (export NOVO do Vaapt). Cria as
  // localizações do próprio arquivo e os produtos faltantes. Roda ANTES do
  // vínculo (fase 4) porque é ela que faz os produtos existirem — o vínculo
  // só liga o que já está no Dexo.
  if (produtos) {
    const rLoc = sub();
    const mapped = mapVaaptProdutos(produtos);
    bump(rLoc, "linhas_no_arquivo", mapped.totalRows);
    bump(rLoc, "localizacoes_distintas", mapped.locationItems.length);
    const codeToId = await executeLocationPlan(
      ctx,
      rLoc,
      mapped.locationItems,
      deps.locations,
    );
    // As localizações criadas aqui alimentam as fases seguintes. Na prévia
    // elas só existem neste mapa, então não mesclar geraria aviso falso.
    if (locCodeToId) {
      for (const [code, id] of codeToId) locCodeToId.set(code, id);
    } else {
      locCodeToId = codeToId;
    }
    report.porFase["localizacoes_produtos"] = rLoc;

    const rProd = sub();
    bump(rProd, "produtos_validos", mapped.produtos.length);
    bump(rProd, "sem_sku", mapped.semSku);
    bump(rProd, "sku_duplicado_no_arquivo", mapped.duplicadosSku);
    bump(rProd, "linhas_excluidas_na_origem", mapped.excluidos);
    for (const aviso of mapped.avisos) {
      bump(rProd, "avisos");
      addIssue(rProd.avisos, aviso);
    }
    await executeProdutosPlan(
      ctx,
      rProd,
      mapped.produtos,
      codeToId,
      deps.produtos,
    );
    report.porFase["produtos"] = rProd;
    bump(report, "produtos_criados", rProd.contadores.produtos_criados ?? 0);
  }

  // Fase 3 — sucatas (recebem o mapa da fase 2: na prévia as localizações
  // ainda não existem no banco e só o mapa evita aviso falso).
  let scrapKeyToId: Map<string, string> | undefined;
  if (veiculos) {
    const r = sub();
    const mapped = mapVaaptScraps(veiculos);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "linhas_invalidas", mapped.invalidRows);
    if (mapped.duplicateRows) {
      bump(r, "linhas_repetidas_mesmo_veiculo", mapped.duplicateRows);
    }
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    scrapKeyToId = await executeScrapsPlan(
      ctx,
      r,
      mapped.items,
      deps.scraps,
      locCodeToId,
    );
    report.porFase["sucatas"] = r;
  }

  // Fase 4 — vínculo por SKU (usa os mapas das fases 2 e 3).
  if (pecas) {
    const r = sub();
    const mapped = mapVaaptLinks(pecas);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "linhas_invalidas", mapped.invalidRows);
    bump(r, "sku_duplicado_na_planilha", mapped.duplicateSkuInSheet);
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    await executeLinksPlan(
      ctx,
      r,
      mapped.items,
      { locCodeToId, scrapKeyToId },
      deps.links,
    );
    report.porFase["vinculos"] = r;
    // Destaques sobem para o topo (a UI mostra sem_produto/ambiguos de cara).
    report.semProduto = r.semProduto;
    report.ambiguos = r.ambiguos;
    bump(report, "produtos_casados", r.contadores.produtos_casados ?? 0);
  }

  // Fase 5 — fotos das peças. Casa pelo MESMO SKU do vínculo e só preenche
  // produto sem imagem; não depende dos mapas das fases anteriores.
  if (fotos) {
    const r = sub();
    const mapped = mapVaaptPhotos(fotos);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "linhas_invalidas", mapped.invalidRows);
    if (mapped.urlsInvalidas) bump(r, "links_invalidos", mapped.urlsInvalidas);
    if (mapped.urlsDuplicadas) bump(r, "links_repetidos", mapped.urlsDuplicadas);
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    await executePhotosPlan(ctx, r, mapped.items, deps.photos);
    report.porFase["fotos"] = r;
  }

  // Fase 6 — NF-e históricas (independente das demais: nenhum mapa em comum).
  // Reusa o runner VAAPT/NFE inteiro — o avanço da NfeSequence é irreversível,
  // então esse caminho fiscal roda exatamente como roda sozinho.
  if (nfe) {
    report.porFase["nfe"] = await runVaaptNfes(ctx, deps.nfe);
  }

  // Roll-up de erros/avisos para o topo (as listas ficam nas fases).
  for (const r of Object.values(report.porFase)) {
    bump(report, "erros", r.contadores.erros ?? 0);
    bump(report, "avisos", r.contadores.avisos ?? 0);
  }
  return report;
}
