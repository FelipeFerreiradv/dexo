/**
 * Registry (sistema, entidade) → runner. Cada runner é `(ctx) => report` e
 * roda o MESMO caminho no preview (dryRun=true, zero escritas) e no apply
 * (dryRun=false, dentro do job). Entidades são liberadas por fase de entrega
 * — as ausentes devolvem erro claro, nunca comportamento parcial.
 */

import type {
  ImportContext,
  ImportEntity,
  ImportReport,
  ImportSystem,
} from "./import.types";
import { ImportValidationError } from "./import.types";
import {
  runVaaptLocations,
  runWdLocations,
} from "./executors/locations.executor";
import {
  runVaaptCustomers,
  runWdCustomers,
} from "./executors/customers.executor";
import { runVaaptScraps, runWdScraps } from "./executors/scraps.executor";
import {
  runVaaptLinks,
  runWdLinks,
} from "./executors/product-links.executor";
import { runVaaptPhotos } from "./executors/product-photos.executor";
import { runVaaptPacote } from "./executors/vaapt-pacote.executor";
import { runWdPacote } from "./executors/wd-pacote.executor";
import { runContas } from "./executors/finance.executor";
import { runVaaptNfes, runIbrNfes } from "./nfe-import.usecase";
import { runIbrEstoque } from "./executors/ibr-estoque.executor";
import { runIbrPacote } from "./executors/ibr-pacote.executor";
import { runIbrsoftPacote } from "./executors/ibrsoft-pacote.executor";

export type ImportRunner = (ctx: ImportContext) => Promise<ImportReport>;

const RUNNERS: Partial<Record<`${ImportSystem}/${ImportEntity}`, ImportRunner>> =
  {
    "VAAPT/LOCALIZACOES": runVaaptLocations,
    "VAAPT/CLIENTES": runVaaptCustomers,
    "VAAPT/SUCATAS": runVaaptScraps,
    "VAAPT/VINCULOS": runVaaptLinks,
    "VAAPT/NFE": runVaaptNfes,
    "VAAPT/FOTOS": runVaaptPhotos,
    "VAAPT/PACOTE": runVaaptPacote,
    "WEBDESMONTE/LOCALIZACOES": runWdLocations,
    "WEBDESMONTE/CLIENTES": runWdCustomers,
    "WEBDESMONTE/SUCATAS": runWdScraps,
    "WEBDESMONTE/VINCULOS": runWdLinks,
    "WEBDESMONTE/PACOTE": runWdPacote,
    "DEXO/CONTAS": runContas,
    "IBR/ESTOQUE": runIbrEstoque,
    "IBR/NFE": runIbrNfes,
    "IBR/PACOTE": runIbrPacote,
    "IBRSOFT/PACOTE": runIbrsoftPacote,
  };

export function resolveRunner(
  system: ImportSystem,
  entity: ImportEntity,
): ImportRunner {
  const runner = RUNNERS[`${system}/${entity}`];
  if (!runner) {
    throw new ImportValidationError(
      `Importação de ${entity} (${system}) ainda não está disponível.`,
    );
  }
  return runner;
}

/** Há runner registrado para a combinação? (usado pela auto-detecção). */
export function isRunnerAvailable(
  system: ImportSystem,
  entity: ImportEntity,
): boolean {
  return !!RUNNERS[`${system}/${entity}`];
}

/** Entidades disponíveis por sistema (consumido pela UI do modal). */
export function availableEntities(): Array<{
  system: ImportSystem;
  entity: ImportEntity;
}> {
  return Object.keys(RUNNERS).map((key) => {
    const [system, entity] = key.split("/") as [ImportSystem, ImportEntity];
    return { system, entity };
  });
}
