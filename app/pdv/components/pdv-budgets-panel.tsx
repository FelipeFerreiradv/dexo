"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowRight, Loader2, ShoppingCart } from "lucide-react";

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
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatToBRL } from "@/components/ui/currency-input";
import { getApiBaseUrl } from "@/lib/api";
import { paymentMethodsForKind } from "@/app/lib/payment-methods";
import { SectionHeading } from "@/components/section-heading";
import { decideAutoReceive } from "../lib/pdv-finalize";

// Vínculo do PDV com o CRM de Orçamentos: lista os ABERTOS e converte em
// venda usando o POST /budgets/:id/convert EXISTENTE (mesma semântica do
// kanban em /clientes, que segue intocado), encadeando o recebimento quando
// "Receber agora" está ligado.

interface BudgetRow {
  id: string;
  document: string | null;
  reason: string | null;
  totalAmount: number;
  validUntil: string | null;
  customer?: { id: string; name: string } | null;
}

interface Props {
  refreshKey: number;
  onToast: (msg: string, type: "success" | "error" | "warning") => void;
  onChanged?: () => void;
  receiveNow: boolean;
}

const LIMIT = 10;
// Radix Select não aceita value="" — sentinela para "não informar".
const METHOD_NONE = "__none__";

export function PdvBudgetsPanel({
  refreshKey,
  onToast,
  onChanged,
  receiveNow,
}: Props) {
  const { data: session } = useSession();
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmRow, setConfirmRow] = useState<BudgetRow | null>(null);
  const [methodChoice, setMethodChoice] = useState<string>(METHOD_NONE);
  const [converting, setConverting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchList = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: "1",
        limit: String(LIMIT),
        status: "ABERTO",
      });
      const res = await fetch(`${getApiBaseUrl()}/budgets?${params}`, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("Erro ao buscar orçamentos");
      const data = await res.json();
      setRows((data.items || []) as BudgetRow[]);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [session?.user?.email, onToast]);

  useEffect(() => {
    fetchList();
  }, [fetchList, refreshKey]);

  const openConfirm = (r: BudgetRow) => {
    setMethodChoice(METHOD_NONE);
    setConfirmRow(r);
  };

  const handleConvert = async () => {
    const email = session?.user?.email;
    if (!email || !confirmRow) return;
    const paymentMethod = methodChoice === METHOD_NONE ? null : methodChoice;
    setConverting(true);
    try {
      // 1) Converte (endpoint existente; idempotente via budgetId @unique).
      const res = await fetch(
        `${getApiBaseUrl()}/budgets/${confirmRow.id}/convert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify(paymentMethod ? { paymentMethod } : {}),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Erro ao converter");
      const receivableId: string | undefined = data?.receivable?.id;

      // 2) Encadeia o recebimento (mesma regra da venda nova). A conversão já
      // aconteceu — falha daqui pra frente NUNCA a desfaz, só deixa PENDENTE.
      const decision = decideAutoReceive({ receiveNow, paymentMethod });
      if (!decision.pay || !receivableId) {
        onToast(
          decision.reason === "fiado"
            ? "Orçamento convertido em venda fiado — ficará PENDENTE em Contas a Receber."
            : "Orçamento convertido em Conta a Receber (PENDENTE). Use “Receber” no livro do dia para baixar o estoque.",
          "success",
        );
      } else {
        try {
          const payRes = await fetch(
            `${getApiBaseUrl()}/finance/receivables/${receivableId}/pay`,
            { method: "POST", headers: { email } },
          );
          if (!payRes.ok) throw new Error("Falha no recebimento");
          onToast(
            "Orçamento convertido e recebido — estoque baixado e anúncios sincronizados.",
            "success",
          );
        } catch {
          onToast(
            "O orçamento foi convertido, mas o recebimento falhou. A venda está PENDENTE — use “Receber” no livro do dia ou no Financeiro.",
            "warning",
          );
        }
      }
      setConfirmRow(null);
      fetchList();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", "error");
    } finally {
      setConverting(false);
    }
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <SectionHeading
          eyebrow="Pipeline · CRM"
          title="Orçamentos"
          accent="abertos"
          description="Converta um orçamento em venda balcão sem sair do caixa."
        />
      </CardHeader>
      <CardContent className="flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center font-mono text-xs text-muted-foreground">
            Nenhum orçamento aberto no momento.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {r.customer?.name ?? "—"}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {r.document || r.reason || `#${r.id.slice(-8)}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm tabular-nums">
                    {formatToBRL(r.totalAmount)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    title="Converter em venda"
                    onClick={() => openConfirm(r)}
                  >
                    <ShoppingCart className="h-4 w-4" />
                    Vender
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 border-t border-border/60 pt-4">
        <span className="font-mono text-[11px] text-muted-foreground">
          {rows.length} orçamento(s) aberto(s)
        </span>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/clientes">
            Kanban completo
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardFooter>

      <AlertDialog
        open={!!confirmRow}
        onOpenChange={(o) => {
          if (!o && !converting) setConfirmRow(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Converter orçamento em venda?</AlertDialogTitle>
            <AlertDialogDescription>
              Cria uma Conta a Receber (venda balcão) com o cliente e os itens
              do orçamento
              {confirmRow?.customer?.name
                ? ` de ${confirmRow.customer.name}`
                : ""}
              . O orçamento vira CONVERTIDO e a ação é irreversível.
              {receiveNow
                ? " Com “Receber agora” ligado, o estoque baixa em seguida (exceto Fiado)."
                : " Com “Receber agora” desligado, a venda fica PENDENTE."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Forma de pagamento</span>
            <Select value={methodChoice} onValueChange={setMethodChoice}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Não informar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={METHOD_NONE}>Não informar</SelectItem>
                {paymentMethodsForKind("receivable").map((m) => (
                  <SelectItem key={m.code} value={m.code}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={converting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={converting}
              onClick={(e) => {
                // Mantém o dialog aberto durante a conversão (fechamos
                // manualmente no sucesso).
                e.preventDefault();
                handleConvert();
              }}
            >
              {converting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Converter
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
