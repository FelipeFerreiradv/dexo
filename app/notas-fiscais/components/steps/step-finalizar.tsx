"use client";

import { UseFormGetValues } from "react-hook-form";
import {
  FileText,
  User,
  Package,
  Truck,
  CreditCard,
  AlertTriangle,
} from "lucide-react";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import {
  TIPO_OPERACAO_LABELS,
  FINALIDADE_LABELS,
  DESTINO_LABELS,
  MODALIDADE_FRETE_LABELS,
  MEIO_PAGAMENTO_LABELS,
} from "../../lib/nfe-defaults";

interface Props {
  getValues: UseFormGetValues<NfeDraftFormData>;
}

export function StepFinalizar({ getValues }: Props) {
  const data = getValues();

  const totalProdutos = (data.itens ?? []).reduce(
    (sum, item) => sum + (Number(item.valorTotal) || 0),
    0,
  );

  const totalPagamentos = (data.pagamentos ?? []).reduce(
    (sum, p) => sum + (Number(p.valor) || 0),
    0,
  );

  const diff = Math.abs(totalProdutos - totalPagamentos);

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        Revisao da NF-e
      </h3>

      {diff > 0.01 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-700">
            <p className="font-medium">Divergencia nos valores</p>
            <p className="text-xs mt-1">
              Total dos produtos (R$ {totalProdutos.toFixed(2)}) difere do total
              dos pagamentos (R$ {totalPagamentos.toFixed(2)}). Diferenca: R${" "}
              {diff.toFixed(2)}.
            </p>
          </div>
        </div>
      )}

      {/* Informacoes Gerais */}
      <SectionCard
        icon={FileText}
        title="Informacoes Gerais"
        items={[
          ["Serie", String(data.serie)],
          ["Tipo Operacao", TIPO_OPERACAO_LABELS[data.tipoOperacao] ?? data.tipoOperacao],
          ["Finalidade", FINALIDADE_LABELS[data.finalidade] ?? data.finalidade],
          ["Destino", DESTINO_LABELS[data.destinoOperacao] ?? data.destinoOperacao],
          ["Natureza", data.naturezaOperacao],
          ...(data.numeroPedido ? [["N. Pedido", data.numeroPedido] as [string, string]] : []),
        ]}
      />

      {/* Destinatario */}
      <SectionCard
        icon={User}
        title="Destinatario"
        items={[
          ["Nome", data.destinatario.nome || "-"],
          ["CPF/CNPJ", data.destinatario.cpfCnpj || "-"],
          ...(data.destinatario.email
            ? [["Email", data.destinatario.email] as [string, string]]
            : []),
          ...(data.destinatario.municipio
            ? [
                [
                  "Endereco",
                  [
                    data.destinatario.logradouro,
                    data.destinatario.numero,
                    data.destinatario.bairro,
                    data.destinatario.municipio,
                    data.destinatario.uf,
                  ]
                    .filter(Boolean)
                    .join(", "),
                ] as [string, string],
              ]
            : []),
        ]}
      />

      {/* Produtos */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Package className="h-4 w-4 text-muted-foreground" />
          Produtos ({data.itens.length} {data.itens.length === 1 ? "item" : "itens"})
        </div>
        <div className="space-y-1">
          {data.itens.map((item, idx) => (
            <div
              key={idx}
              className="flex justify-between text-sm border-b border-border/30 pb-1 last:border-0"
            >
              <span className="text-muted-foreground truncate max-w-[60%]">
                {item.numero}. {item.descricao}
              </span>
              <span>
                {Number(item.quantidade)} x R${" "}
                {Number(item.valorUnitario).toFixed(2)} = R${" "}
                {Number(item.valorTotal).toFixed(2)}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-1 text-sm font-semibold">
          Total: R$ {totalProdutos.toFixed(2)}
        </div>
      </div>

      {/* Frete */}
      <SectionCard
        icon={Truck}
        title="Frete"
        items={[
          [
            "Modalidade",
            MODALIDADE_FRETE_LABELS[data.modalidadeFrete] ?? data.modalidadeFrete,
          ],
          ...(data.transportadora?.nome
            ? [["Transportadora", data.transportadora.nome] as [string, string]]
            : []),
        ]}
      />

      {/* Pagamentos */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          Pagamentos
        </div>
        <div className="space-y-1">
          {data.pagamentos.map((p, idx) => (
            <div
              key={idx}
              className="flex justify-between text-sm border-b border-border/30 pb-1 last:border-0"
            >
              <span className="text-muted-foreground">
                {MEIO_PAGAMENTO_LABELS[p.meio] ?? p.meio}
              </span>
              <span>R$ {Number(p.valor).toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-1 text-sm font-semibold">
          Total: R$ {totalPagamentos.toFixed(2)}
        </div>
      </div>

      <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-4 text-center text-sm text-blue-600">
        Ao clicar em <strong>"Emitir NF-e"</strong>, a nota sera validada,
        numerada e enviada para autorizacao na SEFAZ em ambiente de
        homologacao.
      </div>
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  items,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  items: [string, string][];
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
        {items.map(([label, value], idx) => (
          <div key={idx} className="text-sm">
            <span className="text-muted-foreground">{label}: </span>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
