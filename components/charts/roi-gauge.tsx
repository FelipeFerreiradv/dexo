"use client";

import {
  ResponsiveContainer,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
} from "recharts";

// Medidor de ROI (semicírculo). O número central mostra o ROI real (pode ser
// negativo ou > 100%); o arco mapeia ROI de [-100%, +200%] para [0,100] da
// escala, clampado. Verde = lucro (≥0), vermelho = prejuízo (<0), cinza = N/A.
export function RoiGauge({ roi }: { roi: number | null }) {
  const hasValue = roi !== null && roi !== undefined && !Number.isNaN(roi);

  const fill = hasValue
    ? Math.max(0, Math.min(100, ((roi + 100) / 300) * 100))
    : 0;

  const color = !hasValue ? "#94a3b8" : roi >= 0 ? "#16a34a" : "#dc2626";

  const data = [{ name: "roi", value: fill, fill: color }];

  return (
    <div className="relative" style={{ width: "100%", height: 150 }}>
      <ResponsiveContainer>
        <RadialBarChart
          innerRadius="72%"
          outerRadius="100%"
          data={data}
          startAngle={180}
          endAngle={0}
        >
          <PolarAngleAxis
            type="number"
            domain={[0, 100]}
            angleAxisId={0}
            tick={false}
          />
          <RadialBar
            background
            dataKey="value"
            cornerRadius={8}
            angleAxisId={0}
          />
        </RadialBarChart>
      </ResponsiveContainer>

      <div className="absolute inset-x-0 bottom-1 flex flex-col items-center">
        <span
          className="text-3xl font-bold leading-none tracking-tight"
          style={{ color }}
        >
          {hasValue ? `${Math.round(roi)}%` : "—"}
        </span>
        <span className="mt-1 text-[11px] font-medium text-muted-foreground">
          ROI
        </span>
      </div>
    </div>
  );
}
