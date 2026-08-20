"use client";

import { useState } from "react";
import { Lock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type CanalTravado = "Mercado Livre" | "Shopee";

/** Slug estável para `data-testid` — o nome do canal tem espaço. */
const SLUG: Record<CanalTravado, string> = {
  "Mercado Livre": "ml",
  Shopee: "shopee",
};

/**
 * Os dois campos que o marketplace congela na publicação. Cada um tem a sua
 * frase porque a concordância muda ("a categoria … ela"; "o código … ele"), e
 * texto de aviso mal escrito é texto que o operador não lê.
 */
export type CampoTravado = "categoria" | "codigo";

const CAMPO: Record<
  CampoTravado,
  { nome: string; naoAceita: string; continuam: string; personalizacao: string }
> = {
  categoria: {
    nome: "categoria",
    naoAceita: "trocar a categoria de um anúncio que já está no ar",
    continuam: "continuam na categoria atual",
    personalizacao:
      "Se algum anúncio tiver categoria personalizada, ela é desfeita",
  },
  codigo: {
    nome: "código de peça",
    naoAceita: "alterar o código de peça de um anúncio que já está no ar",
    continuam: "continuam com o código atual",
    personalizacao:
      "Se algum anúncio tiver código personalizado, ele é desfeito",
  },
};

interface LockedMarketplaceFieldProps {
  canal: CanalTravado;
  campo: CampoTravado;
  rotulo: string;
  /** Quantos anúncios DESTE canal já estão publicados para este produto. */
  anunciosPublicados: number;
  /** A lista de anúncios ainda não respondeu — não dá para decidir ainda. */
  carregando: boolean;
  /** Valor atual, legível, para exibir enquanto travado. */
  valorAtual: string | null;
  /**
   * Avisa o pai quando o operador libera o campo. Existe porque o código de
   * peça vive em DOIS lugares da tela (o campo "Part Number" e o "Código OEM"
   * da ficha técnica) — é o mesmo dado, e uma trava só governa os dois.
   */
  onLiberadoChange?: (liberado: boolean) => void;
  /** O campo de verdade. Só é montado quando está liberado. */
  children: React.ReactNode;
}

/**
 * Trava um campo que o marketplace congela na publicação, quando o produto JÁ
 * tem anúncio no ar naquele canal.
 *
 * O campo é legítimo: é ele que define com o que os PRÓXIMOS anúncios nascem.
 * O problema é que, num produto já anunciado, ele parecia prometer uma coisa
 * que o marketplace não entrega. Quem alterava e salvava via "salvo com
 * sucesso" e concluía, com razão, que o anúncio tinha mudado. O aviso em letra
 * miúda embaixo do campo não resolvia: ninguém lê o aviso de um campo que
 * parece funcionar.
 *
 * Então o campo trava, diz por que, e só libera depois de uma confirmação que
 * enumera o que vai e o que NÃO vai acontecer. Produto sem anúncio publicado
 * não passa por nada disso — não há o que confundir.
 */
export function LockedMarketplaceField({
  canal,
  campo,
  rotulo,
  anunciosPublicados,
  carregando,
  valorAtual,
  onLiberadoChange,
  children,
}: LockedMarketplaceFieldProps) {
  const [liberado, setLiberado] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const txt = CAMPO[campo];

  const liberar = () => {
    setLiberado(true);
    setConfirmando(false);
    onLiberadoChange?.(true);
  };

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
              <strong>{txt.continuam}</strong>. Esta alteração vale para os
              próximos.
            </span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="space-y-1"
      data-testid={`campo-travado-${campo}-${SLUG[canal]}`}
    >
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
            Travado porque este produto já tem{" "}
            <strong>
              {anunciosPublicados} anúncio(s) publicado(s) no {canal}
            </strong>
            . O {canal} não aceita {txt.naoAceita}.
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
              no {canal} <strong>{txt.continuam}</strong>. O {canal} não permite{" "}
              {txt.naoAceita}.
            </li>
            <li>
              O novo valor vale para os <strong>próximos anúncios</strong> deste
              produto.
            </li>
            <li>
              {txt.personalizacao} — o produto passa a ser a fonte da verdade
              desse campo.
            </li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" onClick={liberar}>
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

export default LockedMarketplaceField;
