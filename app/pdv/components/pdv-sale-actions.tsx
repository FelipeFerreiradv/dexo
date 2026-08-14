"use client";

import { Fragment, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Ban,
  FileText,
  History,
  Loader2,
  MoreHorizontal,
  Printer,
  ReceiptText,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { printReceipt } from "@/app/financeiro/lib/print-receipt";
import { reverseSale } from "@/app/financeiro/lib/reverse-sale";
import {
  buildSaleActions,
  emittedDocsFor,
  type FiscalDocSummary,
  type SaleAction,
  type SaleActionKind,
  type SaleStatusForActions,
} from "../lib/pdv-actions";
import {
  createNfe55Draft,
  fetchFiscalDocs,
  printFiscalDanfe,
} from "../lib/pdv-fiscal-docs";
import { emitNfceForReceivable, nfceToastFor } from "../lib/pdv-nfce";

// Bloco D — menu "Ações" de uma linha do livro do dia.
//
// O que este componente NÃO faz: emitir NFC-e por conta própria. A emissão
// continua sendo a cadeia do PdvView (`onNfce` → runNfceChain), que já carrega
// o emitente do seletor multi-CNPJ e o roteamento pelo limite de R$ 10.000.
// Aqui só decidimos QUAL ação oferecer e a delegamos.
//
// A decisão vive em ../lib/pdv-actions.ts (módulo puro e testado). Este
// arquivo é só render + orquestração de I/O.

interface Props {
  saleId: string;
  status: SaleStatusForActions;
  totalAmount: number;
  nfceUi: boolean;
  fiscalUi: boolean;
  /** Cadeia de NFC-e do PdvView (emitir/consultar — idempotente no backend). */
  onNfce?: (receivableId: string, totalAmount?: number) => Promise<void>;
  /** Emitente selecionado no caixa (multi-CNPJ). Null = CNPJ padrão. */
  nfceCompanyId?: string | null;
  /** Bloco E: mostra "Cancelar venda". A permissão real é o guard do backend. */
  saleCancelUi?: boolean;
  /** Chamado após um cancelamento bem-sucedido, para recarregar a lista. */
  onReversed?: () => void;
  /**
   * BLOCO H — abre o histórico desta venda. AUSENTE ⇒ o item nem existe e o
   * menu renderiza exatamente como hoje. Quem monta o painel é o chamador: o
   * sheet vive fora da linha, senão haveria um por venda na tela.
   */
  onTimeline?: () => void;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
}

const ICONS: Record<SaleActionKind, typeof Printer> = {
  receipt: Printer,
  nfce: ReceiptText,
  nfe55: FileText,
  reverse: Ban,
};

export function PdvSaleActions({
  saleId,
  status,
  totalAmount,
  nfceUi,
  fiscalUi,
  onNfce,
  nfceCompanyId,
  saleCancelUi,
  onReversed,
  onTimeline,
  onToast,
}: Props) {
  const { data: session } = useSession();
  const router = useRouter();
  const [docs, setDocs] = useState<FiscalDocSummary[] | undefined>(undefined);
  const [busy, setBusy] = useState<SaleActionKind | null>(null);
  const [confirmReverse, setConfirmReverse] = useState(false);

  // Egress: o lookup das notas só acontece quando o operador ABRE o menu
  // desta linha — não é um fan-out de 10 requests ao carregar o livro do dia.
  // Uma vez carregado, não recarrega (o estado da nota não muda sozinho
  // enquanto o menu está na tela; qualquer ação nossa refaz o fetch).
  const handleOpenChange = useCallback(
    (open: boolean) => {
      const email = session?.user?.email;
      if (!open || docs !== undefined || !email) return;
      void fetchFiscalDocs(saleId, email).then(setDocs);
    },
    [saleId, docs, session?.user?.email],
  );

  const run = useCallback(
    async (action: SaleAction) => {
      // Ação destrutiva: nunca executa direto do menu — passa pela confirmação.
      if (action.kind === "reverse") {
        setConfirmReverse(true);
        return;
      }
      const email = session?.user?.email;
      if (!email) {
        onToast("Sessão expirada — entre novamente.", "error");
        return;
      }
      setBusy(action.kind);
      try {
        if (action.kind === "receipt") {
          const delivery = await printReceipt(saleId, email);
          onToast(
            delivery === "opened"
              ? "Recibo aberto para impressão."
              : "Pop-up bloqueado — o recibo foi baixado.",
            "success",
          );
          return;
        }

        if (action.intent === "reprint" && action.nfeId) {
          const modelo = action.kind === "nfce" ? "65" : "55";
          const delivery = await printFiscalDanfe(action.nfeId, email, modelo);
          onToast(
            delivery === "opened"
              ? "Documento aberto para impressão."
              : "Pop-up bloqueado — o documento foi baixado.",
            "success",
          );
          return;
        }

        if (action.kind === "nfce") {
          // emit E consult caem no MESMO POST idempotente: com nota
          // autorizada ele devolve "já emitida"; em processamento, o estado
          // atual. Nunca duplica documento (finance.usecase.ts:673-705).
          if (onNfce) {
            await onNfce(saleId, totalAmount);
          } else {
            // Sem cadeia de caixa (histórico do cliente): só "consult" chega
            // aqui — "emit" já vem desabilitado de buildSaleActions. E
            // "consult" só existe com nota AUTHORIZED/PROCESSING, então este
            // POST é garantidamente uma consulta, nunca uma emissão nova.
            const outcome = await emitNfceForReceivable(saleId, email);
            const t = nfceToastFor(outcome);
            onToast(t.message, t.type);
          }
          setDocs(undefined); // força relookup no próximo abrir
          return;
        }

        // NF-e 55
        if (action.intent === "consult") {
          router.push("/notas-fiscais/nfe");
          return;
        }
        await createNfe55Draft(saleId, email, nfceCompanyId);
        setDocs(undefined);
        onToast(
          "Rascunho de NF-e (modelo 55) criado. Revise o NCM em Notas Fiscais e emita.",
          "success",
        );
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Erro na ação", "error");
      } finally {
        setBusy(null);
      }
    },
    [saleId, totalAmount, session?.user?.email, onNfce, nfceCompanyId, onToast, router],
  );

  const doReverse = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) {
      onToast("Sessão expirada — entre novamente.", "error");
      return;
    }
    setBusy("reverse");
    try {
      await reverseSale(saleId, email);
      onToast(
        "Venda cancelada — estoque devolvido e anúncios reabertos.",
        "success",
      );
      setConfirmReverse(false);
      onReversed?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao cancelar", "error");
    } finally {
      setBusy(null);
    }
  }, [saleId, session?.user?.email, onToast, onReversed]);

  const actions = buildSaleActions({
    status,
    totalAmount,
    nfceUi,
    fiscalUi,
    saleCancelUi,
    docs,
    // Emitir NFC-e nova é operação de caixa: só onde existe a cadeia do
    // PdvView (com o emitente multi-CNPJ). No histórico do cliente o item
    // aparece desabilitado, mas reimprimir/consultar seguem funcionando.
    nfceEmitAvailable: Boolean(onNfce),
  }).filter((a) => a.visible);

  // Sem `onTimeline` a condição é idêntica à de antes. Com ele, o menu ainda
  // vale a pena mesmo que nenhuma impressão esteja disponível.
  if (actions.length === 0 && !onTimeline) return null;

  const emitidas = emittedDocsFor(docs);

  return (
    <>
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Ações da venda"
          disabled={busy !== null}
        >
          {busy !== null ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/* BLOCO H — leitura pura, e por isso vem antes de tudo: nada aqui
            imprime, emite ou cancela. O separador só existe quando há grupo
            depois dele. */}
        {onTimeline && (
          <DropdownMenuItem onSelect={() => onTimeline()}>
            <History className="h-4 w-4" />
            Histórico da venda
          </DropdownMenuItem>
        )}
        {onTimeline && actions.length > 0 && <DropdownMenuSeparator />}
        {actions.length > 0 && (
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Imprimir
          </DropdownMenuLabel>
        )}
        {actions.map((action, i) => {
          const Icon = ICONS[action.kind];
          // Separador entre o recibo (sem validade fiscal) e os documentos
          // fiscais — são naturezas diferentes e o operador não pode confundir.
          // Fragment (não <div>): um wrapper de elemento quebra a navegação
          // por teclado e o typeahead do Radix, que dependem dos itens serem
          // filhos diretos do Content.
          // ...e antes da ação destrutiva, que fecha o menu.
          const needsSeparator =
            (i === 1 && actions[0]?.kind === "receipt") ||
            action.kind === "reverse";
          return (
            <Fragment key={action.kind}>
              {needsSeparator && <DropdownMenuSeparator />}
              <DropdownMenuItem
                disabled={action.disabled}
                variant={action.kind === "reverse" ? "destructive" : "default"}
                // O motivo do bloqueio fica visível: nada de item cinza mudo.
                title={action.reason}
                // Sem preventDefault: o menu fecha ao acionar (Radix não
                // dispara onSelect em item desabilitado). O estado de progresso
                // fica no gatilho, que vira spinner enquanto `busy`.
                onSelect={() => void run(action)}
              >
                <Icon className="h-4 w-4" />
                <span className="flex flex-col">
                  <span>{action.label}</span>
                  {action.disabled && action.reason && (
                    <span className="text-[11px] text-muted-foreground">
                      {action.reason}
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>

    <AlertDialog open={confirmReverse} onOpenChange={setConfirmReverse}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancelar esta venda?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                O estoque das peças volta para o catálogo e os anúncios que
                tinham zerado são reabertos. A venda fica com status CANCELADA e
                deixa de contar no faturamento.
              </p>
              {emitidas.length > 0 && (
                // §22.f do plano: cancelamento fiscal tem prazo de 24h e exige
                // justificativa. Avisar é obrigação; disparar automaticamente
                // seria decidir sozinho sobre um documento legal.
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
                  <strong>Atenção:</strong> esta venda tem{" "}
                  {emitidas
                    .map((d) =>
                      d.modelo === "65"
                        ? `NFC-e nº ${d.numero ?? "?"}`
                        : `NF-e nº ${d.numero ?? "?"}`,
                    )
                    .join(" e ")}
                  . Cancelar a venda <strong>não cancela a nota</strong> — o
                  cancelamento fiscal tem prazo de 24h e exige justificativa, e
                  é feito no módulo Notas Fiscais.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy === "reverse"}>
            Voltar
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy === "reverse"}
            onClick={(e) => {
              // Sem o preventDefault o Radix fecha o diálogo antes da resposta
              // e o operador não vê o resultado (nem o 403 de permissão).
              e.preventDefault();
              void doReverse();
            }}
          >
            {busy === "reverse" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
            Cancelar venda
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
