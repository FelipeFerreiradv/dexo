import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { DEXO, FONT, PLATFORM_COLOR } from "./theme";
import { registerReportFonts } from "./fonts";
import {
  Cover,
  Footer,
  Kpi,
  KpiRow,
  LegendDot,
  RunningHeader,
  SectionHeader,
  fmtBRL,
  fmtBRLCompact,
  fmtInt,
  s,
} from "./primitives";
import { AreaTimeline } from "./charts";

type CanonPlat = "ML" | "SHOPEE" | "OUTRO";

export interface DashboardReportData {
  company: string;
  generatedAtLabel: string;
  range: { startDate: string; endDate: string; label: string };
  business: {
    receita: number;
    pedidos: number;
    anunciosAtivos: number;
    anunciosCriadosPeriodo: number;
    produtosTotal: number;
    produtosCriadosPeriodo: number;
    timeseries: Array<{ date: string; receita: number; pedidos: number }>;
    contas: Array<{
      id: string;
      nome: string;
      plataforma: CanonPlat;
      receita: number;
      pedidos: number;
      anuncios: number;
    }>;
    topProdutos: Array<{ nome: string; sku: string | null; anuncios: number }>;
  };
  equipe: {
    produtos: number;
    anuncios: { total: number; ml: number; shopee: number; outro: number };
    top: Array<{ nome: string; produtos: number; anuncios: number }>;
  };
}

const CONTENT_W = 595.28 - 44 * 2;

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

function platLabel(p: CanonPlat): string {
  return p === "ML" ? "Mercado Livre" : p === "SHOPEE" ? "Shopee" : "Outro";
}

