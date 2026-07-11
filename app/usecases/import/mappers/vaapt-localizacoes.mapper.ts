/**
 * Localizações do Vaapt — derivadas do arquivo-ponte de peças (coluna
 * "Localizacao", texto livre plano, ex.: "Local 44 - Caixa 9", "LOCAL 1").
 * A localização Vaapt NÃO tem hierarquia: cada texto distinto vira uma
 * Location plana com `code = normalizeCodeFlat(texto)` e `description` =
 * texto original — exatamente como resolveLocationId de
 * scripts/migracao-vaapt.ts (idempotência com tenants já migrados via CLI).
 */

import type { DetectedFile } from "../import.types";
import { normalizeCodeFlat } from "../lib/codes";
import { asString } from "../lib/normalize";
import type { LocationPlanItem } from "../executors/locations.executor";

export interface VaaptLocationsMapResult {
  items: LocationPlanItem[];
  /** Linhas do arquivo (informativo). */
  totalRows: number;
  /** Linhas com "Localizacao" vazia (não é erro — peça sem localização). */
  rowsWithoutLocation: number;
}

export function mapVaaptLocations(
  file: DetectedFile,
): VaaptLocationsMapResult {
  const byCode = new Map<string, LocationPlanItem>();
  let rowsWithoutLocation = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const raw = asString(file.get(file.rows[i], "Localizacao"));
    if (!raw) {
      rowsWithoutLocation++;
      continue;
    }
    const code = normalizeCodeFlat(raw);
    if (!code) {
      rowsWithoutLocation++;
      continue;
    }
    if (!byCode.has(code)) {
      byCode.set(code, {
        code,
        description: raw,
        maxCapacity: 0, // 0 = sem limite (a checagem só liga com > 0)
        parentCode: null,
        linha: i + 1,
      });
    }
  }

  return {
    items: Array.from(byCode.values()),
    totalRows: file.rows.length,
    rowsWithoutLocation,
  };
}
