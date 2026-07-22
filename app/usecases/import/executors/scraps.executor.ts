/**
 * Executor de SUCATAS — cria via `ScrapUseCase.create` (brand/model
 * obrigatórios; chassi/chave já saneados pelo mapper). Idempotência em
 * camadas:
 *
 * 1. marker em notes ("Import Dexo · veículo #N" / "· sucata #<wd>", e os
 *    legados "Legado <TENANT> · ..." dos scripts CLI) — chave primária;
 * 2. placa/chassi já existentes SEM marker ⇒ SKIP com aviso ("possível
 *    duplicata") — decisão de projeto: em re-execução num tenant que já teve
 *    migração manual, é mais seguro não criar do que duplicar.
 *
 * `logisticsStatus` = DISMANTLED (decisão do Felipe: sucata histórica cujas
 * peças já viraram estoque — não polui o pipeline logístico).
 */

import prisma from "../../../lib/prisma";
import { ScrapUseCase } from "../../scrap.usercase";
import type { ImportContext, ImportReport } from "../import.types";
import {
  ImportValidationError,
  addIssue,
  addSample,
  bump,
  newReport,
} from "../import.types";
import {
  parseScrapWdMarker,
  parseVehicleMarker,
} from "../lib/markers";
import { fileOfKind } from "../import-detector";
import { mapVaaptScraps, mapWdScraps } from "../mappers/sucatas.mapper";
import type { ScrapPlanItem, ScrapsMapResult } from "../mappers/sucatas.mapper";
import { mapWdLocations } from "../mappers/wd-localizacoes.mapper";

export interface ExistingScrapRef {
  id: string;
  notes: string | null;
  plate: string | null;
  chassis: string | null;
}

export interface ScrapsExecDeps {
  scrapUseCase: Pick<ScrapUseCase, "create">;
  loadExistingScraps: (userId: string) => Promise<ExistingScrapRef[]>;
  loadLocationCodes: (
    userId: string,
  ) => Promise<Array<{ id: string; code: string }>>;
}

export const defaultScrapsDeps: ScrapsExecDeps = {
  scrapUseCase: new ScrapUseCase(),
  loadExistingScraps: (userId) =>
    prisma.scrap.findMany({
      where: { userId },
      select: { id: true, notes: true, plate: true, chassis: true },
    }),
  loadLocationCodes: (userId) =>
    prisma.location.findMany({
      where: { userId },
      select: { id: true, code: true },
    }),
};

/**
 * Cria as sucatas do plano e devolve o mapa cod→id (ids "dry-*" na prévia),
 * consumido pelo vínculo de produtos.
 */
