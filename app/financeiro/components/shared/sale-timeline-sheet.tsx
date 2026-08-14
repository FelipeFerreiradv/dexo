"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { History, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  SALE_TIMELINE_PAGE_SIZE,
  fetchSaleTimeline,
  formatEventWhen,
  saleEventActor,
  saleEventDetailLine,
  saleEventLabel,
  saleEventTone,
  type SaleEventTone,
  type SaleTimelineEvent,
} from "../../lib/sale-timeline-client";

// BLOCO H — histórico da venda: painel lateral, SOMENTE LEITURA.
//
// Por que um sheet e não uma aba do FinanceDialog: quem lê o histórico não está
// editando. O dialog é um wizard de 4 passos com formulário vivo; encaixar
// leitura ali misturaria duas intenções e mexeria numa tela crítica de escrita.
// Aqui, nada além de um GET — e o painel pode ser aberto do Financeiro e do
// livro do dia do PDV com o mesmo componente.
//
// Compartilhado (shared/) pelo mesmo motivo do SaleStatusFilter: dois lugares,
// um comportamento, idêntico por construção.

interface Props {
  /** Venda aberta. `null` = painel fechado — é o próprio controle de abertura. */
  receivableId: string | null;
  /** Identificação no cabeçalho (documento, cliente…). Ausente = genérico. */
  saleLabel?: string | null;
  onOpenChange: (open: boolean) => void;
}

const TONE_DOT: Record<SaleEventTone, string> = {
  neutral: "bg-muted-foreground/40",
  success: "bg-green-500",
  danger: "bg-destructive",
  info: "bg-sky-500",
};

const TONE_BADGE: Record<SaleEventTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
};

export function SaleTimelineSheet({
  receivableId,
  saleLabel,
  onOpenChange,
}: Props) {
  const { data: session } = useSession();
  const [events, setEvents] = useState<SaleTimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // A última página veio cheia ⇒ pode haver mais. Não é certeza (a última
  // página cheia pode ser exatamente a última), e por isso o botão some quando
  // a busca seguinte não traz nada — em vez de mentir com um total inventado.
  const [podeTerMais, setPodeTerMais] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Trocar de venda zera tudo. Sem isto o histórico da venda anterior ficaria
  // visível no primeiro frame da próxima — e histórico errado é pior que
  // nenhum histórico.
  useEffect(() => {
    setEvents([]);
    setErro(null);
    setPodeTerMais(false);
  }, [receivableId]);

  const carregar = useCallback(async () => {
    const email = session?.user?.email;
    if (!receivableId || !email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setErro(null);
    try {
      const page = await fetchSaleTimeline(receivableId, email, {
        signal: ctrl.signal,
      });
      setEvents(page);
      setPodeTerMais(page.length === SALE_TIMELINE_PAGE_SIZE);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Erro fica NO PAINEL, não em toast: o painel existe só para isto, e um
      // toast some antes de o operador entender que não viu o histórico.
      setErro(
        e instanceof Error
          ? e.message
          : "Erro ao carregar o histórico da venda",
      );
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [receivableId, session?.user?.email]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const carregarMais = useCallback(async () => {
    const email = session?.user?.email;
    const ultimo = events[events.length - 1];
    if (!receivableId || !email || !ultimo) return;
    setLoadingMore(true);
    try {
      const page = await fetchSaleTimeline(receivableId, email, {
        before: ultimo.createdAt,
      });
      // Dedupe por id: dois eventos no MESMO milissegundo fariam o cursor
      // (`createdAt < before`) devolver um já carregado. É raro, mas o
      // recebimento grava PAID e a NFC-e grava FISCAL_EMITTED em sequência.
      setEvents((prev) => {
        const vistos = new Set(prev.map((e) => e.id));
        return [...prev, ...page.filter((e) => !vistos.has(e.id))];
      });
      setPodeTerMais(page.length === SALE_TIMELINE_PAGE_SIZE);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar mais eventos");
    } finally {
      setLoadingMore(false);
    }
  }, [receivableId, events, session?.user?.email]);

  return (
    <Sheet open={!!receivableId} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            Histórico da venda
          </SheetTitle>
          <SheetDescription>
            {saleLabel
              ? `${saleLabel} · tudo o que aconteceu com esta venda, do mais recente para o mais antigo.`
              : "Tudo o que aconteceu com esta venda, do mais recente para o mais antigo."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {loading && events.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : erro ? (
            <div className="space-y-3 py-10 text-center">
              <p className="font-mono text-xs text-destructive">{erro}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void carregar()}
              >
                <RotateCcw className="h-4 w-4" />
                Tentar de novo
              </Button>
            </div>
          ) : events.length === 0 ? (
            // Honestidade: o registro começou agora. Toda venda anterior está
            // vazia e não há nada a recuperar — dizer isso evita que o
            // operador conclua que a tela está quebrada.
            <div className="space-y-2 py-16 text-center">
              <p className="font-mono text-xs text-muted-foreground">
                Nenhum evento registrado nesta venda.
              </p>
              <p className="mx-auto max-w-xs text-[11px] leading-relaxed text-muted-foreground">
                O histórico passou a ser gravado a partir da ativação do
                recurso. Vendas anteriores a ela não têm eventos — nada foi
                perdido, simplesmente não havia registro antes.
              </p>
            </div>
          ) : (
            <ol className="relative space-y-0">
              {/* Fio da linha do tempo. `aria-hidden`: é decoração, e o leitor
                  de tela já tem a lista ordenada. */}
              <span
                aria-hidden
                className="absolute left-[5px] top-2 bottom-2 w-px bg-border"
              />
              {events.map((e) => {
                const tone = saleEventTone(e.type);
                const detalhe = saleEventDetailLine(e.type, e.details);
                return (
                  <li key={e.id} className="relative flex gap-3 py-3 pl-0">
                    <span
                      aria-hidden
                      className={cn(
                        "relative z-10 mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ring-2 ring-background",
                        TONE_DOT[tone],
                      )}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
                            TONE_BADGE[tone],
                          )}
                        >
                          {saleEventLabel(e.type)}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {formatEventWhen(e.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm leading-snug">
                        {e.message ?? saleEventLabel(e.type)}
                      </p>
                      {detalhe && (
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {detalhe}
                        </p>
                      )}
                      <p className="font-mono text-[11px] text-muted-foreground">
                        por {saleEventActor(e.actorName)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {podeTerMais && events.length > 0 && !erro && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={loadingMore}
              onClick={() => void carregarMais()}
            >
              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
              Carregar mais
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
