import React from "react";
import fs from "fs";
import path from "path";
import {
  Document,
  Page,
  Text,
  View,
  Image,
  renderToBuffer,
} from "@react-pdf/renderer";
import { DEXO, FONT } from "./theme";
import { registerReportFonts } from "./fonts";
import { Footer, SectionHeader, fmtBRL, fmtInt, s } from "./primitives";

// PDF do Orçamento (BLOCO 1). Stack @react-pdf (mesma identidade dos relatórios
// de dashboard/colaboradores). Documento deixa CLARO que é orçamento — sem
// validade fiscal — e exibe a validade. Reusa theme/fonts/primitives DEXO.

export interface BudgetReportItem {
  label: string;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface BudgetReportData {
  company: {
    razaoSocial: string | null;
    nomeFantasia: string | null;
    cnpj: string | null;
    inscricaoEstadual: string | null;
    addressLine: string | null;
  } | null;
  companyName: string; // fallback de exibição quando não há config fiscal
  budgetNumber: string;
  statusLabel: string;
  client: { name: string; doc: string | null; email: string | null };
  items: BudgetReportItem[];
  total: number;
  validUntilLabel: string | null;
  notes: string | null;
  vendedor: string | null;
  generatedAtLabel: string;
}

// Logo (public/logo.jpg) como data URI — cache em memória (arquivo imutável).
let logoCache: string | false | null = null;
function loadLogoDataUri(): string | null {
  if (logoCache === false) return null;
  if (logoCache) return logoCache;
  try {
    const p = path.resolve(process.cwd(), "public", "logo.jpg");
    const b = fs.readFileSync(p);
    logoCache = `data:image/jpeg;base64,${b.toString("base64")}`;
    return logoCache;
  } catch {
    logoCache = false;
    return null;
  }
}

const meta = {
  fontFamily: FONT.mono,
  fontSize: 7,
  color: DEXO.aco,
  letterSpacing: 0.4,
  marginTop: 2,
} as const;
const card = {
  borderWidth: 1,
  borderColor: DEXO.bege,
  borderRadius: 6,
  backgroundColor: DEXO.branco,
  padding: 10,
  marginBottom: 16,
} as const;
const row = { flexDirection: "row", alignItems: "flex-start" } as const;
const th = {
  fontFamily: FONT.mono,
  fontSize: 6.8,
  letterSpacing: 0.6,
  color: DEXO.aco,
} as const;
const td = {
  fontFamily: FONT.sans,
  fontSize: 8.5,
  color: DEXO.petroleoProfundo,
} as const;
const tdMono = {
  fontFamily: FONT.mono,
  fontSize: 8,
  color: DEXO.petroleoProfundo,
} as const;

function BudgetDoc({ data }: { data: BudgetReportData }) {
  const logo = loadLogoDataUri();
  const headerName =
    data.company?.nomeFantasia ||
    data.company?.razaoSocial ||
    data.companyName;

  return (
    <Document title={`Orçamento ${data.budgetNumber} — Dexo`} author="Dexo">
      <Page size="A4" style={s.page} wrap>
        {/* Cabeçalho: logo + empresa | ORÇAMENTO + nº */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 14,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {logo ? (
              <Image
                src={logo}
                style={{ width: 38, height: 38, borderRadius: 5, marginRight: 10 }}
              />
            ) : null}
            <View>
              <Text
                style={{
                  fontFamily: FONT.display,
                  fontSize: 13,
                  color: DEXO.petroleoProfundo,
                }}
              >
                {headerName}
              </Text>
              {data.company?.cnpj ? (
                <Text style={meta}>
                  CNPJ {data.company.cnpj}
                  {data.company.inscricaoEstadual
                    ? ` · IE ${data.company.inscricaoEstadual}`
                    : ""}
                </Text>
              ) : null}
              {data.company?.addressLine ? (
                <Text style={meta}>{data.company.addressLine}</Text>
              ) : null}
            </View>
          </View>

          <View style={{ alignItems: "flex-end" }}>
            <Text
              style={{
                fontFamily: FONT.display,
                fontSize: 22,
                color: DEXO.petroleoProfundo,
              }}
            >
              ORÇAMENTO <Text style={{ color: DEXO.amarelo }}>*</Text>
            </Text>
            <Text style={meta}>Nº {data.budgetNumber}</Text>
            <Text style={meta}>Emitido em {data.generatedAtLabel}</Text>
            {data.vendedor ? (
              <Text style={meta}>Vendedor: {data.vendedor}</Text>
            ) : null}
          </View>
        </View>

        {/* Faixa: deixa explícito que NÃO é documento fiscal + validade */}
        <View
          style={{
            backgroundColor: DEXO.petroleoProfundo,
            borderRadius: 5,
            paddingVertical: 6,
            paddingHorizontal: 10,
            marginBottom: 16,
            flexDirection: "row",
            justifyContent: "space-between",
          }}
        >
          <Text
            style={{
              fontFamily: FONT.mono,
              fontSize: 7.5,
              color: DEXO.amarelo,
              letterSpacing: 1,
            }}
          >
            ORÇAMENTO — SEM VALIDADE FISCAL
          </Text>
          <Text
            style={{
              fontFamily: FONT.mono,
              fontSize: 7.5,
              color: DEXO.creme,
              letterSpacing: 1,
            }}
          >
            {data.validUntilLabel
              ? `VÁLIDO ATÉ ${data.validUntilLabel}`
              : "SEM DATA DE VALIDADE"}
          </Text>
        </View>

        {/* Cliente */}
        <SectionHeader>Cliente</SectionHeader>
        <View style={card}>
          <Text
            style={{
              fontFamily: FONT.sans,
              fontSize: 11,
              color: DEXO.petroleoProfundo,
            }}
          >
            {data.client.name}
          </Text>
          <Text style={meta}>
            {[
              data.client.doc ? `CPF/CNPJ ${data.client.doc}` : null,
              data.client.email,
            ]
              .filter(Boolean)
              .join(" · ") || "—"}
          </Text>
        </View>

        {/* Itens */}
        <SectionHeader>Itens</SectionHeader>
        <View style={{ marginBottom: 10 }}>
          <View
            style={[
              row,
              { borderBottomWidth: 1, borderBottomColor: DEXO.aco, paddingBottom: 4 },
            ]}
          >
            <Text style={[th, { width: 22 }]}>#</Text>
            <Text style={[th, { flex: 1 }]}>DESCRIÇÃO</Text>
            <Text style={[th, { width: 40, textAlign: "right" }]}>QTD</Text>
            <Text style={[th, { width: 74, textAlign: "right" }]}>PREÇO UN.</Text>
            <Text style={[th, { width: 80, textAlign: "right" }]}>SUBTOTAL</Text>
          </View>

          {data.items.length === 0 ? (
            <Text
              style={{
                fontFamily: FONT.sans,
                fontSize: 9,
                color: DEXO.aco,
                paddingVertical: 8,
              }}
            >
              Orçamento de valor único (sem itens detalhados).
            </Text>
          ) : (
            data.items.map((it, i) => (
              <View
                key={i}
                style={[
                  row,
                  {
                    paddingVertical: 5,
                    borderBottomWidth: 0.5,
                    borderBottomColor: DEXO.bege,
                  },
                ]}
                wrap={false}
              >
                <Text style={[td, { width: 22, color: DEXO.aco }]}>{i + 1}</Text>
                <View style={{ flex: 1, paddingRight: 6 }}>
                  <Text style={td}>{it.label}</Text>
                  {it.sku ? (
                    <Text
                      style={{
                        fontFamily: FONT.mono,
                        fontSize: 6.5,
                        color: DEXO.aco,
                      }}
                    >
                      SKU {it.sku}
                    </Text>
                  ) : null}
                </View>
                <Text style={[td, { width: 40, textAlign: "right" }]}>
                  {fmtInt(it.quantity)}
                </Text>
                <Text style={[tdMono, { width: 74, textAlign: "right" }]}>
                  {fmtBRL(it.unitPrice)}
                </Text>
                <Text style={[tdMono, { width: 80, textAlign: "right" }]}>
                  {fmtBRL(it.subtotal)}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Total */}
        <View
          style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 16 }}
          wrap={false}
        >
          <View
            style={{
              backgroundColor: DEXO.petroleoProfundo,
              borderRadius: 6,
              paddingVertical: 10,
              paddingHorizontal: 16,
              minWidth: 210,
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text
              style={{
                fontFamily: FONT.mono,
                fontSize: 8,
                color: DEXO.amarelo,
                letterSpacing: 1,
              }}
            >
              TOTAL
            </Text>
            <Text
              style={{ fontFamily: FONT.display, fontSize: 20, color: DEXO.creme }}
            >
              {fmtBRL(data.total)}
            </Text>
          </View>
        </View>

        {/* Observações */}
        {data.notes ? (
          <View wrap={false} style={{ marginBottom: 8 }}>
            <SectionHeader>Observações</SectionHeader>
            <View style={card}>
              <Text
                style={{
                  fontFamily: FONT.sans,
                  fontSize: 9,
                  color: DEXO.petroleoProfundo,
                  lineHeight: 1.4,
                }}
              >
                {data.notes}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Nota textual reforçando a natureza do documento */}
        <Text
          style={{
            fontFamily: FONT.sans,
            fontSize: 7.5,
            color: DEXO.aco,
            marginTop: 2,
            lineHeight: 1.4,
          }}
        >
          Este documento é um ORÇAMENTO sem validade fiscal — não é cupom de
          venda nem documento fiscal.
          {data.validUntilLabel
            ? ` Proposta válida até ${data.validUntilLabel}.`
            : ""}{" "}
          Valores e disponibilidade sujeitos a confirmação no fechamento da
          venda.
        </Text>

        <Footer periodLabel={`Orçamento ${data.budgetNumber}`} />
      </Page>
    </Document>
  );
}

export async function renderBudgetReport(
  data: BudgetReportData,
): Promise<Buffer> {
  registerReportFonts();
  return renderToBuffer(<BudgetDoc data={data} />);
}
