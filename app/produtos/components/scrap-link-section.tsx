"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Loader2, Recycle } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import {
  NO_SCRAP,
  describeRelinkImpact,
  scrapSelectValueToId,
  type ScrapLinkImpact,
} from "../lib/scrap-relink";

// BLOCO J — trocar (ou remover) a sucata de uma peça já cadastrada.
//
// Vive em componente PRÓPRIO, e não solto dentro do modal de edição de 3,7 mil
// linhas, por uma razão prática: a troca tem endpoint próprio, confirmação
// própria e efeito próprio (reconcilia dois lotes). Empurrar isso para o
// "Salvar" geral faria uma reatribuição de vendas acontecer escondida no meio
// de uma edição de preço.
//
// ⚠️ SEM AUTOFILL, ao contrário do modal de CRIAÇÃO. Lá, escolher a sucata
// preenche marca/modelo/ano a partir do veículo — o que faz sentido num
// cadastro em branco. Aqui seria sobrescrever campos que alguém já revisou e
// salvou, por causa de um clique num seletor de vínculo. Trocar o lote troca o
// LOTE, e nada mais.

interface ScrapOption {
  id: string;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  plate?: string | null;
}

interface LinkInfo extends ScrapLinkImpact {
  scrapId: string | null;
  scrapLabel: string | null;
}

interface Props {
  productId: string;
  onToast: (message: string, type: "success" | "error" | "warning") => void;
  /** Chamado após uma troca bem-sucedida (a lista de produtos recarrega). */
  onChanged?: () => void;
}

function scrapLabel(s: ScrapOption): string {
  const base = [s.brand, s.model, s.year ? String(s.year) : null]
    .filter(Boolean)
    .join(" ");
  const placa = s.plate ? ` (${s.plate})` : "";
  return `${base || s.id}${placa}`;
}

export function ScrapLinkSection({ productId, onToast, onChanged }: Props) {
  const { data: session } = useSession();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [scraps, setScraps] = useState<ScrapOption[]>([]);
  const [scrapsLoaded, setScrapsLoaded] = useState(false);
  const [valor, setValor] = useState<string>(NO_SCRAP);
  const [confirmando, setConfirmando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Vínculo atual + números do impacto: 1 GET, ao abrir. É o que permite o
  // seletor já mostrar a sucata certa em vez de "sem sucata" por omissão.
  useEffect(() => {
    const email = session?.user?.email;
    if (!email || !productId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void (async () => {
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/products/${productId}/scrap-link`,
          { headers: { email }, signal: ctrl.signal },
        );
        if (!res.ok) return;
        const data = (await res.json()) as LinkInfo;
        setInfo(data);
        setValor(data.scrapId ?? NO_SCRAP);
      } catch {
        // Silencioso: a seção é acessória e não pode derrubar a edição.
      }
    })();
    return () => ctrl.abort();
  }, [productId, session?.user?.email]);

  // Lista de sucatas SOB DEMANDA — só quando o operador abre o seletor. Abrir
  // o modal de edição não pode custar uma listagem de 100 lotes que quase
  // ninguém vai consultar.
  const carregarScraps = useCallback(async () => {
    const email = session?.user?.email;
    if (!email || scrapsLoaded) return;
    setScrapsLoaded(true);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/scraps?status=AVAILABLE&limit=100`,
        { headers: { email } },
      );
      if (!res.ok) throw new Error("falha");
      const data = await res.json();
      setScraps((data?.scraps ?? []) as ScrapOption[]);
    } catch {
      setScrapsLoaded(false); // deixa tentar de novo no próximo abrir
      onToast("Não foi possível carregar as sucatas.", "error");
    }
  }, [session?.user?.email, scrapsLoaded, onToast]);

  const alvo = scrapSelectValueToId(valor);
  const mudou = alvo !== (info?.scrapId ?? null);

  const trocar = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    setSalvando(true);
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/products/${productId}/scrap`,
        {
          method: "PATCH",
          headers: { email, "Content-Type": "application/json" },
          body: JSON.stringify({ scrapId: alvo }),
        },
      );
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) throw new Error(data?.error || "Erro ao trocar a sucata");
      onToast(
        alvo ? "Sucata da peça alterada." : "Peça desvinculada da sucata.",
        "success",
      );
      setConfirmando(false);
      // Números e rótulo mudaram: recarrega o vínculo para o próximo aviso não
      // sair desatualizado.
      setInfo((prev) =>
        prev ? { ...prev, scrapId: alvo, scrapLabel: null } : prev,
      );
      onChanged?.();
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao trocar", "error");
    } finally {
      setSalvando(false);
    }
  }, [productId, alvo, session?.user?.email, onToast, onChanged]);

  // A sucata ATUAL entra na lista mesmo que não esteja AVAILABLE (ela pode
  // estar EM USO ou ESGOTADA — que é o normal para um lote com peças
  // vendidas). Sem isto, o seletor abriria mostrando "sem sucata" e a
  // primeira interação apagaria o vínculo sem ninguém pedir.
  const opcoes: ScrapOption[] = info?.scrapId
    ? scraps.some((s) => s.id === info.scrapId)
      ? scraps
      : [
          {
            id: info.scrapId,
            brand: info.scrapLabel ?? "Sucata atual",
            model: null,
            year: null,
          },
          ...scraps,
        ]
    : scraps;

  const linhas = info ? describeRelinkImpact(info) : [];

  return (
    <div className="space-y-2">
      <Label htmlFor="edit-scrap-link" className="flex items-center gap-1.5">
        <Recycle className="size-3.5 text-muted-foreground" />
        Sucata de origem
      </Label>
      <div className="flex gap-2">
        <Select
          value={valor}
          onValueChange={setValor}
          onOpenChange={(aberto) => aberto && void carregarScraps()}
          disabled={salvando}
        >
          <SelectTrigger id="edit-scrap-link" className="flex-1">
            <SelectValue placeholder="Sem sucata" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SCRAP}>Sem sucata</SelectItem>
            {opcoes.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {scrapLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={!mudou || salvando}
          onClick={() => setConfirmando(true)}
        >
          {salvando && <Loader2 className="size-4 animate-spin" />}
          Alterar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Muda apenas o lote a que esta peça pertence — nenhum outro campo do
        cadastro é alterado. A troca é aplicada na hora, fora do “Salvar”.
      </p>

      <AlertDialog open={confirmando} onOpenChange={setConfirmando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alvo ? "Trocar a sucata desta peça?" : "Desvincular da sucata?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {alvo
                    ? "A peça deixa de contar no lote atual e passa a contar no novo."
                    : "A peça deixa de contar em qualquer lote."}
                </p>
                {linhas.length > 0 && (
                  // Consentimento informado: números, não um "tem certeza?".
                  // Os contadores da sucata são derivados do vínculo, então a
                  // troca REATRIBUI o que a peça já vendeu.
                  <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
                    <p className="font-medium">Esta peça já tem vendas:</p>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {linhas.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    <p className="text-[11px]">
                      Nenhuma venda é apagada — o valor e a data continuam os
                      mesmos. Muda a qual lote ela é atribuída.
                    </p>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={salvando}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              disabled={salvando}
              onClick={(e) => {
                // Sem preventDefault o diálogo fecha antes da resposta e o
                // operador não vê o resultado.
                e.preventDefault();
                void trocar();
              }}
            >
              {salvando && <Loader2 className="size-4 animate-spin" />}
              {alvo ? "Trocar sucata" : "Desvincular"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
