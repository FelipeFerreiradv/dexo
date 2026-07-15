/**
 * PACOTE do IBR "tabular" — uma request com os CSVs do export importa as
 * entidades reconhecidas na ordem de dependência:
 *   produtos (estoque.csv) → NF-e históricas (nfe_emitidas.csv).
 *
 * NÃO tem caminho de escrita próprio: COMPÕE os dois runners já validados em
 * produção (`runIbrEstoque` e `runIbrNfes`) exatamente como rodariam sozinhos,
 * apenas aninhando cada relatório em `porFase`. Isso garante zero regressão —
 * o comportamento por entidade é literalmente o mesmo do modo individual.
 *
 * TOLERANTE A PARCIAIS/EXTRAS: cada fase só roda se o arquivo daquele papel
 * veio (estoque.csv e/ou nfe_emitidas.csv). Arquivos que não pertencem ao
 * pacote (vendas*, empresa, nfe_produtos…) já foram descartados por
 * `detectAndValidate` antes de chegar aqui — o operador pode arrastar o export
 * inteiro que o motor usa só o que reconhece, sem bloquear.
 *
 * Anti-duplicação e prévia (dryRun sem escrita) são herdadas integralmente dos
 * runners compostos: casamento por skuNormalized + unique (userId, sku) no
 * estoque; dedup por chave/`(série,número)` na NF-e.
 */

import type { ImportContext, ImportReport } from "../import.types";
import { ImportValidationError, bump, newReport } from "../import.types";
import { fileOfKind } from "../import-detector";
import {
  runIbrEstoque,
  defaultIbrEstoqueDeps,
  type IbrEstoqueDeps,
} from "./ibr-estoque.executor";
import {
  runIbrNfes,
  defaultNfeImportDeps,
  type NfeImportDeps,
} from "../nfe-import.usecase";

export interface IbrPacoteDeps {
  estoque: IbrEstoqueDeps;
  nfe: NfeImportDeps;
}

export const defaultIbrPacoteDeps: IbrPacoteDeps = {
  estoque: defaultIbrEstoqueDeps,
  nfe: defaultNfeImportDeps,
};

/** Runner IBR/PACOTE. */
export async function runIbrPacote(
  ctx: ImportContext,
  deps: IbrPacoteDeps = defaultIbrPacoteDeps,
): Promise<ImportReport> {
  const estoqueFile = fileOfKind(ctx.files, "IBR_ESTOQUE");
  const nfeFile = fileOfKind(ctx.files, "IBR_NFE");
  if (!estoqueFile && !nfeFile) {
    throw new ImportValidationError(
      "Envie ao menos um CSV do export IBR (estoque.csv ou nfe_emitidas.csv).",
    );
  }

  const report = newReport("IBR", "PACOTE", ctx.targetUserId, ctx.dryRun);
  report.porFase = {};

  /* Fase 1 — produtos (estoque.csv): localizações + casar/criar por SKU. */
  if (estoqueFile) {
    const r = await runIbrEstoque(ctx, deps.estoque);
    report.porFase["estoque"] = r;
    // Roll-up dos destaques de produtos para o topo do pacote.
    bump(report, "produtos_criados", r.contadores.produtos_criados ?? 0);
    bump(report, "produtos_vinculados", r.contadores.produtos_vinculados ?? 0);
    // O estoque expõe SKUs sem produto no seu próprio report; propaga p/ o topo.
    if (r.semProduto) report.semProduto = r.semProduto;
  }

  /* Fase 2 — NF-e históricas (nfe_emitidas.csv): createHistoric + sequência. */
  if (nfeFile) {
    const r = await runIbrNfes(ctx, deps.nfe);
    report.porFase["nfe"] = r;
    bump(report, "nfe_criadas", r.contadores.criadas ?? 0);
    bump(report, "nfe_ja_existiam", r.contadores.ja_existiam ?? 0);
  }

  // Roll-up de erros/avisos de todas as fases para o topo.
  for (const r of Object.values(report.porFase)) {
    bump(report, "erros", r.contadores.erros ?? 0);
    bump(report, "avisos", r.contadores.avisos ?? 0);
  }
  return report;
}
