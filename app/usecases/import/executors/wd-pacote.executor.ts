/**
 * PACOTE WebDesmonte — uma request com os CSVs do export (locations,
 * purchase_waste, products, customers — qualquer subconjunto) executa as
 * fases NA ORDEM DE DEPENDÊNCIA com os mapas GUID→id vivendo em memória:
 * clientes → localizações → sucatas → vínculo de produtos. É o modo
 * recomendado para onboarding IBR: evita re-upload de locations.csv por
 * fase e garante que a resolução de GUID nunca "chuta".
 */

import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  bump,
  newReport,
} from "../import.types";
import { fileOfKind } from "../import-detector";
import { mapWdCustomers } from "../mappers/wd-clientes.mapper";
import { mapWdLocations } from "../mappers/wd-localizacoes.mapper";
import { mapWdScraps } from "../mappers/sucatas.mapper";
import { mapWdLinks } from "../mappers/vinculos.mapper";
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

export interface WdPacoteDeps extends LinksRunnerDeps {
  customers: CustomersExecDeps;
}

export const defaultWdPacoteDeps: WdPacoteDeps = {
  ...defaultLinksRunnerDeps,
  customers: defaultCustomersDeps,
};

export async function runWdPacote(
  ctx: ImportContext,
  deps: WdPacoteDeps = defaultWdPacoteDeps,
): Promise<ImportReport> {
  const locations = fileOfKind(ctx.files, "WD_LOCATIONS");
  const waste = fileOfKind(ctx.files, "WD_PURCHASE_WASTE");
  const products = fileOfKind(ctx.files, "WD_PRODUCTS");
  const customers = fileOfKind(ctx.files, "WD_CUSTOMERS");
  if (!locations && !waste && !products && !customers) {
    throw new ImportValidationError(
      "Envie ao menos um CSV do export WebDesmonte (locations, purchase_waste, products ou customers).",
    );
  }

  const report = newReport("WEBDESMONTE", "PACOTE", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};
  const sub = () =>
    newReport("WEBDESMONTE", "PACOTE", ctx.targetUserId, ctx.dryRun);

  // Fase 1 — clientes (não dependem de nada).
  if (customers) {
    const r = sub();
    const mapped = mapWdCustomers(customers);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    bump(r, "placeholders_descartados", mapped.skippedPlaceholder);
    bump(r, "duplicados_na_planilha", mapped.skippedDuplicateInSheet);
    await executeCustomersPlan(ctx, r, mapped.items, deps.customers);
    report.porFase["clientes"] = r;
  }

  // Fase 2 — localizações (pais antes dos filhos; devolve code→id).
  let locCodeToId: Map<string, string> | undefined;
  let guidToCode: Map<string, string> | undefined;
  if (locations) {
    const r = sub();
    const mapped = mapWdLocations(locations);
    guidToCode = mapped.guidToCode;
    bump(r, "localizacoes_distintas", mapped.items.length);
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    locCodeToId = await executeLocationPlan(ctx, r, mapped.items, deps.locations);
    report.porFase["localizacoes"] = r;
  }

  // Fase 3 — sucatas (podem referenciar localização recém-criada).
  let scrapKeyToId: Map<string, string> | undefined;
  if (waste) {
    const r = sub();
    const mapped = mapWdScraps(waste, guidToCode);
    bump(r, "linhas_no_arquivo", mapped.totalRows);
    for (const aviso of mapped.avisos) {
      bump(r, "avisos");
      addIssue(r.avisos, aviso);
    }
    scrapKeyToId = await executeScrapsPlan(ctx, r, mapped.items, deps.scraps);
    report.porFase["sucatas"] = r;
  }

  // Fase 4 — vínculo por SKU (precisa do locations.csv p/ resolver GUIDs).
  if (products) {
    const r = sub();
    if (!guidToCode) {
      bump(r, "avisos");
      addIssue(r.avisos, {
        motivo:
          "products.csv sem locations.csv no pacote — vínculos de LOCALIZAÇÃO não serão resolvidos (os de sucata seguem normalmente)",
      });
    }
    const mapped = mapWdLinks(products, guidToCode ?? new Map());
    bump(r, "linhas_no_arquivo", mapped.totalRows);
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
    report.semProduto = r.semProduto;
    report.ambiguos = r.ambiguos;
    bump(report, "produtos_casados", r.contadores.produtos_casados ?? 0);
  }

  // Roll-up de erros/avisos para o topo (as listas ficam nas fases).
  for (const r of Object.values(report.porFase)) {
    bump(report, "erros", r.contadores.erros ?? 0);
    bump(report, "avisos", r.contadores.avisos ?? 0);
  }
  return report;
}
