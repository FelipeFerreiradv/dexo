import {
  Truck,
  MapPin,
  Wrench,
  PackageCheck,
  type LucideIcon,
} from "lucide-react";

// Status logístico/físico do veículo no pátio (pipeline de desmembramento).
// Espelha o enum LogisticsStatus do Prisma. ORTOGONAL ao ScrapStatus (inventário).
export type LogisticsStatus =
  "IN_TRANSIT" | "IN_YARD" | "ON_LIFT" | "DISMANTLED";

export interface LogisticsStageConfig {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Classe de cor (chip/badge) — mesma paleta do design system. */
  badgeClass: string;
  /** Cor sólida da barra-acento (spine) da coluna e do card do pipeline. */
  spine: string;
  /** Banho sutil de cor no fundo do card (tinta do estágio, bem leve). */
  cardBg: string;
  /** Peça já disponível para retirada (≠ Em Trânsito). Usado na busca do vendedor (F6). */
  available: boolean;
}

// Ordem do fluxo: Trânsito → Pátio → Elevador → Desmembrado.
export const LOGISTICS_ORDER: LogisticsStatus[] = [
  "IN_TRANSIT",
  "IN_YARD",
  "ON_LIFT",
  "DISMANTLED",
];

export const LOGISTICS_CONFIG: Record<LogisticsStatus, LogisticsStageConfig> = {
  IN_TRANSIT: {
    label: "Em Trânsito",
    description: "Arrematado, em deslocamento",
    icon: Truck,
    badgeClass:
      "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    spine: "bg-amber-400",
    cardBg: "bg-amber-50/70 dark:bg-amber-950/15",
    available: false,
  },
  IN_YARD: {
    label: "No Pátio",
    description: "Chegou, veículo inteiro",
    icon: MapPin,
    badgeClass:
      "border-transparent bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    spine: "bg-blue-500",
    cardBg: "bg-blue-50/70 dark:bg-blue-950/15",
    available: true,
  },
  ON_LIFT: {
    label: "No Elevador",
    description: "Em desmontagem ativa",
    icon: Wrench,
    badgeClass:
      "border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
    spine: "bg-violet-500",
    cardBg: "bg-violet-50/70 dark:bg-violet-950/15",
    available: true,
  },
  DISMANTLED: {
    label: "Desmembrado",
    description: "Concluído, peças cadastradas",
    icon: PackageCheck,
    badgeClass:
      "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    spine: "bg-emerald-500",
    cardBg: "bg-emerald-50/70 dark:bg-emerald-950/15",
    available: true,
  },
};

export function isValidLogisticsStatus(v: unknown): v is LogisticsStatus {
  return typeof v === "string" && (LOGISTICS_ORDER as string[]).includes(v);
}

// Cor de pintura do veículo → hex (para o swatch do card). Cobre os nomes mais
// comuns e derivados ("AZUL METÁLICO" → AZUL). Retorna null quando desconhecida.
const PAINT_COLORS: Array<[string, string]> = [
  ["PRETO", "#141414"],
  ["BRANCO", "#f4f2ec"],
  ["PRATA", "#c3c6cc"],
  ["CINZA", "#828a94"],
  ["VERMELHO", "#c0392b"],
  ["AZUL", "#2f5c8a"],
  ["VERDE", "#2c5f4f"],
  ["AMARELO", "#f2c419"],
  ["DOURADO", "#c9a227"],
  ["MARROM", "#6b4423"],
  ["BEGE", "#d8cbb0"],
  ["LARANJA", "#d35400"],
  ["VINHO", "#6d1f2e"],
  ["ROSA", "#d98cae"],
  ["ROXO", "#6b3fa0"],
  ["FANTASIA", "#9ca39c"],
];

export function paintColorHex(name?: string | null): string | null {
  if (!name) return null;
  const key = name.trim().toUpperCase();
  for (const [k, hex] of PAINT_COLORS) if (key.includes(k)) return hex;
  return null;
}
