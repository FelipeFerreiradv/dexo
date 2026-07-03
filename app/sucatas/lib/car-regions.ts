// Mapeamento peça → região do carro (Chevrolet Impala '67, vista lateral) e
// cálculo do progresso de "pintura" da sucata. Puro (sem estado/efeitos):
// derivado 100% no cliente a partir das peças de `getScrapParts`, sem backend
// novo e sem migração. Uma peça conta como vendida quando `status === "SOLD"`.

import { normalizeTerm } from "@/app/repositories/product-search-terms";

export type CarRegion =
  | "motor"
  | "capo"
  | "para_brisa"
  | "teto"
  | "vidro_lateral"
  | "para_choque_diant"
  | "para_lama_diant"
  | "roda_diant"
  | "porta_diant"
  | "porta_tras"
  | "cabine"
  | "para_lama_tras"
  | "roda_tras"
  | "porta_malas"
  | "para_choque_tras"
  | "farol"
  | "lanterna";

// Rótulos legíveis (acessibilidade / tooltip do desenho).
export const CAR_REGION_LABELS: Record<CarRegion, string> = {
  motor: "Motor / câmbio",
  capo: "Capô",
  para_brisa: "Para-brisa",
  teto: "Teto",
  vidro_lateral: "Vidros laterais",
  para_choque_diant: "Para-choque dianteiro",
  para_lama_diant: "Paralama dianteiro",
  roda_diant: "Roda dianteira",
  porta_diant: "Porta dianteira",
  porta_tras: "Porta traseira",
  cabine: "Cabine / interior",
  para_lama_tras: "Paralama traseiro",
  roda_tras: "Roda traseira",
  porta_malas: "Porta-malas",
  para_choque_tras: "Para-choque traseiro",
  farol: "Farol",
  lanterna: "Lanterna",
};

// "Compact": remove acento/caixa (via normalizeTerm) E separadores, para casar
// "para-choque", "para choque" e "parachoque" de forma idêntica.
function compact(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeTerm(value).replace(/[^a-z0-9]/g, "");
}

/**
 * Infere a região do carro a partir do nome (+ part number) da peça.
 *
 * A ordem das checagens importa para evitar colisão de radicais:
 * `capota`→teto antes de `capo`; `portamalas` antes de `porta`; `parabrisa`
 * antes de `vidro`. Posição (dianteira/traseira) só é consultada para as
 * famílias posicionais (porta/para-choque/paralama/roda). Sem lado explícito,
 * escolhe o membro DIANTEIRO da família (default documentado). Sem match →
 * `null` (a peça conta no total, mas não acende região).
 */
export function inferCarRegion(part: {
  name?: string;
  partNumber?: string;
}): CarRegion | null {
  const c = compact(`${part.name ?? ""} ${part.partNumber ?? ""}`);
  if (!c) return null;

  const has = (...keywords: string[]) => keywords.some((k) => c.includes(k));
  const rear = /traseir|tras/.test(c);

  // "motor" mas não "motorista" (banco do motorista → cabine, não motor).
  if (/motor(?!ista)/.test(c) || has("cambio", "transmissao", "virabrequim", "cabecote", "bloco", "carter", "biela"))
    return "motor";
  if (has("teto", "capota", "tetosolar")) return "teto";
  if (has("capo", "tampadianteira", "tampamotor")) return "capo";
  if (has("parabrisa", "vidrodianteiro", "vidrofrontal")) return "para_brisa";
  if (has("portamalas", "tampatraseira", "tampaportamalas")) return "porta_malas";
  if (has("farol", "farois")) return "farol";
  if (has("lanterna", "lampadatraseira", "luzdefreio")) return "lanterna";
  if (has("vidro", "janela", "vigia")) return "vidro_lateral";
  if (has("parachoque")) return rear ? "para_choque_tras" : "para_choque_diant";
  if (has("paralama", "guardalama")) return rear ? "para_lama_tras" : "para_lama_diant";
  // "aro" foi removido de propósito: colide com "reparo"/"faro" no modo compact.
  if (has("roda", "pneu", "cubo", "calota", "estepe")) return rear ? "roda_tras" : "roda_diant";
  if (has("porta")) return rear ? "porta_tras" : "porta_diant";
  if (has("banco", "painel", "volante", "coluna", "interior", "forro", "cinto", "estofamento"))
    return "cabine";

  return null;
}

export interface ScrapPaintPart {
  name?: string;
  partNumber?: string;
  status: "IN_STOCK" | "SOLD";
}

export interface ScrapPaintResult {
  soldCount: number; // peças com status "SOLD"
  totalCount: number; // total de peças da sucata
  percent: number; // Math.round(soldCount / totalCount * 100), 0 se total 0
  unmappedCount: number; // peças que não casam com nenhuma região do desenho
  soldRegions: Set<CarRegion>; // regiões acesas (≥1 peça mapeada vendida)
  soldByRegion: Map<CarRegion, number>; // nº de peças vendidas por região
}

/**
 * Calcula o progresso de pintura da sucata. O `percent` é POR PEÇAS VENDIDAS
 * (independente do mapeamento de regiões): 100% = todas vendidas → carro
 * inteiro amarelo. Uma região acende assim que ≥1 peça mapeada para ela está
 * vendida.
 */
export function computeScrapPaint(
  parts: ReadonlyArray<ScrapPaintPart>,
): ScrapPaintResult {
  const totalCount = parts.length;
  let soldCount = 0;
  let unmappedCount = 0;
  const soldRegions = new Set<CarRegion>();
  const soldByRegion = new Map<CarRegion, number>();

  for (const p of parts) {
    const region = inferCarRegion(p);
    if (region === null) unmappedCount++;
    if (p.status === "SOLD") {
      soldCount++;
      if (region) {
        soldRegions.add(region);
        soldByRegion.set(region, (soldByRegion.get(region) ?? 0) + 1);
      }
    }
  }

  const percent =
    totalCount > 0 ? Math.round((soldCount / totalCount) * 100) : 0;

  return {
    soldCount,
    totalCount,
    percent,
    unmappedCount,
    soldRegions,
    soldByRegion,
  };
}
