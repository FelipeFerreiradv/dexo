"use client";

// React explicito, como no `step-impostos.tsx` ao lado: o tsconfig usa jsx em
// modo preserve, entao o esbuild do vitest compila o JSX para o
// React.createElement classico e o componente so monta em jsdom com o React em
// escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import { useEffect, useState } from "react";
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
import type { TotaisDevolucao } from "@/app/fiscal/devolucao/tipos";
import { formatToBRL } from "@/components/ui/currency-input";
import { getApiBaseUrl } from "@/lib/api";
import { avisoEmissao } from "../../lib/nfe-aviso-emissao";
import {
  conferirValores,
  somarPagamentos,
} from "../../lib/nfe-conferencia-valores";
import {
  TIPO_OPERACAO_LABELS,
  FINALIDADE_LABELS,
  DESTINO_LABELS,
  MODALIDADE_FRETE_LABELS,
  MEIO_PAGAMENTO_LABELS,
} from "../../lib/nfe-defaults";

// Kill-switch da entrega de frete/medidas (ver step-frete.tsx).
const FRETE_MEDIDAS_ENABLED =
  process.env.NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED === "true";

interface Props {
  getValues: UseFormGetValues<NfeDraftFormData>;
  /**
   * `ambiente` da linha do rascunho (o wizard ja o tem em maos: vem do draft
   * carregado/criado). Opcional de proposito — ausente, o aviso NAO afirma
   * homologacao, ele fica neutro. Ver lib/nfe-aviso-emissao.
   */
  ambienteRascunho?: string | null;
  /** E-mail da sessao, so para o GET best-effort da config fiscal. */
  email?: string;
  /**
   * Multi-CNPJ: a empresa (CompanyFiscalConfig) DESTE rascunho. A emissao usa a
   * config dele, nao a padrao — com dois CNPJs em ambientes diferentes, ler a
   * padrao (GET /fiscal/config) fazia o aviso dizer o ambiente errado.
   * Ausente/null: le a padrao, exatamente como antes.
   */
  companyFiscalConfigId?: string | null;
  /**
   * Devolucao: os totais que a EMISSAO vai calcular (`DevolucaoDetalhe.totais`,
   * a mesma conta de `calcularDevolucao`). O valor da nota da devolucao inclui o
   * IPI devolvido, que a soma dos produtos abaixo nao ve. Ausente: nada muda.
   */
  totaisDevolucao?: TotaisDevolucao | null;
}

