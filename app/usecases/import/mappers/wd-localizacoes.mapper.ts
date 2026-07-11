/**
 * Localizações do WebDesmonte (locations.csv, 21 colunas) — HIERÁRQUICAS:
 * `InitialsPath` = caminho completo ("GALPÃO > PRATELEIRA 1 > CAIXA 22"),
 * `ParentId` = GUID do pai, `Level` = profundidade. Ordena por Level asc
 * (pais antes dos filhos) e resolve o pai pelo mapa GUID→code, exatamente
 * como phaseLocations de scripts/migracao-webdesmonte.ts — com UMA correção
 * de gap: o script NÃO mapeava `MaxQuantity`; aqui ela vira `maxCapacity`
 * (0 = sem limite; a checagem de capacidade só liga com > 0).
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import { normPath } from "../lib/codes";
import { asInt, asString } from "../lib/normalize";
import type { LocationPlanItem } from "../executors/locations.executor";

export interface WdLocationsMapResult {
  items: LocationPlanItem[];
  /** GUID do WebDesmonte → code Dexo (consumido por sucatas/vínculos). */
  guidToCode: Map<string, string>;
  totalRows: number;
  invalidRows: number;
  avisos: ImportRowIssue[];
}

export function mapWdLocations(file: DetectedFile): WdLocationsMapResult {
  const avisos: ImportRowIssue[] = [];
  const guidToCode = new Map<string, string>();
  let invalidRows = 0;

  // 1ª passada: GUID → code (o pai pode aparecer depois do filho no CSV).
  const rowsWithMeta: Array<{
    linha: number;
    level: number;
    guid: string;
    code: string;
    description: string;
    maxCapacity: number;
    parentGuid: string | null;
  }> = [];
  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const guid = asString(get("Id"));
    const code = normPath(get("InitialsPath")) ?? normPath(get("Initials"));
    if (!guid || !code) {
      invalidRows++;
      addIssue(avisos, {
        linha: i + 1,
        motivo: "Localização sem Id ou sem Initials/InitialsPath — ignorada",
      });
      continue;
    }
    guidToCode.set(guid, code);
    const rawCapacity = asInt(get("MaxQuantity"));
    rowsWithMeta.push({
      linha: i + 1,
      level: asInt(get("Level")) ?? 0,
      guid,
      code,
      description: asString(get("Description")) ?? asString(get("Initials")) ?? code,
      maxCapacity: rawCapacity !== null && rawCapacity > 0 ? rawCapacity : 0,
      parentGuid: asString(get("ParentId")),
    });
  }

  // 2ª passada: ordena por Level asc e resolve parentCode pelo mapa.
  rowsWithMeta.sort((a, b) => a.level - b.level);
  const items: LocationPlanItem[] = [];
  const seenCodes = new Set<string>();
  for (const r of rowsWithMeta) {
    if (seenCodes.has(r.code)) {
      // Dois GUIDs com o mesmo caminho normalizado — o 1º vence (o mapa
      // guidToCode já aponta ambos para o mesmo code/Location).
      continue;
    }
    seenCodes.add(r.code);
    let parentCode: string | null = null;
    if (r.parentGuid) {
      parentCode = guidToCode.get(r.parentGuid) ?? null;
      if (!parentCode) {
        addIssue(avisos, {
          linha: r.linha,
          motivo: `Localização "${r.code}": ParentId não encontrado no arquivo — criada como raiz`,
        });
      }
    }
    items.push({
      code: r.code,
      description: r.description,
      maxCapacity: r.maxCapacity,
      parentCode,
      linha: r.linha,
    });
  }

  return {
    items,
    guidToCode,
    totalRows: file.rows.length,
    invalidRows,
    avisos,
  };
}
