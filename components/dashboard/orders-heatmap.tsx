"use client";

import React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type HeatmapPoint = {
  day: string;
  slot: "morning" | "afternoon" | "evening";
  value: number;
};

interface OrdersHeatmapProps {
  data: HeatmapPoint[];
}

const dayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayLabels: Record<string, string> = {
  Mon: "Seg",
  Tue: "Ter",
  Wed: "Qua",
  Thu: "Qui",
  Fri: "Sex",
  Sat: "Sáb",
  Sun: "Dom",
};
const slotLabels: Record<HeatmapPoint["slot"], string> = {
  morning: "Manhã",
  afternoon: "Tarde",
  evening: "Noite",
};

export function OrdersHeatmap({ data }: OrdersHeatmapProps) {
  const slots = ["morning", "afternoon", "evening"] as HeatmapPoint["slot"][];
  const maxValue = Math.max(...data.map((p) => p.value), 0);

  return (
    <Card className="relative h-full overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-[0_18px_60px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-5 pb-2 pt-4">
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Vendas por tempo
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <LegendDot tone="bg-muted-foreground/50" label="Baixo" />
          <LegendDot tone="bg-accent/60" label="Médio" />
          <LegendDot tone="bg-primary/70" label="Alto" />
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="grid grid-cols-[72px_repeat(7,minmax(0,1fr))] gap-2">
          <div />
          {dayOrder.map((day) => (
            <div
              key={day}
              className="text-center text-xs font-semibold text-muted-foreground"
            >
              {dayLabels[day]}
            </div>
          ))}

          {slots.map((slot) => (
            <React.Fragment key={slot}>
              <div className="text-right text-xs font-semibold text-muted-foreground">
                {slotLabels[slot]}
              </div>
              {dayOrder.map((day) => {
                const point = data.find(
                  (p) => p.day === day && p.slot === slot,
                );
                const value = point?.value ?? 0;
                const intensity = maxValue ? value / maxValue : 0;
                const tint = Math.min(78, 18 + intensity * 62);
                const surface = Math.max(12, 42 - intensity * 18);
                return (
                  <div
                    key={`${slot}-${day}`}
                    className={cn(
                      "relative aspect-square rounded-md border border-border/40 bg-muted/30 transition-transform duration-200",
                      value > 0 &&
                        "shadow-[0_8px_24px_color-mix(in_srgb,var(--color-shadow-color)_10%,transparent)]",
                      value === 0 && "opacity-50",
                    )}
                    style={{
                      backgroundColor: `color-mix(in srgb, var(--color-primary) ${tint}%, var(--color-card) ${surface}%)`,
                    }}
                    title={`${dayLabels[day]} ${slotLabels[slot]} • ${value.toLocaleString("pt-BR")} pedidos`}
                  >
                    <div className="pointer-events-none absolute inset-0 rounded-md bg-gradient-to-br from-foreground/10 to-transparent mix-blend-luminosity" />
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LegendDot({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 font-medium">
      <span className={cn("size-2.5 rounded-full", tone)} />
      {label}
    </span>
  );
}
