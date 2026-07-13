/**
 * Sucatas (veículos) — dois formatos de origem, um plano comum:
 *
 * - Vaapt: "Backup Veiculos - <N>.xlsx" ("# Codigo Veiculo, Marca, Modelo,
 *   Chassi, Placa, Apelido, Cor, Ano modelo, Valor da compra"). Pode NÃO vir
 *   no pacote — a entidade é condicional ao arquivo. Espelha phase1Scraps de
 *   scripts/migracao-vaapt.ts.
 * - WebDesmonte: purchase_waste.csv (44 colunas ricas, com bloco fiscal).
 *   Espelha phaseScraps de scripts/migracao-webdesmonte.ts.
 *
 * Regra do chassi (decisão de projeto): o ScrapUseCase exige 17 alfanuméricos
 * exatos QUANDO preenchido — chassi sujo/incompleto é gravado como NULO com
 * AVISO na linha; a linha nunca é derrubada por chassi ruim.
 */

import type { DetectedFile, ImportRowIssue } from "../import.types";
import { addIssue } from "../import.types";
import {
  asNumber,
  asString,
  cleanChassis,
  cleanPlate,
  onlyDigits,
  parseFlexibleDate,
} from "../lib/normalize";
import { importScrapWdMarker, importVehicleMarker } from "../lib/markers";

export interface ScrapPlanItem {
  linha: number;
  /** Chave do marker de idempotência (cod Vaapt ou GUID WebDesmonte). */
  cod: string;
  brand: string;
  model: string;
  year?: string | null;
  version?: string | null;
  color?: string | null;
  plate?: string | null;
  chassis?: string | null;
  lot?: string | null;
  deregistrationCert?: string | null;
  cost?: number | null;
  ncm?: string | null;
  accessKey?: string | null;
  nfeNumber?: string | null;
  nfeSeries?: string | null;
  renavam?: string | null;
  engineNumber?: string | null;
  entryDate?: Date | null;
  /** Code da localização (WebDesmonte; resolvido pelo executor). */
  locationCode?: string | null;
  notes: string;
}

export interface ScrapsMapResult {
  items: ScrapPlanItem[];
  totalRows: number;
  invalidRows: number;
  avisos: ImportRowIssue[];
}

/** Chassi: limpo E com 17 exatos, senão null + aviso (linha nunca cai). */
function chassisOrWarn(
  raw: unknown,
  linha: number,
  avisos: ImportRowIssue[],
): string | null {
  const original = asString(raw);
  if (!original) return null;
  const cleaned = cleanChassis(original);
  if (cleaned && cleaned.length === 17) return cleaned;
  addIssue(avisos, {
    linha,
    motivo: `Chassi "${original}" inválido (esperado 17 alfanuméricos) — sucata gravada sem chassi`,
  });
  return null;
}

export function mapVaaptScraps(file: DetectedFile): ScrapsMapResult {
  const items: ScrapPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenCod = new Set<string>();
  const seenChassis = new Set<string>();
  let invalidRows = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const cod = asString(get("# Codigo Veiculo"));
    if (!cod) {
      invalidRows++;
      addIssue(avisos, { linha, motivo: "Linha sem '# Codigo Veiculo' — ignorada" });
      continue;
    }
    if (seenCod.has(cod)) {
      invalidRows++;
      continue;
    }
    seenCod.add(cod);

    const chassis = chassisOrWarn(get("Chassi"), linha, avisos);
    if (chassis) {
      if (seenChassis.has(chassis)) {
        addIssue(avisos, {
          linha,
          motivo: `Chassi ${chassis} repetido na planilha (dois veículos com o mesmo chassi na origem)`,
        });
      }
      seenChassis.add(chassis);
    }

    items.push({
      linha,
      cod,
      brand: asString(get("Marca")) ?? "INDEFINIDO",
      model: asString(get("Modelo")) ?? "INDEFINIDO",
      year: asString(get("Ano modelo")),
      version: asString(get("Apelido")),
      color: asString(get("Cor")),
      plate: cleanPlate(get("Placa")),
      chassis,
      cost: asNumber(get("Valor da compra")),
      notes: importVehicleMarker(cod),
    });
  }

  return { items, totalRows: file.rows.length, invalidRows, avisos };
}

export function mapWdScraps(
  file: DetectedFile,
  /** GUID→code das localizações (de locations.csv, quando enviado junto). */
  locationGuidToCode?: Map<string, string>,
): ScrapsMapResult {
  const items: ScrapPlanItem[] = [];
  const avisos: ImportRowIssue[] = [];
  const seenCod = new Set<string>();
  let invalidRows = 0;

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    const get = (label: string) => file.get(row, label);
    const linha = i + 1;

    const cod = asString(get("Id"));
    if (!cod) {
      invalidRows++;
      addIssue(avisos, { linha, motivo: "Linha sem Id — ignorada" });
      continue;
    }
    if (seenCod.has(cod)) {
      invalidRows++;
      continue;
    }
    seenCod.add(cod);

    // Chave de acesso da NF-e de entrada: o ScrapUseCase exige 44 dígitos
    // quando preenchida — inválida vira null + aviso (linha não cai).
    const accessRaw = asString(get("AccessKey"));
    let accessKey: string | null = null;
    if (accessRaw) {
      const digits = onlyDigits(accessRaw);
      if (digits.length === 44) accessKey = digits;
      else {
        addIssue(avisos, {
          linha,
          motivo: `Chave de acesso "${accessRaw}" inválida (esperado 44 dígitos) — gravada sem chave`,
        });
      }
    }

    const locGuid = asString(get("LocationId"));
    const locationCode = locGuid
      ? (locationGuidToCode?.get(locGuid) ?? null)
      : null;
    if (locGuid && !locationCode) {
      addIssue(avisos, {
        linha,
        motivo:
          "LocationId da sucata não resolvido (envie locations.csv junto para vincular a localização)",
      });
    }

    const lot = asString(get("Lot"));
    const infoAdd = asString(get("InfoAdd"));
    const notesParts = [importScrapWdMarker(cod)];
    if (lot) notesParts.push(`lote ${lot}`);
    if (infoAdd) notesParts.push(infoAdd);

    items.push({
      linha,
      cod,
      brand: asString(get("Brand")) ?? "INDEFINIDO",
      model: asString(get("Model")) ?? "INDEFINIDO",
      year: asString(get("Year")),
      color: asString(get("Color")),
      plate: cleanPlate(get("LicensePlate")),
      chassis: chassisOrWarn(get("Chassis"), linha, avisos),
      lot,
      deregistrationCert: asString(get("CertidaoBaixaVeiculo")),
      cost: asNumber(get("PurchaseValue")),
      ncm: asString(get("Ncm")),
      accessKey,
      nfeNumber: asString(get("NfeNumber")),
      nfeSeries: asString(get("NfeSeries")),
      renavam: asString(get("Renavam")),
      engineNumber: asString(get("EngineNumber")),
      entryDate: parseFlexibleDate(get("EntryDate")),
      locationCode,
      notes: notesParts.join(" · "),
    });
  }

  return { items, totalRows: file.rows.length, invalidRows, avisos };
}
