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
import { runVaaptLocations } from "./executors/locations.executor";

export type ImportRunner = (ctx: ImportContext) => Promise<ImportReport>;

const RUNNERS: Partial<Record<`${ImportSystem}/${ImportEntity}`, ImportRunner>> =
  {
    "VAAPT/LOCALIZACOES": runVaaptLocations,
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
