"use client";

import { useState } from "react";
import { Lock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type CanalCategoria = "Mercado Livre" | "Shopee";

/** Slug estável para `data-testid` — o nome do canal tem espaço. */
const SLUG: Record<CanalCategoria, string> = {
  "Mercado Livre": "ml",
  Shopee: "shopee",
};

interface LockedCategoryFieldProps {
  canal: CanalCategoria;
  rotulo: string;
  /** Quantos anúncios DESTE canal já estão publicados para este produto. */
  anunciosPublicados: number;
  /** A lista de anúncios ainda não respondeu — não dá para decidir ainda. */
  carregando: boolean;
  /** Rótulo legível da categoria atual, para exibir enquanto travado. */
  valorAtual: string | null;
  /** O seletor de verdade. Só é montado quando o campo está liberado. */
  children: React.ReactNode;
}

/**
 * Trava a categoria quando o produto JÁ tem anúncio publicado no canal.
 *
 * O campo é legítimo: é ele que define onde os PRÓXIMOS anúncios nascem. O
 * problema é que, num produto já anunciado, ele parecia prometer uma coisa que
 * o marketplace não entrega — nem o Mercado Livre nem a Shopee aceitam trocar a
 * categoria de um anúncio publicado. Quem trocasse e salvasse veria "salvo com
 * sucesso" e concluiria, com razão, que o anúncio tinha mudado de categoria.
 * O aviso em letra miúda embaixo do campo não resolvia: ninguém lê o aviso de um
 * campo que parece funcionar.
 *
 * Então o campo trava, diz por que, e só libera depois de uma confirmação que
 * enumera o que vai e o que NÃO vai acontecer. Produto sem anúncio publicado
 * não passa por nada disso — não há o que confundir.
 */
export function LockedCategoryField({
  canal,
  rotulo,
  anunciosPublicados,
  carregando,
  valorAtual,
  children,
}: LockedCategoryFieldProps) {
  const [liberado, setLiberado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const precisaTravar = carregando || anunciosPublicados > 0;

  if (!precisaTravar || liberado) {
    return (
      <div className="space-y-2">
        {children}
        {anunciosPublicados > 0 && liberado && (
          <p
            className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500"
            role="status"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Os {anunciosPublicados} anúncio(s) já publicados no {canal}{" "}
              <strong>continuam na categoria atual</strong>. Esta troca vale para
              os próximos.
            </span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid={`categoria-travada-${SLUG[canal]}`}>
      <Label>{rotulo}</Label>

      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {carregando ? "Verificando anúncios publicados…" : (valorAtual ?? "—")}
        </span>
      </div>

      {carregando ? (
        <p className="text-xs text-muted-foreground">
          Conferindo se este produto já tem anúncio publicado no {canal}.
        </p>
      ) : !confirmando ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Travada porque este produto já tem{" "}
            <strong>
              {anunciosPublicados} anúncio(s) publicado(s) no {canal}
            </strong>
            . O {canal} não aceita trocar a categoria de um anúncio que já está
            no ar.
          </p>
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => setConfirmando(true)}
          >
            Alterar mesmo assim
          </button>
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="flex items-start gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>Antes de alterar, confira o que acontece:</span>
          </p>
          <ul className="ml-5 list-disc space-y-1 text-xs text-amber-900 dark:text-amber-200">
            <li>
              Os <strong>{anunciosPublicados} anúncio(s) já publicados</strong>{" "}
              no {canal} <strong>continuam na categoria atual</strong>. O{" "}
              {canal} não permite a troca depois de publicado.
            </li>
            <li>
              A nova categoria vale para os <strong>próximos anúncios</strong>{" "}
              deste produto.
            </li>
            <li>
              Se algum anúncio tiver categoria personalizada, ela é{" "}
              <strong>desfeita</strong> — o produto passa a ser a fonte da
              verdade desse campo.
            </li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setLiberado(true);
                setConfirmando(false);
              }}
            >
              Entendi, quero alterar
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmando(false)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default LockedCategoryField;
