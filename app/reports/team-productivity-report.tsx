import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { DEXO, FONT } from "./theme";
import { registerReportFonts } from "./fonts";
import {
  Cover,
  DotGrid,
  Footer,
  Kpi,
  KpiRow,
  LegendDot,
  RunningHeader,
  SectionHeader,
  StackedBar,
  fmtBRL,
  fmtInt,
  pctLabel,
  s,
} from "./primitives";
import { AreaTimeline, DonutSplit } from "./charts";
import { PLATFORM_COLOR } from "./theme";

export interface TeamProductivityReportData {
  company: string;
  generatedAtLabel: string;
  range: { startDate: string; endDate: string; label: string };
  totals: {
    produtos: number;
    anuncios: {
      total: number;
      ml: number;
      shopee: number;
      magalu: number;
      outro: number;
    };
  };
  byCollaborator: Array<{
    id: string;
    name: string | null;
    email: string;
    produtos: number;
    anuncios: {
      total: number;
      ml: number;
      shopee: number;
      magalu: number;
      outro: number;
    };
    lastActivityAt: string | null;
  }>;
  timeseries: Array<{
    date: string;
    produtos: number;
    ml: number;
    shopee: number;
    magalu: number;
  }>;
  // Orçamentos por vendedor (BLOCO 1) — emitidos + convertidos (count+valor).
  budgetsByVendedor: Array<{
    id: string;
    name: string | null;
    email: string;
    isOwner: boolean;
    orcamentos: { count: number; valor: number };
    convertidos: { count: number; valor: number };
  }>;
  budgetTotals: {
    orcamentos: { count: number; valor: number };
    convertidos: { count: number; valor: number };
  };
}

const CONTENT_W = 595.28 - 44 * 2;

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

function initials(name: string | null, email: string): string {
  return (name || email).slice(0, 2).toUpperCase();
}

function EmptyDoc({ data }: { data: TeamProductivityReportData }) {
  return (
    <Document title="Relatório de Produtividade da Equipe — Dexo" author="Dexo">
      <Page size="A4">
        <View
          style={{
            flex: 1,
            backgroundColor: DEXO.petroleoProfundo,
            color: DEXO.creme,
            padding: 52,
            justifyContent: "space-between",
          }}
        >
          <Text
            style={{
              fontFamily: FONT.display,
              fontSize: 13,
              letterSpacing: 2,
              color: DEXO.creme,
            }}
          >
            DEXO
          </Text>
          <View>
            <Text
              style={{
                fontFamily: FONT.mono,
                fontSize: 8.5,
                color: DEXO.amarelo,
                letterSpacing: 2,
                marginBottom: 12,
              }}
            >
              RELATÓRIO DE PRODUTIVIDADE DA EQUIPE
            </Text>
            <Text
              style={{
                fontFamily: FONT.display,
                fontSize: 30,
                color: DEXO.creme,
                lineHeight: 1.05,
              }}
            >
              Sem atividade no período{"\n"}selecionado{" "}
              <Text style={{ color: DEXO.amarelo }}>*</Text>
            </Text>
            <Text
              style={{
                fontFamily: FONT.sans,
                fontSize: 10,
                color: DEXO.concreto,
                marginTop: 14,
              }}
            >
              {data.range.label} · {data.company}
            </Text>
          </View>
          <Text
            style={{
              fontFamily: FONT.mono,
              fontSize: 6.5,
              color: DEXO.acoClaro,
              letterSpacing: 0.6,
            }}
          >
            DEXO · DOCUMENTO CONFIDENCIAL · EMITIDO EM{" "}
            {data.generatedAtLabel.toUpperCase()}
          </Text>
        </View>
      </Page>
    </Document>
  );
}