export async function executeScrapsPlan(
  ctx: ImportContext,
  report: ImportReport,
  items: ScrapPlanItem[],
  deps: ScrapsExecDeps = defaultScrapsDeps,
  /**
   * Mapa code→id vindo da fase de localizações da MESMA execução (modo
   * pacote/vínculos). Sem ele, resolve contra o banco — mas na PRÉVIA do
   * pacote as localizações ainda não existem no banco, e só o mapa (com os
   * ids "dry") evita avisos falsos de "localização não existe".
   */
  locCodeToIdFromRun?: Map<string, string>,
): Promise<Map<string, string>> {
  const existing = await deps.loadExistingScraps(ctx.targetUserId);
  const codToId = new Map<string, string>();
  const exPlate = new Map<string, string>();
  const exChassis = new Map<string, string>();
  for (const s of existing) {
    const cod = parseVehicleMarker(s.notes) ?? parseScrapWdMarker(s.notes);
    if (cod) codToId.set(cod, s.id);
    if (s.plate) exPlate.set(s.plate, s.id);
    if (s.chassis) exChassis.set(s.chassis, s.id);
  }

  // Resolve locationCode → id (só quando algum item traz localização).
  let locCodeToId: Map<string, string> | null = locCodeToIdFromRun ?? null;
  if (!locCodeToId && items.some((i) => i.locationCode)) {
    const codes = await deps.loadLocationCodes(ctx.targetUserId);
    locCodeToId = new Map(codes.map((c) => [c.code, c.id]));
  }

  bump(report, "sucatas_no_plano", items.length);

  let processadas = 0;
  for (const item of items) {
    processadas++;
    if (processadas % 25 === 0 || processadas === items.length) {
      ctx.onProgress?.({ fase: "sucatas", processadas, total: items.length });
    }

    if (codToId.has(item.cod)) {
      bump(report, "ja_existiam_marker");
      continue;
    }
    // Placa/chassi já no banco SEM marker deste código ⇒ possível duplicata.
    const dupId =
      (item.chassis && exChassis.get(item.chassis)) ||
      (item.plate && exPlate.get(item.plate)) ||
      null;
    if (dupId) {
      bump(report, "ja_existiam_placa_chassi");
      addIssue(report.avisos, {
        linha: item.linha,
        motivo: `Veículo ${item.brand} ${item.model} (${item.plate ?? item.chassis}): já existe sucata com a mesma placa/chassi — pulado (possível duplicata)`,
      });
      bump(report, "avisos");
      codToId.set(item.cod, dupId);
      continue;
    }

    let locationId: string | undefined;
    if (item.locationCode && locCodeToId) {
      locationId = locCodeToId.get(item.locationCode);
      if (!locationId) {
        addIssue(report.avisos, {
          linha: item.linha,
          motivo: `Sucata ${item.cod}: localização "${item.locationCode}" não existe no Dexo — importe as localizações antes`,
        });
        bump(report, "avisos");
      } else if (ctx.dryRun && locationId.startsWith("<dry-")) {
        // Prévia do pacote: a localização será criada na mesma execução —
        // conta como resolvida, mas não passa id fake ao create (que nem
        // roda em dry-run).
        locationId = undefined;
        bump(report, "localizacao_resolvida_na_execucao");
      }
    }

    if (ctx.dryRun) {
      bump(report, "a_criar");
      codToId.set(item.cod, `<dry-scrap-${item.cod}>`);
      // A prévia também "reserva" placa/chassi, como o ramo de escrita faz —
      // senão dois veículos da MESMA planilha com a mesma placa contam 2 a
      // criar e o apply cria só 1 (a prévia prometia mais do que entrega).
      if (item.plate) exPlate.set(item.plate, `<dry-scrap-${item.cod}>`);
      if (item.chassis) exChassis.set(item.chassis, `<dry-scrap-${item.cod}>`);
      addSample(report, {
        marca: item.brand,
        modelo: item.model,
        placa: item.plate ?? null,
        chassi: item.chassis ?? null,
        lote: item.lot ?? null,
        custo: item.cost ?? null,
      });
      continue;
    }

    try {
      const created = await deps.scrapUseCase.create({
        userId: ctx.targetUserId,
        brand: item.brand,
        model: item.model,
        year: item.year ?? undefined,
        version: item.version ?? undefined,
        color: item.color ?? undefined,
        plate: item.plate ?? undefined,
        chassis: item.chassis ?? undefined,
        lot: item.lot ?? undefined,
        deregistrationCert: item.deregistrationCert ?? undefined,
        cost: item.cost ?? undefined,
        ncm: item.ncm ?? undefined,
        accessKey: item.accessKey ?? undefined,
        nfeNumber: item.nfeNumber ?? undefined,
        nfeSeries: item.nfeSeries ?? undefined,
        renavam: item.renavam ?? undefined,
        engineNumber: item.engineNumber ?? undefined,
        entryDate: item.entryDate ?? undefined,
        locationId,
        status: "AVAILABLE",
        logisticsStatus: "DISMANTLED",
        notes: item.notes,
      });
      codToId.set(item.cod, created.id);
      if (item.plate) exPlate.set(item.plate, created.id);
      if (item.chassis) exChassis.set(item.chassis, created.id);
      bump(report, "criadas");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bump(report, "erros");
      addIssue(report.erros, {
        linha: item.linha,
        motivo: `Sucata ${item.brand} ${item.model} (#${item.cod}): ${msg}`,
      });
    }
  }

  ctx.onProgress?.({
    fase: "sucatas",
    processadas: items.length,
    total: items.length,
  });
  return codToId;
}

function applyMapCounters(report: ImportReport, mapped: ScrapsMapResult): void {
  bump(report, "linhas_no_arquivo", mapped.totalRows);
  bump(report, "linhas_invalidas", mapped.invalidRows);
  // Só aparece quando houve repetição (o export com uma linha por foto),
  // para não poluir o relatório dos exports normais com um contador zerado.
  if (mapped.duplicateRows) {
    bump(report, "linhas_repetidas_mesmo_veiculo", mapped.duplicateRows);
  }
  for (const aviso of mapped.avisos) {
    bump(report, "avisos");
    addIssue(report.avisos, aviso);
  }
}

/** Runner VAAPT/SUCATAS (Backup Veiculos — condicional ao arquivo existir). */
export async function runVaaptScraps(
  ctx: ImportContext,
  deps: ScrapsExecDeps = defaultScrapsDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "VAAPT_VEICULOS");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo de veículos (Vaapt) não encontrado.",
    );
  }
  const report = newReport("VAAPT", "SUCATAS", ctx.targetUserId, ctx.dryRun);
  const mapped = mapVaaptScraps(file);
  applyMapCounters(report, mapped);
  await executeScrapsPlan(ctx, report, mapped.items, deps);
  return report;
}

/** Runner WEBDESMONTE/SUCATAS (purchase_waste.csv + locations.csv opcional). */
export async function runWdScraps(
  ctx: ImportContext,
  deps: ScrapsExecDeps = defaultScrapsDeps,
): Promise<ImportReport> {
  const file = fileOfKind(ctx.files, "WD_PURCHASE_WASTE");
  if (!file) {
    throw new ImportValidationError(
      "Arquivo purchase_waste.csv (WebDesmonte) não encontrado.",
    );
  }
  const report = newReport("WEBDESMONTE", "SUCATAS", ctx.targetUserId, ctx.dryRun);
  const locationsFile = fileOfKind(ctx.files, "WD_LOCATIONS");
  const guidToCode = locationsFile
    ? mapWdLocations(locationsFile).guidToCode
    : undefined;
  const mapped = mapWdScraps(file, guidToCode);
  applyMapCounters(report, mapped);
  await executeScrapsPlan(ctx, report, mapped.items, deps);
  return report;
}
