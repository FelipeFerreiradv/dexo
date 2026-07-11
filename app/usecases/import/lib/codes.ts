/**
 * Normalização de códigos/caminhos de localização — DUAS variantes distintas,
 * cada uma fiel ao script de migração do respectivo sistema (a consistência
 * byte-a-byte preserva a idempotência com tenants já migrados via CLI):
 *
 * - Vaapt (plana): `normalizeCodeFlat` = upper + REMOVE todos os espaços
 *   ("Local 44 - Caixa 9" → "LOCAL44-CAIXA9") — scripts/migracao-vaapt.ts.
 * - WebDesmonte (hierárquica): `normPath` = split ">", colapsa espaços
 *   internos, junta " > ", upper ("Galpão > cx 2" → "GALPÃO > CX 2") —
 *   scripts/migracao-webdesmonte.ts.
 */

import { asString } from "./normalize";

/** Vaapt: código plano (upper, sem espaços). */
export function normalizeCodeFlat(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  return s.toUpperCase().replace(/\s+/g, "");
}

/** WebDesmonte: caminho hierárquico normalizado (" > " uniforme, upper). */
export function normPath(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const parts = s
    .split(">")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  return parts.length ? parts.join(" > ").toUpperCase() : null;
}

/** Segmentos de um caminho " > " já normalizado (p/ criar pais antes). */
export function pathSegments(path: string): string[] {
  return path
    .split(">")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Caminhos cumulativos de um path: "A > B > C" → ["A", "A > B", "A > B > C"]. */
export function cumulativePaths(path: string): string[] {
  const segs = pathSegments(path);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    out.push(segs.slice(0, i + 1).join(" > "));
  }
  return out;
}
