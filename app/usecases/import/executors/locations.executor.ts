/**
 * Executor de LOCALIZAÇÕES — recebe um plano (itens já normalizados pelo
 * mapper, com pais ANTES dos filhos quando hierárquico) e cria via
 * `LocationUseCase.create` (código único por tenant + validação de pai).
 *
 * dryRun=true (prévia): zero escritas — só classifica criar/já-existe.
 * Idempotente: código já existente ⇒ reuse/skip (nunca duplica).
 */

import prisma from "../../../lib/prisma";
import { LocationUseCase } from "../../location.usercase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "../import.types";
import { mapVaaptLocations } from "../mappers/vaapt-localizacoes.mapper";
import { mapWdLocations } from "../mappers/wd-localizacoes.mapper";
import { fileOfKind } from "../import-detector";

export interface LocationPlanItem {
  /** Código final (Vaapt: flat sem espaços; WebDesmonte: caminho " > "). */
  code: string;
  description?: string;
  maxCapacity?: number;
  /** Código do pai (mesma convenção do `code`); null = raiz/plana. */
  parentCode?: string | null;
  linha?: number;
}

export interface LocationExecDeps {
  /** `createLean`: mesmas validações do create, projeções mínimas (egress). */
  locationUseCase: Pick<LocationUseCase, "createLean">;
  /** Preload read-only dos códigos existentes do tenant. */
  loadExistingCodes: (
    userId: string,
  ) => Promise<Array<{ id: string; code: string }>>;
  /** Lookup pontual (caminho de corrida) — evita recarregar o preload. */
  findIdByCode?: (
    userId: string,
    code: string,
  ) => Promise<{ id: string } | null>;
}

export const defaultLocationDeps: LocationExecDeps = {
  locationUseCase: new LocationUseCase(),
  loadExistingCodes: (userId) =>
    prisma.location.findMany({
      where: { userId },
      select: { id: true, code: true },
    }),
  findIdByCode: (userId, code) =>
    prisma.location.findFirst({
      where: { userId, code },
      select: { id: true },
    }),
};

/**
 * Cria as localizações do plano (pais antes dos filhos) e devolve o mapa
 * code → id (ids "dry-*" na prévia), usado pelos executores de vínculo.
 */
export async function executeLocationPlan(
  ctx: ImportContext,
  report: ImportReport,
  items: LocationPlanItem[],
  deps: LocationExecDeps = defaultLocationDeps,
): Promise<Map<string, string>> {
  const existing = await deps.loadExistingCodes(ctx.targetUserId);
  const codeToId = new Map(existing.map((l) => [l.code, l.id]));
  bump(report, "localizacoes_no_plano", items.length);

  let processadas = 0;
  for (const item of items) {
    processadas++;
    if (processadas % 25 === 0 || processadas === items.length) {
      ctx.onProgress?.({
        fase: "localizacoes",
        processadas,
        total: items.length,
      });
    }

    if (codeToId.has(item.code)) {
      bump(report, "ja_existiam");
      continue;
    }

    const parentId = item.parentCode
      ? (codeToId.get(item.parentCode) ?? null)
      : null;
    if (item.parentCode && !parentId) {
      // Pai não resolvido = plano malformado (mapper deve ordenar pais antes).
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Localização "${item.code}": pai "${item.parentCode}" não encontrado`,
      });
      continue;
    }

    if (ctx.dryRun) {
      bump(report, "a_criar");
      codeToId.set(item.code, `<dry-loc-${item.code}>`);
      addSample(report, {
        code: item.code,
        description: item.description ?? null,
        maxCapacity: item.maxCapacity ?? 0,
        pai: item.parentCode ?? null,
      });
      continue;
    }

    try {
      const created = await deps.locationUseCase.createLean({
        userId: ctx.targetUserId,
        code: item.code,
        description: item.description,
        maxCapacity: item.maxCapacity ?? 0,
        // parentId com id "dry" nunca acontece aqui (apply não gera dry ids).
        parentId: parentId ?? undefined,
      });
      codeToId.set(item.code, created.id);
      bump(report, "criadas");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Corrida benigna (código criado entre o preload e o create) ⇒ skip;
      // resolve o id com lookup PONTUAL (não recarrega o preload inteiro).
      if (/existe/i.test(msg)) {
        bump(report, "ja_existiam");
        const again = deps.findIdByCode
          ? await deps.findIdByCode(ctx.targetUserId, item.code)
          : await deps
              .loadExistingCodes(ctx.targetUserId)
              .then((all) => all.find((l) => l.code === item.code) ?? null);
        if (again) codeToId.set(item.code, again.id);
        continue;
      }
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Localização "${item.code}": ${msg}`,
      });
    }
  }

  ctx.onProgress?.({
    fase: "localizacoes",
    processadas: items.length,
    total: items.length,
  });
  return codeToId;
}

/** Runner VAAPT/LOCALIZACOES — localizações planas do arquivo de peças. */
export async function runVaaptLocations(
  ctx: ImportContext,
  deps: LocationExecDeps = defaultLocationDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "VAAPT_PECAS");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo de peças/localização (Vaapt) não encontrado.",
    );
  }
  const report = newReport("VAAPT", "LOCALIZACOES", ctx.targetUserId, ctx.dryRun);
  const mapped = mapVaaptLocations(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "linhas_sem_localizacao", mapped.rowsWithoutLocation);
  bump(report, "localizacoes_distintas", mapped.items.length);
  await executeLocationPlan(ctx, report, mapped.items, deps);
  return report;
}

/** Runner WEBDESMONTE/LOCALIZACOES — árvore de locations.csv (Level asc). */
export async function runWdLocations(
  ctx: ImportContext,
  deps: LocationExecDeps = defaultLocationDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "WD_LOCATIONS");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo locations.csv (WebDesmonte) não encontrado.",
    );
  }
  const report = newReport(
    "WEBDESMONTE",
    "LOCALIZACOES",
    ctx.targetUserId,
    ctx.dryRun,
  );
  const mapped = mapWdLocations(file);
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "linhas_invalidas", mapped.invalidRows);
  bump(report, "localizacoes_distintas", mapped.items.length);
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
  await executeLocationPlan(ctx, report, mapped.items, deps);
  return report;
}
