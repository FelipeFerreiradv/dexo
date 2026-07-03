"use client";

// Progresso visual da sucata: silhueta de um esportivo (ícone fornecido) que
// começa "vazio" (cinza) e vai sendo PREENCHIDO de amarelo Dexo da frente para a
// traseira conforme a % de peças vendidas cresce. Aditivo e SOMENTE LEITURA —
// deriva tudo de `computeScrapPaint(parts)`.
//
// O ícone é uma silhueta de cor única (corpo + 2 rodas), então o preenchimento é
// por PERCENTUAL (não peça-por-peça). Um clip revela a versão amarela até
// `percent`% da largura. Plate claro fixo → idêntico em tema claro E escuro.

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { computeScrapPaint, type ScrapPaintPart } from "../lib/car-regions";
import { SPORT_CAR } from "../lib/sport-car-svg";

const EMPTY = "#d3d5d3";
const WHEEL = "#2f3236";
const PLATE = "#f4f4f1";

export function ImpalaProgress({
  parts,
}: {
  parts: ReadonlyArray<ScrapPaintPart>;
}) {
  const { percent, soldCount, totalCount } = computeScrapPaint(parts);
  const fillWidth = (SPORT_CAR.width * percent) / 100;

  return (
    <Card className="border-border/60 bg-card/90">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Progresso da desmontagem
            </p>
            <p className="text-xs text-muted-foreground">Esportivo de luxo</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold leading-none tabular-nums">
              {percent}%
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {soldCount}/{totalCount} peças vendidas
            </div>
          </div>
        </div>

        <Progress value={percent} className="mt-3" />

        <div className="mt-3">
          <svg
            viewBox={SPORT_CAR.viewBox}
            role="img"
            aria-label={`Esportivo de luxo — ${percent}% das peças vendidas (${soldCount} de ${totalCount})`}
            className="h-auto w-full"
          >
            <defs>
              <clipPath id="imp-fill">
                <rect x="0" y="0" width={fillWidth} height={SPORT_CAR.height} />
              </clipPath>
            </defs>

            <rect
              x="0"
              y="0"
              width={SPORT_CAR.width}
              height={SPORT_CAR.height}
              rx="48"
              fill={PLATE}
            />

            {/* Carro "vazio" (cinza) + rodas escuras */}
            {SPORT_CAR.wheels.map((d, i) => (
              <path key={i} d={d} fill={WHEEL} />
            ))}
            <path d={SPORT_CAR.body} fill={EMPTY} />

            {/* Preenchimento amarelo revelado até `percent`% da largura */}
            <g clipPath="url(#imp-fill)">
              <path d={SPORT_CAR.body} fill="var(--primary)" />
              {SPORT_CAR.wheels.map((d, i) => (
                <path key={i} d={d} fill="var(--primary)" />
              ))}
            </g>
          </svg>
        </div>

        {totalCount === 0 && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Sem peças cadastradas
          </p>
        )}
      </CardContent>
    </Card>
  );
}