function FullDoc({ data }: { data: TeamProductivityReportData }) {
  const { totals, byCollaborator, range } = data;
  const maxTotal = byCollaborator.reduce(
    (m, c) => Math.max(m, c.anuncios.total),
    0,
  );
  const ativos = byCollaborator.filter(
    (c) => c.produtos > 0 || c.anuncios.total > 0,
  ).length;
  const perDot = Math.max(1, Math.ceil(totals.anuncios.total / 130));
  const areaSeries = data.timeseries.map((t) => t.ml + t.shopee + t.magalu);
  const areaSecondary = data.timeseries.map((t) => t.produtos);
  const firstDate = data.timeseries[0]?.date;
  const lastDate = data.timeseries[data.timeseries.length - 1]?.date;

  return (
    <Document title="Relatório de Produtividade da Equipe — Dexo" author="Dexo">
      {/* CAPA */}
      <Page size="A4">
        <Cover
          kicker="Relatório de Produtividade da Equipe"
          title={"Produtividade\nda Equipe"}
          subtitle="Quantos produtos e anúncios cada colaborador criou e a eficiência da equipe no período."
          periodLabel={range.label}
          company={data.company}
          generatedAtLabel={data.generatedAtLabel}
        />
      </Page>

      {/* CONTEÚDO */}
      <Page size="A4" style={s.page} wrap>
        <RunningHeader company={data.company} periodLabel={range.label} />

        <SectionHeader>Resumo do período</SectionHeader>
        <KpiRow>
          <Kpi label="Produtos criados" value={fmtInt(totals.produtos)} />
          <Kpi
            label="Anúncios criados"
            value={fmtInt(totals.anuncios.total)}
            accent
          />
          <Kpi
            label="Anúncios ML"
            value={fmtInt(totals.anuncios.ml)}
            dot={PLATFORM_COLOR.ML}
          />
          <Kpi
            label="Anúncios Shopee"
            value={fmtInt(totals.anuncios.shopee)}
            dot={PLATFORM_COLOR.SHOPEE}
          />
          <Kpi
            label="Anúncios Magalu"
            value={fmtInt(totals.anuncios.magalu)}
            dot={PLATFORM_COLOR.MAGALU}
          />
        </KpiRow>

        <View style={{ flexDirection: "row", gap: 14, marginBottom: 18 }}>
          {/* Donut ML × Shopee */}
          <View
            style={{
              borderWidth: 1,
              borderColor: DEXO.bege,
              borderRadius: 6,
              padding: 12,
              backgroundColor: DEXO.branco,
              width: 200,
              alignItems: "center",
            }}
          >
            <Text
              style={{
                fontFamily: FONT.mono,
                fontSize: 6.8,
                letterSpacing: 0.8,
                color: DEXO.aco,
                alignSelf: "flex-start",
                marginBottom: 6,
              }}
            >
              DISTRIBUIÇÃO POR CANAL
            </Text>
            <DonutSplit
              ml={totals.anuncios.ml}
              shopee={totals.anuncios.shopee}
              magalu={totals.anuncios.magalu}
              outro={totals.anuncios.outro}
            />
            <View
              style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}
            >
              <LegendDot
                color={PLATFORM_COLOR.ML}
                label={`ML ${pctLabel(totals.anuncios.ml, totals.anuncios.total)}`}
              />
              <LegendDot
                color={PLATFORM_COLOR.SHOPEE}
                label={`Shopee ${pctLabel(totals.anuncios.shopee, totals.anuncios.total)}`}
              />
              <LegendDot
                color={PLATFORM_COLOR.MAGALU}
                label={`Magalu ${pctLabel(totals.anuncios.magalu, totals.anuncios.total)}`}
              />
            </View>
          </View>

          {/* Dot-grid + stats */}
          <View
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: DEXO.bege,
              borderRadius: 6,
              padding: 12,
              backgroundColor: DEXO.branco,
            }}
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
              VOLUME DE ANÚNCIOS · 1 PONTO = {fmtInt(perDot)}
            </Text>
            <DotGrid count={totals.anuncios.total} perDot={perDot} />
            <View style={{ flexDirection: "row", gap: 24, marginTop: 12 }}>
              <Stat
                label="Colaboradores ativos"
                value={`${ativos}/${byCollaborator.length}`}
              />
              <Stat
                label="Anúncios / colaborador ativo"
                value={fmtInt(ativos ? totals.anuncios.total / ativos : 0)}
              />
            </View>
          </View>
        </View>

        {/* RANKING */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <SectionHeader>Ranking de colaboradores</SectionHeader>
          <View style={{ flexDirection: "row", marginBottom: 10 }}>
            <LegendDot color={PLATFORM_COLOR.ML} label="ML" />
            <LegendDot color={PLATFORM_COLOR.SHOPEE} label="Shopee" />
            <LegendDot color={PLATFORM_COLOR.MAGALU} label="Magalu" />
          </View>
        </View>

        {/* Cabeçalho da tabela */}
        <View
          style={{
            flexDirection: "row",
            borderBottomWidth: 1,
            borderBottomColor: DEXO.petroleoProfundo,
            paddingBottom: 4,
            marginBottom: 4,
          }}
        >
          <Text style={[col.rank, th]}>#</Text>
          <Text style={[col.name, th]}>COLABORADOR</Text>
          <Text style={[col.bar, th]}>DISTRIBUIÇÃO</Text>
          <Text style={[col.num, th]}>PROD.</Text>
          <Text style={[col.num, th]}>ML</Text>
          <Text style={[col.num, th]}>SHOPEE</Text>
          <Text style={[col.num, th]}>MAGALU</Text>
          <Text style={[col.num, th]}>ANÚNC.</Text>
          <Text style={[col.share, th]}>PART.</Text>
        </View>

        {byCollaborator.map((c, i) => {
          const top = i === 0 && c.anuncios.total > 0;
          return (
            <View
              key={c.id}
              wrap={false}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 6,
                borderBottomWidth: 0.6,
                borderBottomColor: DEXO.bege,
                backgroundColor: top ? "#FBF3D2" : undefined,
              }}
            >
              <Text style={[col.rank, td]}>{i + 1}</Text>
              <View style={col.name}>
                <Text
                  style={{
                    fontFamily: FONT.sans,
                    fontSize: 8.5,
                    fontWeight: 600,
                  }}
                >
                  {c.name || c.email}
                </Text>
                {c.name ? (
                  <Text
                    style={{
                      fontFamily: FONT.sans,
                      fontSize: 6.8,
                      color: DEXO.aco,
                    }}
                  >
                    {c.email}
                  </Text>
                ) : null}
              </View>
              <View style={[col.bar, { paddingRight: 10 }]}>
                <StackedBar
                  ml={c.anuncios.ml}
                  shopee={c.anuncios.shopee}
                  magalu={c.anuncios.magalu}
                  outro={c.anuncios.outro}
                  widthPct={maxTotal ? (c.anuncios.total / maxTotal) * 100 : 0}
                />
              </View>
              <Text style={[col.num, td]}>{fmtInt(c.produtos)}</Text>
              <Text style={[col.num, td]}>{fmtInt(c.anuncios.ml)}</Text>
              <Text style={[col.num, td]}>{fmtInt(c.anuncios.shopee)}</Text>
              <Text style={[col.num, td]}>{fmtInt(c.anuncios.magalu)}</Text>
              <Text style={[col.num, td, { fontWeight: 700 }]}>
                {fmtInt(c.anuncios.total)}
              </Text>
              <Text style={[col.share, td]}>
                {pctLabel(c.anuncios.total, totals.anuncios.total)}
              </Text>
            </View>
          );
        })}

        {/* SÉRIE TEMPORAL */}
        <View style={{ marginTop: 20 }} wrap={false}>
          <SectionHeader>Criação ao longo do período</SectionHeader>
          <View
            style={{
              borderWidth: 1,
              borderColor: DEXO.bege,
              borderRadius: 6,
              padding: 12,
              backgroundColor: DEXO.branco,
            }}
          >
            <AreaTimeline
              series={areaSeries}
              secondary={areaSecondary}
              width={CONTENT_W - 24}
            />
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
              <Text style={axisLabel}>
                {lastDate ? shortDate(lastDate) : ""}
              </Text>
            </View>
            <View style={{ flexDirection: "row", marginTop: 8 }}>
              <LegendDot color={DEXO.amarelo} label="Anúncios / dia" />
              <LegendDot color={DEXO.aco} label="Produtos / dia" />
            </View>
          </View>
        </View>

        {/* ORÇAMENTOS POR VENDEDOR (BLOCO 1) — base p/ comissão */}
        {data.budgetsByVendedor.length > 0 && (
          <View style={{ marginTop: 20 }} wrap={false}>
            <SectionHeader>Orçamentos por vendedor</SectionHeader>
            <View
              style={{
                borderWidth: 1,
                borderColor: DEXO.bege,
                borderRadius: 6,
                backgroundColor: DEXO.branco,
                padding: 10,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  borderBottomWidth: 1,
                  borderBottomColor: DEXO.aco,
                  paddingBottom: 4,
                }}
              >
                <Text style={[th, bcol.name]}>VENDEDOR</Text>
                <Text style={[th, bcol.num]}>ORÇ.</Text>
                <Text style={[th, bcol.money]}>VALOR</Text>
                <Text style={[th, bcol.num]}>CONV.</Text>
                <Text style={[th, bcol.money]}>VALOR CONV.</Text>
              </View>
              {data.budgetsByVendedor.map((v) => (
                <View
                  key={v.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 3,
                    borderBottomWidth: 0.5,
                    borderBottomColor: DEXO.bege,
                  }}
                >
                  <Text
                    style={[
                      bcol.name,
                      {
                        fontFamily: FONT.sans,
                        fontSize: 8.5,
                        color: DEXO.petroleoProfundo,
                      },
                    ]}
                  >
                    {v.name || v.email}
                    {v.isOwner ? " (você)" : ""}
                  </Text>
                  <Text style={[td, bcol.num]}>{fmtInt(v.orcamentos.count)}</Text>
                  <Text style={[td, bcol.money]}>
                    {fmtBRL(v.orcamentos.valor)}
                  </Text>
                  <Text style={[td, bcol.num]}>
                    {fmtInt(v.convertidos.count)}
                  </Text>
                  <Text style={[td, bcol.money]}>
                    {fmtBRL(v.convertidos.valor)}
                  </Text>
                </View>
              ))}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingTop: 5,
                }}
              >
                <Text style={[th, bcol.name]}>TOTAL DA EQUIPE</Text>
                <Text style={[td, bcol.num]}>
                  {fmtInt(data.budgetTotals.orcamentos.count)}
                </Text>
                <Text style={[td, bcol.money]}>
                  {fmtBRL(data.budgetTotals.orcamentos.valor)}
                </Text>
                <Text style={[td, bcol.num]}>
                  {fmtInt(data.budgetTotals.convertidos.count)}
                </Text>
                <Text style={[td, bcol.money]}>
                  {fmtBRL(data.budgetTotals.convertidos.valor)}
                </Text>
              </View>
            </View>
            <Text
              style={{
                fontFamily: FONT.sans,
                fontSize: 7,
                color: DEXO.aco,
                marginTop: 5,
              }}
            >
              Orçamentos criados no período, atribuídos a cada vendedor.
              &quot;Convertidos&quot; = viraram venda (Conta a Receber) — base
              usual para comissão.
            </Text>
          </View>
        )}

        <Footer periodLabel={range.label} />
      </Page>
    </Document>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text
        style={{
          fontFamily: FONT.display,
          fontSize: 18,
          color: DEXO.petroleoProfundo,
        }}
      >
        {value}
      </Text>
      <Text style={{ fontFamily: FONT.sans, fontSize: 7, color: DEXO.aco }}>
        {label}
      </Text>
    </View>
  );
}

