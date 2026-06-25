/**
 * Presets de período compartilhados pelos botões de relatório (Dashboard e
 * Financeiro). Mesma semântica do bloco de Colaboradores: presets rápidos +
 * "Personalizado" (datas De/Até). Datas no formato "YYYY-MM-DD" (input date).
 */
export type ReportPresetId = "today" | "7d" | "30d" | "month" | "custom";

export const REPORT_PRESETS: { id: ReportPresetId; label: string }[] = [
  { id: "today", label: "Hoje" },
  { id: "7d", label: "Últimos 7 dias" },
  { id: "30d", label: "Últimos 30 dias" },
  { id: "month", label: "Este mês" },
  { id: "custom", label: "Personalizado" },
];

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Intervalo de um preset. Retorna null para "custom" (o caller usa as datas De/Até). */
export function presetRange(
  id: ReportPresetId,
): { start: string; end: string } | null {
  if (id === "custom") return null;
  const now = new Date();
  const end = ymd(now);
  if (id === "today") return { start: end, end };
  if (id === "7d") {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return { start: ymd(s), end };
  }
  if (id === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: ymd(s), end };
  }
  // 30d
  const s = new Date(now);
  s.setDate(s.getDate() - 29);
  return { start: ymd(s), end };
}

/**
 * Resolve o intervalo efetivo a partir do preset + datas personalizadas.
 * Retorna null quando "Personalizado" está incompleto (sem as duas datas),
 * sinalizando que o relatório ainda não pode ser gerado.
 */
export function resolveSelectedRange(
  preset: ReportPresetId,
  customStart: string,
  customEnd: string,
): { start: string; end: string } | null {
  if (preset === "custom") {
    return customStart && customEnd
      ? { start: customStart, end: customEnd }
      : null;
  }
  return presetRange(preset);
}
