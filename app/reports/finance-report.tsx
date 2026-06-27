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
  Footer,
  Kpi,
  KpiRow,
  LegendDot,
  RunningHeader,
  SectionHeader,
  fmtBRL,
  fmtBRLCompact,
  fmtInt,
  pctLabel,
  s,
} from "./primitives";
import { AreaTimeline, DonutGeneric } from "./charts";
import { paymentMethodLabel } from "../lib/payment-methods";
import type { FinanceReportResult, StatusBucket } from "../lib/finance-report";

export interface FinanceReportData {
  company: string;
  generatedAtLabel: string;
  range: { startDate: string; endDate: string; label: string };
  result: FinanceReportResult;
}

const CONTENT_W = 595.28 - 44 * 2;

// Cores de categoria e situação (paleta Dexo, sem vermelho da referência).
const CAT = {
  receber: DEXO.amarelo,
  balcao: DEXO.verdeOperacao,
  avulso: DEXO.amareloClaro,
  pagar: DEXO.petroleoMedio,
};
const STATUS = {
  pago: DEXO.verdeOperacao, // recebido / pago
  pendente: DEXO.amarelo, // no prazo
  vencido: DEXO.aco, // atenção (sem vermelho)
};

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

function StatusBar({ b }: { b: StatusBucket }) {
  const seg = (v: number, color: string) =>
    b.total > 0 && v > 0 ? (
      <View
        style={{
          width: `${(v / b.total) * 100}%`,
          backgroundColor: color,
          height: "100%",
        }}
      />
    ) : null;
  return (
    <View
      style={{
        height: 9,
        borderRadius: 4,
        backgroundColor: DEXO.bege,
        overflow: "hidden",
        flexDirection: "row",
      }}
    >
      {seg(b.pago, STATUS.pago)}
      {seg(b.pendente, STATUS.pendente)}
      {seg(b.vencido, STATUS.vencido)}
    </View>
  );
}

function StatusLine({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
            marginRight: 5,
          }}
        />
        <Text style={{ fontFamily: FONT.sans, fontSize: 8, color: DEXO.aco }}>
          {label}
        </Text>
      </View>
      <Text
        style={{
          fontFamily: FONT.mono,
          fontSize: 8,
          color: DEXO.petroleoProfundo,
        }}
      >
        {fmtBRL(value)}
      </Text>
    </View>
  );
}

function StatusBox({
  title,
  accentColor,
  b,
}: {
  title: string;
  accentColor: string;
  b: StatusBucket;
}) {
  return (
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
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: accentColor,
              marginRight: 6,
            }}
          />
          <Text
            style={{
              fontFamily: FONT.mono,
              fontSize: 6.8,
              letterSpacing: 0.8,
              color: DEXO.aco,
            }}
          >
            {title.toUpperCase()}
          </Text>
        </View>
        <Text
          style={{
            fontFamily: FONT.sans,
            fontSize: 7,
            color: DEXO.aco,
          }}
        >
          {fmtInt(b.count)} conta(s)
        </Text>
      </View>
      <Text
        style={{
          fontFamily: FONT.display,
          fontSize: 20,
          color: DEXO.petroleoProfundo,
          marginBottom: 8,
        }}
      >
        {fmtBRL(b.total)}
      </Text>
      <StatusBar b={b} />
      <StatusLine color={STATUS.pago} label="Recebido / Pago" value={b.pago} />
      <StatusLine color={STATUS.pendente} label="Pendente" value={b.pendente} />
      <StatusLine color={STATUS.vencido} label="Vencido" value={b.vencido} />
    </View>
  );
}