const th = {
  fontFamily: FONT.mono,
  fontSize: 6,
  letterSpacing: 0.5,
  color: DEXO.aco,
} as const;
const td = {
  fontFamily: FONT.mono,
  fontSize: 8,
  color: DEXO.petroleoProfundo,
} as const;
const axisLabel = {
  fontFamily: FONT.mono,
  fontSize: 6.5,
  color: DEXO.aco,
} as const;

const col = {
  rank: { width: 16 },
  name: { width: 150 },
  bar: { flex: 1, minWidth: 70 },
  num: { width: 38, textAlign: "right" as const },
  share: { width: 34, textAlign: "right" as const },
};

// Colunas da tabela de orçamentos por vendedor (BLOCO 1).
const bcol = {
  name: { flex: 1, minWidth: 120 },
  num: { width: 44, textAlign: "right" as const },
  money: { width: 82, textAlign: "right" as const },
};

/** Gera o PDF do relatório de produtividade da equipe. */
export async function renderTeamProductivityReport(
  data: TeamProductivityReportData,
): Promise<Buffer> {
  registerReportFonts();
  const hasActivity =
    data.totals.produtos > 0 ||
    data.totals.anuncios.total > 0 ||
    data.budgetTotals.orcamentos.count > 0;
  const doc = hasActivity ? <FullDoc data={data} /> : <EmptyDoc data={data} />;
  return renderToBuffer(doc);
}
