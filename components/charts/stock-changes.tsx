"use client";

import React from "react";
import { LineChart, Line, ResponsiveContainer } from "recharts";

type Change = {
  date: string;
  change: number;
  previousStock: number;
  newStock: number;
  reason?: string | null;
};

type Item = {
  productId: string;
  productName: string;
  productSku?: string | null;
  productImageUrl?: string | null;
  changes: Change[];
};

function MiniSparkline({ points }: { points: { x: string; y: number }[] }) {
  if (!points || points.length === 0) return null;
  return (
    <div style={{ width: 120, height: 40 }} className="mini-sparkline">
      <ResponsiveContainer>
        <LineChart data={points}>
          <Line
            type="monotone"
            dataKey="y"
            stroke="currentColor"
            strokeWidth={2}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function StockChangeRow({ item, mixExpr }: { item: Item; mixExpr: string }) {
  const [open, setOpen] = React.useState(false);
  const points = item.changes
    .slice()
    .reverse()
    .slice(0, 12)
    .map((c) => ({ x: c.date, y: c.change }));

  const lastChange = item.changes[0];
  const lastDate = lastChange ? new Date(lastChange.date) : null;

  return (
    <div className="space-y-2">
      <div
        className="flex items-center justify-between rounded-lg border bg-card p-3 shadow-sm"
        style={{ color: mixExpr }}
      >
        <div className="flex items-center gap-3">
          {item.productImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.productImageUrl}
              alt={item.productName}
              className="w-10 h-10 rounded-md object-cover"
            />
          ) : (
            <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
              {item.productSku
                ? item.productSku.slice(0, 2).toUpperCase()
                : "—"}
            </div>
          )}
          <div>
            <p className="text-sm font-medium">{item.productName}</p>
            <p className="text-xs text-muted-foreground">
              SKU: {item.productSku ?? "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              {item.changes.length > 1
                ? `${item.changes.length} alterações`
                : `${item.changes.length} alteração`}{" "}
              • {lastDate ? lastDate.toLocaleString("pt-BR") : "—"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-sm text-muted-foreground px-3 py-1 rounded hover:bg-muted/20"
          >
            {open ? "Fechar" : "Detalhes"}
          </button>
          {/* <MiniSparkline points={points} /> */}
        </div>
      </div>

      {open && (
        <div className="rounded-lg border bg-card p-3 shadow-sm">
          <ul className="space-y-2">
            {item.changes.map((c, i) => (
              <li key={i} className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-accent">
                    {c.change > 0 ? `+${c.change}` : c.change}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(c.date).toLocaleString("pt-BR")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Anterior: {c.previousStock} → Agora: {c.newStock}
                  </p>
                  {c.reason && (
                    <p className="text-xs text-muted-foreground">
                      Motivo: {c.reason}
                    </p>
                  )}
                </div>
                <div className="text-sm font-medium" style={{ color: mixExpr }}>
                  {c.change > 0 ? "+" + c.change : c.change}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function StockChanges({ data }: { data: Item[] }) {
  if (!data || data.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        Sem alterações recentes
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((item, idx) => {
        const points = item.changes
          .slice()
          .reverse()
          .slice(0, 12)
          .map((c) => ({ x: c.date, y: c.change }));
        const mix = 48 + (idx % 5) * 8; // vary from 48..80
        const mixExpr = `color-mix(in srgb, var(--color-primary) ${mix}%, var(--color-card) ${100 - mix}%)`;

        // Render specialized row component (contains expand/collapse)
        return (
          <StockChangeRow key={item.productId} item={item} mixExpr={mixExpr} />
        );

        /* Unreachable fallback rendering kept for reference
        const lastChange = item.changes[0];
        const lastDate = lastChange ? new Date(lastChange.date) : null;
        return (
          <div
            key={item.productId}
            className="flex items-center justify-between rounded-lg border bg-card p-3 shadow-sm"
            style={{ color: mixExpr }}
          >
            <div className="flex items-center gap-3">
              {item.productImageUrl ? (
                <img
                  src={item.productImageUrl}
                  alt={item.productName}
                  className="w-10 h-10 rounded-md object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground">
                  {item.productSku
                    ? item.productSku.slice(0, 2).toUpperCase()
                    : "—"}
                </div>
              )}
              <div>
                <p className="text-sm font-medium">{item.productName}</p>
                <p className="text-xs text-muted-foreground">
                  SKU: {item.productSku ?? "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.changes.length > 1
                    ? `${item.changes.length} alterações`
                    : `${item.changes.length} Alteração`}{" "}
                  • {lastDate ? lastDate.toLocaleString("pt-BR") : "—"}
                </p>
              </div>
            </div>
            <MiniSparkline points={points} />
          </div>
        );
        */
      })}
    </div>
  );
}
