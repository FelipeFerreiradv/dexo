import React from "react";
import { Svg, Path, Line, G } from "@react-pdf/renderer";
import { DEXO, PLATFORM_COLOR } from "./theme";

/* Geometria de gráficos desenhada na mão (vetor nítido), sem lib de chart no PDF.
 * Estilo data-viz editorial: áreas com gradiente Petróleo→Amarelo, donut/medidor
 * radial e linhas finas. */

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** Setor de anel (donut) entre dois ângulos (graus, sentido horário a partir do topo). */
function donutSegment(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  start: number,
  end: number,
): string {
  // Evita arco degenerado de 360° exatos (não fecha) — clampa.
  const sweep = Math.min(359.999, Math.max(0, end - start));
  const e = start + sweep;
  const p1 = polar(cx, cy, rOuter, start);
  const p2 = polar(cx, cy, rOuter, e);
  const p3 = polar(cx, cy, rInner, e);
  const p4 = polar(cx, cy, rInner, start);
  const large = sweep > 180 ? 1 : 0;
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${p4.x} ${p4.y}`,
    "Z",
  ].join(" ");
}

/** Donut ML × Shopee × Outro. */
export function DonutSplit({
  ml,
  shopee,
  outro,
  size = 132,
}: {
  ml: number;
  shopee: number;
  outro: number;
  size?: number;
}) {
  const total = ml + shopee + outro;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter * 0.62;
  const segs: { value: number; color: string }[] = [
    { value: ml, color: PLATFORM_COLOR.ML },
    { value: shopee, color: PLATFORM_COLOR.SHOPEE },
    { value: outro, color: PLATFORM_COLOR.OUTRO },
  ];
  let angle = 0;
  return (
    <Svg width={size} height={size}>
      {total === 0 ? (
        <Path
          d={donutSegment(cx, cy, rOuter, rInner, 0, 359.999)}
          fill={DEXO.bege}
        />
      ) : (
        segs.map((s, i) => {
          if (s.value <= 0) return null;
          const span = (s.value / total) * 360;
          const d = donutSegment(cx, cy, rOuter, rInner, angle, angle + span);
          angle += span;
          return <Path key={i} d={d} fill={s.color} />;
        })
      )}
    </Svg>
  );
}

/** Donut genérico de N segmentos (cor por segmento). */
export function DonutGeneric({
  segments,
  size = 132,
}: {
  segments: { value: number; color: string }[];
  size?: number;
}) {
  const total = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter * 0.62;
  let angle = 0;
  return (
    <Svg width={size} height={size}>
      {total === 0 ? (
        <Path
          d={donutSegment(cx, cy, rOuter, rInner, 0, 359.999)}
          fill={DEXO.bege}
        />
      ) : (
        segments.map((s, i) => {
          if (s.value <= 0) return null;
          const span = (s.value / total) * 360;
          const d = donutSegment(cx, cy, rOuter, rInner, angle, angle + span);
          angle += span;
          return <Path key={i} d={d} fill={s.color} />;
        })
      )}
    </Svg>
  );
}

/**
 * Área temporal (volume/dia) com gradiente assinatura Petróleo→Amarelo, mais uma
 * linha pontilhada para a 2ª série. `series` = valores por dia (anúncios);
 * `secondary` opcional (produtos).
 */
export function AreaTimeline({
  series,
  secondary,
  width,
  height = 150,
}: {
  series: number[];
  secondary?: number[];
  width: number;
  height?: number;
}) {
  const padBottom = 4;
  const padTop = 8;
  const innerH = height - padBottom - padTop;
  const n = series.length;
  const max = Math.max(
    1,
    ...series,
    ...(secondary && secondary.length ? secondary : [0]),
  );
  const xAt = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const yAt = (v: number) => padTop + innerH - (v / max) * innerH;

  const areaTop = series
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(v)}`)
    .join(" ");
  const areaPath = `${areaTop} L ${xAt(n - 1)} ${padTop + innerH} L ${xAt(0)} ${
    padTop + innerH
  } Z`;
  const linePath = series
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(v)}`)
    .join(" ");
  const secPath =
    secondary && secondary.length
      ? secondary
          .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(v)}`)
          .join(" ")
      : null;

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map(
    (f) => padTop + innerH - f * innerH,
  );

  return (
    <Svg width={width} height={height}>
      <G>
        {gridYs.map((y, i) => (
          <Line
            key={i}
            x1={0}
            y1={y}
            x2={width}
            y2={y}
            stroke={DEXO.bege}
            strokeWidth={0.6}
          />
        ))}
      </G>
      <Path d={areaPath} fill={DEXO.amareloClaro} fillOpacity={0.55} />
      <Path d={linePath} stroke={DEXO.amarelo} strokeWidth={1.6} fill="none" />
      {secPath ? (
        <Path
          d={secPath}
          stroke={DEXO.aco}
          strokeWidth={1.1}
          strokeDasharray="3 2"
          fill="none"
        />
      ) : null}
    </Svg>
  );
}
