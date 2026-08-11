import React from "react";
import { Text, View, StyleSheet } from "@react-pdf/renderer";
import { DEXO, FONT, PLATFORM_COLOR } from "./theme";

/** Inteiro no padrão BR (1.234) sem depender de ICU — determinístico no Node. */
export function fmtInt(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString();
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return neg ? `-${out}` : out;
}

export function pctLabel(part: number, whole: number): string {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/** Moeda BRL (R$ 1.234,56) sem ICU — determinístico (mesmo padrão do DANFE). */
export function fmtBRL(n: number): string {
  const neg = n < 0;
  const v = Math.abs(n);
  const cents = Math.round(v * 100);
  const intPart = Math.floor(cents / 100);
  const dec = cents % 100;
  const intStr = intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${intStr},${String(dec).padStart(2, "0")}`;
}

/** Compacta moeda grande para KPIs (R$ 1,2 mi / R$ 340 mil). Espaço
 *  inquebrável evita o valor quebrar em várias linhas no card. */
export function fmtBRLCompact(n: number): string {
  const NB = String.fromCharCode(0xa0); // non-breaking space (U+00A0)
  const v = Math.abs(n);
  if (v >= 1_000_000)
    return `R$${NB}${(n / 1_000_000).toFixed(1).replace(".", ",")}${NB}mi`;
  if (v >= 1_000) return `R$${NB}${Math.round(n / 1000)}${NB}mil`;
  return fmtBRL(n).replace(/ /g, NB);
}

export const s = StyleSheet.create({
  page: {
    backgroundColor: DEXO.creme,
    color: DEXO.petroleoProfundo,
    fontFamily: FONT.sans,
    fontSize: 9,
    paddingTop: 40,
    paddingHorizontal: 44,
    paddingBottom: 48,
  },
  // Cabeçalho corrente de página
  runningHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 18,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: DEXO.bege,
  },
  brandMark: {
    fontFamily: FONT.display,
    fontSize: 12,
    color: DEXO.petroleoProfundo,
    letterSpacing: 1,
  },
  headerMeta: {
    fontFamily: FONT.mono,
    fontSize: 7,
    color: DEXO.aco,
    letterSpacing: 0.5,
    textAlign: "right",
  },
  sectionHeader: {
    fontFamily: FONT.display,
    fontSize: 17,
    color: DEXO.petroleoProfundo,
    marginBottom: 10,
  },
  asterisk: { color: DEXO.amarelo },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    fontFamily: FONT.mono,
    fontSize: 6.5,
    color: DEXO.aco,
    letterSpacing: 0.6,
  },
});

/** Título de seção com o asterisco-assinatura amarelo (vibe da referência). */
export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Text style={s.sectionHeader}>
      {children} <Text style={s.asterisk}>*</Text>
    </Text>
  );
}

export function RunningHeader({
  company,
  periodLabel,
}: {
  company: string;
  periodLabel: string;
}) {
  return (
    <View style={s.runningHeader} fixed>
      <Text style={s.brandMark}>DEXO</Text>
      <Text style={s.headerMeta}>
        {company.toUpperCase()}
        {"\n"}
        {periodLabel}
      </Text>
    </View>
  );
}

export function Footer({ periodLabel }: { periodLabel: string }) {
  return (
    <View style={s.footer} fixed>
      <Text>DEXO · DOCUMENTO CONFIDENCIAL · {periodLabel.toUpperCase()}</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `PÁG ${pageNumber} / ${totalPages}`
        }
      />
    </View>
  );
}

/** Capa: fundo Petróleo Profundo, título imenso, asterisco amarelo, período. */
export function Cover({
  kicker,
  title,
  subtitle,
  periodLabel,
  company,
  generatedAtLabel,
}: {
  kicker: string;
  title: string;
  subtitle: string;
  periodLabel: string;
  company: string;
  generatedAtLabel: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: DEXO.petroleoProfundo,
        color: DEXO.creme,
        margin: -1, // cobre folga de antialias na borda
        paddingTop: 64,
        paddingHorizontal: 52,
        paddingBottom: 56,
        justifyContent: "space-between",
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text
          style={{
            fontFamily: FONT.display,
            fontSize: 13,
            color: DEXO.creme,
            letterSpacing: 2,
          }}
        >
          DEXO
        </Text>
        <Text
          style={{
            fontFamily: FONT.mono,
            fontSize: 7.5,
            color: DEXO.amarelo,
            letterSpacing: 1,
          }}
        >
          DOCUMENTO CONFIDENCIAL
        </Text>
      </View>

      <View>
        <Text
          style={{
            fontFamily: FONT.mono,
            fontSize: 8.5,
            color: DEXO.amarelo,
            letterSpacing: 2,
            marginBottom: 14,
          }}
        >
          {kicker.toUpperCase()}
        </Text>
        <Text
          style={{
            fontFamily: FONT.display,
            fontSize: 40,
            lineHeight: 1.04,
            color: DEXO.creme,
          }}
        >
          {title} <Text style={{ color: DEXO.amarelo }}>*</Text>
        </Text>
        <Text
          style={{
            fontFamily: FONT.sans,
            fontSize: 11,
            color: DEXO.concreto,
            marginTop: 16,
            maxWidth: 360,
            lineHeight: 1.4,
          }}
        >
          {subtitle}
        </Text>
      </View>

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: DEXO.petroleoMedio,
          paddingTop: 16,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <CoverMeta label="Período" value={periodLabel} />
        <CoverMeta label="Empresa" value={company} />
        <CoverMeta label="Emitido em" value={generatedAtLabel} />
      </View>
    </View>
  );
}

function CoverMeta({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ maxWidth: 160 }}>
      <Text
        style={{
          fontFamily: FONT.mono,
          fontSize: 6.5,
          color: DEXO.acoClaro,
          letterSpacing: 1,
          marginBottom: 3,
        }}
      >
        {label.toUpperCase()}
      </Text>
      <Text style={{ fontFamily: FONT.sans, fontSize: 9.5, color: DEXO.creme }}>
        {value}
      </Text>
    </View>
  );
}

/** KPI grande estilo número-âncora editorial. */
export function Kpi({
  label,
  value,
  accent,
  dot,
  valueFontSize = 26,
}: {
  label: string;
  value: string;
  accent?: boolean;
  dot?: string;
  valueFontSize?: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: accent ? DEXO.petroleoProfundo : DEXO.branco,
        borderWidth: 1,
        borderColor: accent ? DEXO.petroleoProfundo : DEXO.bege,
        borderRadius: 6,
        padding: 12,
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}
      >
        {dot ? (
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: dot,
              marginRight: 5,
            }}
          />
        ) : null}
        <Text
          style={{
            fontFamily: FONT.mono,
            fontSize: 6.8,
            letterSpacing: 0.8,
            color: accent ? DEXO.amarelo : DEXO.aco,
          }}
        >
          {label.toUpperCase()}
        </Text>
      </View>
      <Text
        style={{
          fontFamily: FONT.display,
          fontSize: valueFontSize,
          color: accent ? DEXO.creme : DEXO.petroleoProfundo,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function KpiRow({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
      {children}
    </View>
  );
}

/** Barra empilhada ML × Shopee × Outro (proporção dentro do colaborador). */
export function StackedBar({
  ml,
  shopee,
  outro,
  magalu = 0,
  olx = 0,
  facebook = 0,
  widthPct,
}: {
  ml: number;
  shopee: number;
  outro: number;
  magalu?: number;
  olx?: number;
  facebook?: number;
  widthPct: number;
}) {
  const total = ml + shopee + outro + magalu + olx + facebook;
  const seg = (v: number, color: string) =>
    total > 0 && v > 0 ? (
      <View
        style={{
          width: `${(v / total) * 100}%`,
          backgroundColor: color,
          height: "100%",
        }}
      />
    ) : null;
  return (
    <View
      style={{
        height: 7,
        borderRadius: 4,
        backgroundColor: DEXO.bege,
        overflow: "hidden",
      }}
    >
      <View
        style={{ flexDirection: "row", height: "100%", width: `${widthPct}%` }}
      >
        {seg(ml, PLATFORM_COLOR.ML)}
        {seg(shopee, PLATFORM_COLOR.SHOPEE)}
        {seg(magalu, PLATFORM_COLOR.MAGALU)}
        {seg(olx, PLATFORM_COLOR.OLX)}
        {seg(facebook, PLATFORM_COLOR.FACEBOOK)}
        {seg(outro, PLATFORM_COLOR.OUTRO)}
      </View>
    </View>
  );
}

/** Dot-grid: 1 ponto = `perDot` anúncios (referência direta ao layout anexado). */
export function DotGrid({
  count,
  perDot,
  cols = 26,
  maxDots = 156,
}: {
  count: number;
  perDot: number;
  cols?: number;
  maxDots?: number;
}) {
  const dots = Math.min(maxDots, Math.ceil(count / Math.max(1, perDot)));
  const cells = Array.from({ length: Math.max(dots, 1) });
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", width: cols * 9 }}>
      {cells.map((_, i) => (
        <View
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            margin: 1.5,
            backgroundColor: count > 0 ? DEXO.amarelo : DEXO.bege,
          }}
        />
      ))}
    </View>
  );
}

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", marginRight: 12 }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: color,
          marginRight: 4,
        }}
      />
      <Text style={{ fontFamily: FONT.sans, fontSize: 7.5, color: DEXO.aco }}>
        {label}
      </Text>
    </View>
  );
}