function EmptyDoc({ data }: { data: FinanceReportData }) {
  return (
    <Document title="Relatório Financeiro — Dexo" author="Dexo">
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
              RELATÓRIO FINANCEIRO
            </Text>
            <Text
              style={{
                fontFamily: FONT.display,
                fontSize: 30,
                color: DEXO.creme,
                lineHeight: 1.05,
              }}
            >
              Sem lançamentos no período{"\n"}selecionado{" "}
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

function FullDoc({ data }: { data: FinanceReportData }) {
  const { result: rs, range } = data;
  const maxMethod = rs.byMethod.reduce(
    (m, x) => Math.max(m, x.receber + x.pagar),
    0,
  );
  const series = rs.timeseries.map((t) => t.receber);
  const secondary = rs.timeseries.map((t) => t.pagar);
  const firstDate = rs.timeseries[0]?.date;
  const lastDate = rs.timeseries[rs.timeseries.length - 1]?.date;
  const balcaoShare = pctLabel(rs.balcao.total, rs.receber.total);

  return (
    <Document title="Relatório Financeiro — Dexo" author="Dexo">
      <Page size="A4">
        <Cover
          kicker="Relatório Financeiro"
          title={"Contas &\nFluxo"}
          subtitle="Contas a pagar, a receber e venda balcão lançadas no período, com a situação atual de cada conta."
          periodLabel={range.label}
          company={data.company}
          generatedAtLabel={data.generatedAtLabel}
        />
      </Page>

      <Page size="A4" style={s.page} wrap>
        <RunningHeader company={data.company} periodLabel={range.label} />

        <SectionHeader>Resumo do período</SectionHeader>
        <KpiRow>
          <Kpi
            label="A receber"
            value={fmtBRLCompact(rs.receber.total)}
            valueFontSize={18}
            dot={CAT.receber}
          />
          <Kpi
            label="Venda balcão"
            value={fmtBRLCompact(rs.balcao.total)}
            valueFontSize={18}
            dot={CAT.balcao}
          />
          <Kpi
            label="A pagar"
            value={fmtBRLCompact(rs.pagar.total)}
            valueFontSize={18}
            dot={CAT.pagar}
          />
          <Kpi
            label="Saldo previsto"
            value={fmtBRLCompact(rs.saldoPrevisto)}
            valueFontSize={18}
            accent
          />
        </KpiRow>

        {/* Realizado */}
        <View
          style={{
            flexDirection: "row",
            gap: 24,
            borderWidth: 1,
            borderColor: DEXO.bege,
            borderRadius: 6,
            padding: 12,
            backgroundColor: DEXO.branco,
            marginBottom: 18,
          }}
        >
          <MoneyStat label="Recebido no período" value={rs.receber.pago} />
          <MoneyStat label="Pago no período" value={rs.pagar.pago} />
          <MoneyStat label="Saldo realizado" value={rs.saldoRealizado} />
        </View>

        {/* Receber × Pagar */}
        <View style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}>
          <StatusBox
            title="Contas a Receber"
            accentColor={CAT.receber}
            b={rs.receber}
          />
          <StatusBox
            title="Contas a Pagar"
            accentColor={CAT.pagar}
            b={rs.pagar}
          />
        </View>

        {/* Composição a receber (balcão × avulso) + Forma de pagamento */}
        <View style={{ flexDirection: "row", gap: 12, marginBottom: 18 }}>
          <View
            style={{
              width: 200,
              borderWidth: 1,
              borderColor: DEXO.bege,
              borderRadius: 6,
              padding: 12,
              backgroundColor: DEXO.branco,
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
              A RECEBER · BALCÃO × OUTRAS
            </Text>
            <DonutGeneric
              segments={[
                { value: rs.balcao.total, color: CAT.balcao },
                { value: rs.receberAvulso.total, color: CAT.avulso },
              ]}
            />
            <View style={{ flexDirection: "row", marginTop: 8 }}>
              <LegendDot color={CAT.balcao} label={`Balcão ${balcaoShare}`} />
              <LegendDot
                color={CAT.avulso}
                label={`Outras ${pctLabel(rs.receberAvulso.total, rs.receber.total)}`}
              />
            </View>
          </View>

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
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <Text
                style={{
                  fontFamily: FONT.mono,
                  fontSize: 6.8,
                  letterSpacing: 0.8,
                  color: DEXO.aco,
                }}
              >
                POR FORMA DE PAGAMENTO
              </Text>
              <View style={{ flexDirection: "row" }}>
                <LegendDot color={CAT.receber} label="Receber" />
                <LegendDot color={CAT.pagar} label="Pagar" />
              </View>
            </View>
            {rs.byMethod.length === 0 ? (
              <Text
                style={{ fontFamily: FONT.sans, fontSize: 8, color: DEXO.aco }}
              >
                Sem lançamentos.
              </Text>
            ) : (
              rs.byMethod.map((m, i) => (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 3,
                  }}
                >
                  <Text
                    style={{
                      width: 96,
                      fontFamily: FONT.sans,
                      fontSize: 8,
                      color: DEXO.petroleoProfundo,
                    }}
                  >
                    {paymentMethodLabel(m.method)}
                  </Text>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <View
                      style={{
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: DEXO.bege,
                        overflow: "hidden",
                        flexDirection: "row",
                        width: `${maxMethod ? ((m.receber + m.pagar) / maxMethod) * 100 : 0}%`,
                      }}
                    >
                      <View
                        style={{
                          width: `${m.receber + m.pagar > 0 ? (m.receber / (m.receber + m.pagar)) * 100 : 0}%`,
                          backgroundColor: CAT.receber,
                        }}
                      />
                      <View
                        style={{
                          width: `${m.receber + m.pagar > 0 ? (m.pagar / (m.receber + m.pagar)) * 100 : 0}%`,
                          backgroundColor: CAT.pagar,
                        }}
                      />
                    </View>
                  </View>
                  <Text
                    style={{
                      width: 82,
                      textAlign: "right",
                      fontFamily: FONT.mono,
                      fontSize: 7.5,
                      color: DEXO.petroleoProfundo,
                    }}
                  >
                    {fmtBRL(m.receber)}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>

        {/* Fluxo no período */}
        <View wrap={false}>
          <SectionHeader>Fluxo no período</SectionHeader>
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
              series={series}
              secondary={secondary}
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
              <LegendDot color={DEXO.amarelo} label="A receber / dia" />
              <LegendDot color={DEXO.aco} label="A pagar / dia" />
            </View>
          </View>
        </View>

        <Footer periodLabel={range.label} />
      </Page>
    </Document>
  );
}

function MoneyStat({ label, value }: { label: string; value: number }) {
  return (
    <View>
      <Text
        style={{
          fontFamily: FONT.display,
          fontSize: 16,
          color: value < 0 ? DEXO.aco : DEXO.petroleoProfundo,
        }}
      >
        {fmtBRL(value)}
      </Text>
      <Text style={{ fontFamily: FONT.sans, fontSize: 7, color: DEXO.aco }}>
        {label}
      </Text>
    </View>
  );
}

const axisLabel = {
  fontFamily: FONT.mono,
  fontSize: 6.5,
  color: DEXO.aco,
} as const;

export async function renderFinanceReport(
  data: FinanceReportData,
): Promise<Buffer> {
  registerReportFonts();
  const empty =
    data.result.receber.count === 0 && data.result.pagar.count === 0;
  return renderToBuffer(
    empty ? <EmptyDoc data={data} /> : <FullDoc data={data} />,
  );
}
