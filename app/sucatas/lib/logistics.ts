import {
  Truck,
  MapPin,
  Wrench,
  PackageCheck,
  type LucideIcon,
} from "lucide-react";

// Status logístico/físico do veículo no pátio (pipeline de desmembramento).
// Espelha o enum LogisticsStatus do Prisma. ORTOGONAL ao ScrapStatus (inventário).
export type LogisticsStatus = "IN_TRANSIT" | "IN_YARD" | "ON_LIFT" | "DISMANTLED";

export interface LogisticsStageConfig {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Classe de cor (chip/badge) — mesma paleta do design system. */
  badgeClass: string;
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
    available: false,
  },
  IN_YARD: {
    label: "No Pátio",
    description: "Chegou, veículo inteiro",
    icon: MapPin,
    badgeClass:
      "border-transparent bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    available: true,
  },
  ON_LIFT: {
    label: "No Elevador",
    description: "Em desmontagem ativa",
    icon: Wrench,
    badgeClass:
      "border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
    available: true,
  },
  DISMANTLED: {
    label: "Desmembrado",
    description: "Concluído, peças cadastradas",
    icon: PackageCheck,
    badgeClass:
      "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    available: true,
  },
};

export function isValidLogisticsStatus(v: unknown): v is LogisticsStatus {
  return typeof v === "string" && (LOGISTICS_ORDER as string[]).includes(v);
}