export function StepFinalizar({ getValues, ambienteRascunho, email, companyFiscalConfigId, totaisDevolucao }: Props) {
  const data = getValues();

  // Ambiente da CONFIGURACAO fiscal — a autoridade sobre o ambiente da emissao
  // (o NfeEmissionUseCase le `config.ambiente`; a coluna do rascunho pode estar
  // velha). Best-effort, mesmo padrao do NCM padrao em step-produtos.tsx:
  // falhou, fica null e o aviso cai no rascunho / no texto neutro — nunca em
  // "homologacao". Roda so aqui, no ultimo passo, uma vez.
  const [ambienteConfig, setAmbienteConfig] = useState<string | null>(null);
  // Enquanto esta leitura nao volta, um rascunho marcado HOMOLOGACAO nao pode
  // pintar a tela de "teste": pode ser justamente o rascunho velho. Ate la o
  // aviso fica neutro (ver resolverAmbienteEmissao).
  const [configResolvida, setConfigResolvida] = useState(false);
  useEffect(() => {
    // Sem e-mail nao ha como ler a config: fica NAO resolvida de proposito. O
    // atalho antigo marcava resolvida aqui, e um rascunho velho (que nasce
    // HOMOLOGACAO por historico) voltava a afirmar "sem valor fiscal" para quem
    // emite em producao — a mentira que este arquivo existe para matar.
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        // Multi-CNPJ: a empresa do rascunho, pela lista de empresas. Nao
        // achou a empresa ⇒ segue NAO resolvida (texto neutro), nunca cai na
        // padrao, que e justamente a que pode estar no outro ambiente.
        if (companyFiscalConfigId) {
          const res = await fetch(`${getApiBaseUrl()}/fiscal/companies`, {
            headers: { email },
          });
          if (!res.ok) return;
          const json = await res.json();
          if (cancelled) return;
          const empresa = Array.isArray(json?.companies)
            ? json.companies.find((c: { id?: unknown }) => c?.id === companyFiscalConfigId)
            : null;
          if (!empresa) return;
          setAmbienteConfig(empresa.ambiente ?? null);
          setConfigResolvida(true);
          return;
        }
        const res = await fetch(`${getApiBaseUrl()}/fiscal/config`, {
          headers: { email },
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setAmbienteConfig(json?.config?.ambiente ?? null);
        // `resolvida` SO no caminho de sucesso: leitura que falhou nao pode dar
        // ao rascunho a autoridade que ele nao tem. Falhou ⇒ texto neutro.
        setConfigResolvida(true);
      } catch {
        /* silencioso: segue nao resolvida */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, companyFiscalConfigId]);

  const aviso = avisoEmissao({
    ambienteConfig,
    ambienteRascunho,
    configResolvida,
    finalidade: data.finalidade,
    // Devolucao de VENDA e nota de ENTRADA; a de COMPRA e de SAIDA e referencia
    // a nota do FORNECEDOR. O campo ja esta no formulario (e a Revisao logo
    // abaixo ja o mostra em "Tipo Operacao"): sem ele o aviso chamava toda
    // devolucao de "nota de ENTRADA" — errado para quem devolve uma compra.
    tipoOperacao: data.tipoOperacao,
  });

  const totalProdutos = (data.itens ?? []).reduce(
    (sum, item) => sum + (Number(item.valorTotal) || 0),
    0,
  );

  // Mesma soma de antes, agora num so lugar: o total exibido no fim da tela e o
  // total conferido no quadro nao podem divergir entre si.
  const totalPagamentos = somarPagamentos(data.pagamentos);

  // O frete entra no total da nota (regra W16). Sem soma-lo, a Revisao diria
  // "tudo certo" logo depois de a etapa de Pagamentos ter avisado da diferenca
  // — e vice-versa. Sem frete, o numero e exatamente o de antes.
  const valorFrete = FRETE_MEDIDAS_ENABLED
    ? Number(data.valorFrete) || 0
    : 0;

  // Quadro de conferencia: o texto sai de lib/nfe-conferencia-valores (puro,
  // testado); aqui so a moldura. Em DEVOLUCAO o antigo "Divergencia nos
  // valores" disparava SEMPRE e mentia — devolucao nao tem pagamento.
  const conferencia = conferirValores({
    finalidade: data.finalidade,
    totalProdutos,
    totalFrete: valorFrete,
    pagamentos: data.pagamentos,
  });

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        Revisao da NF-e
      </h3>

      {conferencia.mostrar && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-700 dark:text-amber-200">
            <p className="font-medium">{conferencia.titulo}</p>
            {conferencia.linhas.map((linha, idx) => (
              <p key={idx} className="text-xs mt-1">
                {linha}
              </p>
            ))}
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
          ...(data.informacoesComplementares
            ? [["Observações", data.informacoesComplementares] as [string, string]]
            : []),
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
                {formatToBRL(Number(item.valorUnitario))} = R${" "}
                {formatToBRL(Number(item.valorTotal))}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-1 text-sm font-semibold">
          Total: R$ {formatToBRL(totalProdutos)}
        </div>
      </div>

      {/* Devolucao: o valor que a nota vai ter DE VERDADE (vNF), com o IPI
          devolvido — o "Total" dos produtos acima nao o inclui. Prevista
          enquanto algum item ainda nao fecha. Os numeros saem do servidor, da
          mesma conta da emissao; aqui so a moldura. */}
      {totaisDevolucao && (
        <div
          className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-2"
          aria-label="Valor da nota de devolucao"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Package className="h-4 w-4 text-muted-foreground" />
            {totaisDevolucao.completo ? "Valor da nota de devolução" : "Valor da nota de devolução (prévia)"}
          </div>
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2 text-sm">
            {(
              [
                ["Produtos", totaisDevolucao.totalProdutos],
                ...(totaisDevolucao.totalDesconto > 0 ? [["Desconto", -totaisDevolucao.totalDesconto]] : []),
                ...(totaisDevolucao.totalFrete > 0 ? [["Frete", totaisDevolucao.totalFrete]] : []),
                ...(totaisDevolucao.totalIpiDevol > 0 ? [["IPI devolvido", totaisDevolucao.totalIpiDevol]] : []),
                ["ICMS", totaisDevolucao.totalIcms],
                ["PIS", totaisDevolucao.totalPis],
                ["COFINS", totaisDevolucao.totalCofins],
              ] as [string, number][]
            ).map(([rotulo, valor]) => (
              <div key={rotulo}>
                <span className="text-muted-foreground">{rotulo}: </span>
                <span>R$ {formatToBRL(valor)}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end pt-1 text-sm font-semibold">
            Valor da nota: R$ {formatToBRL(totaisDevolucao.totalNota)}
          </div>
          {!totaisDevolucao.completo && (
            <p className="text-xs text-amber-700 dark:text-amber-200">
              {totaisDevolucao.itensPendentes.length > 0
                ? `Prévia: ${totaisDevolucao.itensPendentes.length === 1 ? "o item" : "os itens"} ${totaisDevolucao.itensPendentes.join(", ")} ainda ${totaisDevolucao.itensPendentes.length === 1 ? "não fecha" : "não fecham"} (imposto a escolher ou a revisar no passo Impostos). O valor pode mudar.`
                : "Prévia: há imposto a escolher ou a revisar no passo Impostos. O valor pode mudar."}
            </p>
          )}
        </div>
      )}

      {/* Frete */}
      <SectionCard
        icon={Truck}
        title="Frete"
        items={[
          [
            "Modalidade",
            MODALIDADE_FRETE_LABELS[data.modalidadeFrete] ?? data.modalidadeFrete,
          ],
          ...(FRETE_MEDIDAS_ENABLED && Number(data.valorFrete) > 0
            ? [
                [
                  "Valor do frete",
                  `R$ ${formatToBRL(Number(data.valorFrete))}`,
                ] as [string, string],
              ]
            : []),
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
              <span>R$ {formatToBRL(Number(p.valor))}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end pt-1 text-sm font-semibold">
          Total: R$ {formatToBRL(totalPagamentos)}
        </div>
      </div>

      {/* Aviso do que o proximo clique faz DE VERDADE. O texto sai de
          lib/nfe-aviso-emissao (puro, testado): aqui so a moldura. */}
      <div
        className={
          aviso.tom === "atencao"
            ? "rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200"
            : "rounded-lg border border-blue-500/40 bg-blue-500/10 p-4 text-sm text-blue-600 dark:text-blue-300"
        }
      >
        <p className="font-semibold">{aviso.titulo}</p>
        {aviso.linhas.map((linha, idx) => (
          <p key={idx} className="mt-1 text-xs">
            {linha}
          </p>
        ))}
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
