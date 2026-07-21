// Núcleo PURO (sem React/DOM/fetch) da decisão do scan de QR de localização
// nos modais de criar/editar produto. Espelha as regras do LocationCombobox
// (bloqueio de lotada com isenção da já selecionada) e as mensagens do
// handleLocationScan (scan-receive-flow). Mantido separado do componente para
// ser testável em ambiente node (sem jsdom) — o componente importa daqui.

import type { LocationSelectItem } from "./location-select-filter";

/** Subconjunto relevante do JSON de `GET /scan/resolve` (200 ou 404). */
export interface ScanResolveData {
  kind?: "location" | "product" | "unknown";
  error?: string;
  location?: {
    id: string;
    code: string;
    description?: string | null;
    maxCapacity: number;
    productsCount: number;
    isFull: boolean;
  };
  product?: { id: string };
}

export type LocationScanDecision =
  | { type: "select"; id: string; code: string; fullPath: string }
  | { type: "reject"; message: string; tone: "error" | "warning" };

/**
 * Decide o que fazer com a resposta do `/scan/resolve` quando o esperado é uma
 * localização. `currentLocationId` é o valor VIVO de `locationId` no form: uma
 * localização lotada só é aceita se for a já selecionada (mesma isenção do
 * combobox). O `fullPath` vem das `options` já carregadas (`/locations/select`
 * devolve o tenant inteiro); se a localização não estiver lá (criada depois de
 * abrir o modal), caímos para o `code` — o submit continua correto (FK+texto).
 */
export function decideLocationScan(
  data: ScanResolveData | null | undefined,
  options: LocationSelectItem[],
  currentLocationId: string | null,
): LocationScanDecision {
  if (data?.kind === "product") {
    return {
      type: "reject",
      tone: "error",
      message: "Esse é um QR de produto — escaneie o QR de uma localização.",
    };
  }
  if (data?.kind === "location") {
    const loc = data.location;
    if (!loc) {
      // 404 do resolve: corpo { error, kind: "location" }.
      return {
        type: "reject",
        tone: "error",
        message: data.error || "Localização não encontrada",
      };
    }
    if (loc.isFull && loc.id !== currentLocationId) {
      return {
        type: "reject",
        tone: "warning",
        message: `Localização "${loc.code}" está lotada (${loc.productsCount}/${loc.maxCapacity}).`,
      };
    }
    const fullPath =
      options.find((o) => o.id === loc.id)?.fullPath ?? loc.code;
    return { type: "select", id: loc.id, code: loc.code, fullPath };
  }
  return {
    type: "reject",
    tone: "error",
    message: "QR não reconhecido como localização.",
  };
}