function Bar({ widthPct, color }: { widthPct: number; color: string }) {
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
        style={{
          width: `${widthPct}%`,
          height: "100%",
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function Doc({ data }: { data: DashboardReportData }) {
  const { business: b, equipe, range } = data;
  const maxRevenue = b.contas.reduce((m, c) => Math.max(m, c.receita), 0);
  const series = b.timeseries.map((t) => t.receita);
  const firstDate = b.timeseries[0]?.date;
  const lastDate = b.timeseries[b.timeseries.length - 1]?.date;

  return (
    <Document title="Relatório Geral — Dexo" author="Dexo">
      <Page size="A4">
        <Cover
          kicker="Relatório Geral"
          title={"Visão de\nNegócio"}
          subtitle="Desempenho do negócio e produtividade da equipe no período — pedidos, receita, anúncios e produtos."
          periodLabel={range.label}
          company={data.company}
          generatedAtLabel={data.generatedAtLabel}
        />
      </Page>

      <Page size="A4" style={s.page} wrap>
        <RunningHeader company={data.company} periodLabel={range.label} />

        <SectionHeader>Visão geral do período</SectionHeader>
        <KpiRow>
          <Kpi
            label="Receita no período"
            value={fmtBRLCompact(b.receita)}
            accent
            valueFontSize={18}
          />
          <Kpi label="Pedidos" value={fmtInt(b.pedidos)} />
          <Kpi label="Anúncios ativos" value={fmtInt(b.anunciosAtivos)} />
          <Kpi label="Produtos cadastrados" value={fmtInt(b.produtosTotal)} />
        </KpiRow>

        {/* Série temporal de receita */}
        <View
          style={{
            borderWidth: 1,
            borderColor: DEXO.bege,
            borderRadius: 6,
            padding: 12,
            backgroundColor: DEXO.branco,
            marginBottom: 18,
          }}
          wrap={false}
        >
          <Text
            style={{
              fontFamily: FONT.mono,
              fontSize: 6.8,
              letterSpacing: 0.8,
              color: DEXO.aco,
              marginBottom: 8,
            }}
          >
            RECEITA POR DIA ·{" "}
            {b.anunciosCriadosPeriodo > 0
              ? `${fmtInt(b.anunciosCriadosPeriodo)} ANÚNCIOS CRIADOS`
              : "PERÍODO"}
          </Text>
          <AreaTimeline series={series} width={CONTENT_W - 24} />
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              marginTop: 4,
            }}
          >
            <Text style={axisLabel}>
              {firstDate ? shortDate(firstDate) : ""}
            </Text>
            <Text style={axisLabel}>{lastDate ? shortDate(lastDate) : ""}</Text>
          </View>
        </View>

        {/* Distribuição por conta */}
        <SectionHeader>Distribuição por conta</SectionHeader>
        {b.contas.length === 0 ? (
          <Text style={empty}>Nenhuma conta de marketplace conectada.</Text>
        ) : (
          b.contas.map((c) => (
            <View
              key={c.id}
              wrap={false}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 6,
                borderBottomWidth: 0.6,
                borderBottomColor: DEXO.bege,
              }}
            >
              <View style={{ width: 150 }}>
                <Text
                  style={{
                    fontFamily: FONT.sans,
                    fontSize: 8.5,
                    fontWeight: 600,
                  }}
                >
                  {c.nome}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    marginTop: 1,
                  }}
                >
                  <View
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 2.5,
                      backgroundColor: PLATFORM_COLOR[c.plataforma],
                      marginRight: 4,
                    }}
                  />
                  <Text
                    style={{
                      fontFamily: FONT.sans,
                      fontSize: 6.8,
                      color: DEXO.aco,
                    }}
                  >
                    {platLabel(c.plataforma)} · {fmtInt(c.anuncios)} anúncios
                  </Text>
                </View>
              </View>
              <View style={{ flex: 1, paddingHorizontal: 10 }}>
                <Bar
                  widthPct={maxRevenue ? (c.receita / maxRevenue) * 100 : 0}
                  color={PLATFORM_COLOR[c.plataforma]}
                />
              </View>
              <Text style={[num, { width: 90, fontWeight: 700 }]}>
                {fmtBRL(c.receita)}
              </Text>
              <Text style={[num, { width: 48 }]}>{fmtInt(c.pedidos)} ped.</Text>
            </View>
          ))
        )}

        {/* Top produtos */}
        <View style={{ marginTop: 18 }} wrap={false}>
          <SectionHeader>Top produtos por anúncios</SectionHeader>
          {b.topProdutos.length === 0 ? (
            <Text style={empty}>Nenhum produto com anúncios.</Text>
          ) : (
            b.topProdutos.map((p, i) => (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 5,
                  borderBottomWidth: 0.6,
                  borderBottomColor: DEXO.bege,
                }}
              >
                <Text style={rank}>{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: FONT.sans, fontSize: 8.5 }}>
                    {p.nome}
                  </Text>
                  {p.sku ? (
                    <Text
                      style={{
                        fontFamily: FONT.mono,
                        fontSize: 6.5,
                        color: DEXO.aco,
                      }}
                    >
                      {p.sku}
                    </Text>
                  ) : null}
                </View>
                <Text style={[num, { width: 70, fontWeight: 700 }]}>
                  {fmtInt(p.anuncios)} anúnc.
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Produtividade da equipe (resumo) */}
        <View style={{ marginTop: 18 }} wrap={false}>
          <SectionHeader>Produtividade da equipe</SectionHeader>
          <KpiRow>
            <Kpi label="Produtos criados" value={fmtInt(equipe.produtos)} />
            <Kpi
              label="Anúncios criados"
              value={fmtInt(equipe.anuncios.total)}
              dot={PLATFORM_COLOR.ML}
            />
            <Kpi
              label="Anúncios ML"
              value={fmtInt(equipe.anuncios.ml)}
              dot={PLATFORM_COLOR.ML}
            />
            <Kpi
              label="Anúncios Shopee"
              value={fmtInt(equipe.anuncios.shopee)}
              dot={PLATFORM_COLOR.SHOPEE}
            />
          </KpiRow>
          <View style={{ flexDirection: "row", marginBottom: 6 }}>
            <LegendDot
              color={DEXO.amarelo}
              label="Top 3 colaboradores do período"
            />
          </View>
          {equipe.top.length === 0 ? (
            <Text style={empty}>Sem atividade da equipe no período.</Text>
          ) : (
            equipe.top.map((t, i) => (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 5,
                  borderBottomWidth: 0.6,
                  borderBottomColor: DEXO.bege,
                }}
              >
                <Text style={rank}>{i + 1}</Text>
                <Text style={{ flex: 1, fontFamily: FONT.sans, fontSize: 8.5 }}>
                  {t.nome}
                </Text>
                <Text style={[num, { width: 70 }]}>
                  {fmtInt(t.produtos)} prod.
                </Text>
                <Text style={[num, { width: 80, fontWeight: 700 }]}>
                  {fmtInt(t.anuncios)} anúnc.
                </Text>
              </View>
            ))
          )}
        </View>

        <Footer periodLabel={range.label} />
      </Page>
    </Document>
  );
}

const num = {
  fontFamily: FONT.mono,
  fontSize: 8,
  color: DEXO.petroleoProfundo,
  textAlign: "right" as const,
};
const rank = {
  fontFamily: FONT.mono,
  fontSize: 8,
  color: DEXO.aco,
  width: 18,
} as const;
const axisLabel = {
  fontFamily: FONT.mono,
  fontSize: 6.5,
  color: DEXO.aco,
} as const;
const empty = {
  fontFamily: FONT.sans,
  fontSize: 8.5,
  color: DEXO.aco,
  paddingVertical: 8,
} as const;

export async function renderDashboardReport(
  data: DashboardReportData,
): Promise<Buffer> {
  registerReportFonts();
  return renderToBuffer(<Doc data={data} />);
}
