"use client";

// React explicito, como no `ajuste-numeracao-card.tsx` ao lado: o tsconfig
// usa jsx em modo preserve, entao o esbuild do vitest compila o JSX para o
// React.createElement classico e o componente so monta em jsdom com o React
// em escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { UseFormGetValues } from "react-hook-form";
import { Calculator, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatToBRL } from "@/components/ui/currency-input";
import { getApiBaseUrl } from "@/lib/api";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import {
  viewErroCalculo,
  LINK_NOTAS_EMITIDAS,
  ROTULO_IR_PARA_NOTAS_EMITIDAS,
  TITULO_PASSO_A_PASSO,
  type ErroCalculoView,
} from "../../lib/nfe-erro-calculo-ui";
import { PendenciasDevolucao } from "../pendencias-devolucao";
import type { NfeTotais } from "@/app/fiscal/domain/nfe.types";

interface Props {
  getValues: UseFormGetValues<NfeDraftFormData>;
  draftId: string;
  email: string;
  onTotaisCalculated?: (totais: NfeTotais) => void;
}

export function StepImpostos({
  getValues,
  draftId,
  email,
  onTotaisCalculated,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [totais, setTotais] = useState<NfeTotais | null>(null);
  // O erro deixou de ser string: a decisao de tela (permanente x passageiro,
  // "Tentar novamente" x caminho de saida) mora em `nfe-erro-calculo-ui`.
  const [erro, setErro] = useState<ErroCalculoView | null>(null);

  const calculate = useCallback(async () => {
    setLoading(true);
    setErro(null);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/fiscal/nfe/draft/${draftId}/calculate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", email },
          body: "{}",
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Nao joga mais fora o `code`: era ele que distinguia o erro que
        // some ao tentar de novo do que nunca vai sumir.
        setErro(viewErroCalculo(data));
        return;
      }
      const data = await res.json();
      setTotais(data.totais ?? null);
      onTotaisCalculated?.(data.totais ?? null);
    } catch (err) {
      // Sem resposta (rede caiu, JSON quebrado): sem codigo, logo passageiro
      // — segue com o mesmo texto e o mesmo "Tentar novamente" de sempre.
      setErro(
        viewErroCalculo(
          { error: err instanceof Error ? err.message : undefined },
          "Erro ao calcular",
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [draftId, email, onTotaisCalculated]);

  useEffect(() => {
    calculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmt = (v: number | undefined | null) =>
    `R$ ${formatToBRL(v ?? 0)}`;

  if (loading && !totais) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Calculando impostos...
      </div>
    );
  }

  if (erro && !totais) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className={
            "rounded-lg border border-amber-500/40 bg-amber-500/10 p-6 " +
            (erro.permanente ? "text-left" : "text-center")
          }
        >
          {erro.titulo && (
            <p className="text-sm font-semibold text-amber-800">
              {erro.titulo}
            </p>
          )}
          <p
            className={
              "text-sm text-amber-700" + (erro.titulo ? " mt-2" : "")
            }
          >
            {erro.mensagem}
          </p>
          {erro.passos.length > 0 && (
            <>
              <p className="mt-4 text-sm font-semibold text-amber-800">
                {TITULO_PASSO_A_PASSO}
              </p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-amber-700">
                {erro.passos.map((passo) => (
                  <li key={passo}>{passo}</li>
                ))}
              </ol>
            </>
          )}
          {/* Erro que nunca muda sozinho nao ganha botao que so repete o
              erro: ganha o caminho de saida. Os demais seguem com o
              "Tentar novamente" de sempre. */}
          {erro.acao === "TENTAR_NOVAMENTE" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={calculate}
              className="mt-3"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Tentar novamente
            </Button>
          ) : (
            <a
              href={LINK_NOTAS_EMITIDAS}
              className="mt-4 inline-block text-sm font-medium text-primary underline"
            >
              {ROTULO_IR_PARA_NOTAS_EMITIDAS}
            </a>
          )}
        </div>
        {/* Bloqueio da devolucao (422 DEVOLUCAO_INVALIDA): a frase generica do
            servidor fica no quadro acima e a LISTA do que falta vem aqui, item
            a item. Ausente em todo o resto — nada mudou nos outros erros. */}
        {erro.pendencias && <PendenciasDevolucao view={erro.pendencias} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Impostos calculados
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={calculate}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1" />
          )}
          Recalcular
        </Button>
      </div>

      <div className="rounded-lg border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
        <Calculator className="h-4 w-4 inline-block mr-1 opacity-60" />
        Os valores abaixo sao calculados automaticamente com base no regime
        tributario do emissor e nos itens da nota. Nenhuma edicao e necessaria
        nesta etapa.
      </div>

      {totais && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card label="Total Produtos" value={fmt(totais.totalProdutos)} />
          <Card label="Total Desconto" value={fmt(totais.totalDesconto)} />
          <Card label="Base ICMS" value={fmt(totais.totalBcIcms)} />
          <Card label="Total ICMS" value={fmt(totais.totalIcms)} highlight />
          <Card label="Base IPI" value={fmt(totais.totalBcIpi)} />
          <Card label="Total IPI" value={fmt(totais.totalIpi)} highlight />
          <Card label="Total PIS" value={fmt(totais.totalPis)} />
          <Card label="Total COFINS" value={fmt(totais.totalCofins)} />
          <Card
            label="Total Tributos"
            value={fmt(totais.totalTributos)}
            highlight
          />
          <Card
            label="Total da Nota"
            value={fmt(totais.totalNota)}
            primary
          />
        </div>
      )}
    </div>
  );
}

function Card({
  label,
  value,
  highlight,
  primary,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  primary?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border p-3 " +
        (primary
          ? "border-primary/40 bg-primary/5"
          : highlight
            ? "border-border/60 bg-card/60"
            : "border-border/40 bg-card/30")
      }
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          "text-lg font-semibold " +
          (primary ? "text-primary" : "text-foreground")
        }
      >
        {value}
      </p>
    </div>
  );
}
