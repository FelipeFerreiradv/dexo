"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  SLUG_CANAL,
  TEXTO_CAMPO,
  precisaTravar,
  type CampoTravado,
  type CanalTravado,
} from "../lib/marketplace-field-lock";

export type { CampoTravado, CanalTravado };

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
   * Avisa o pai quando o operador libera o campo — e quando a liberação deixa
   * de valer. Existe porque o código de peça é cobrado em DOIS campos da tela
   * (o "Part Number" e o "Código OEM" da ficha técnica): são atributos
   * diferentes do Mercado Livre, congelados pela mesma regra, e uma confirmação
   * só destrava os dois.
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
  const txt = TEXTO_CAMPO[campo];

  // Por ref, e não na dependência do efeito: um pai que passe arrow inline
  // recriaria a função a cada render, o efeito rodaria de novo e a limpeza
  // desfaria a liberação que o operador acabou de confirmar.
  const avisarRef = useRef(onLiberadoChange);
  useEffect(() => {
    avisarRef.current = onLiberadoChange;
  }, [onLiberadoChange]);

  // Se este campo sai da tela — o operador trocou de produto, ou entrou no modo
  // anúncio, que renderiza outro ramo — a liberação morre junto. Sem isto o pai
  // continuaria achando que houve confirmação, e o "Código OEM" da ficha
  // ficaria destravado enquanto o "Part Number" volta travado: a trava que
  // governa os dois campos passaria a discordar de si mesma.
  useEffect(() => () => avisarRef.current?.(false), []);

  const liberar = () => {
    setLiberado(true);
    setConfirmando(false);
    onLiberadoChange?.(true);
  };

  if (!precisaTravar({ carregando, anunciosPublicados, liberado })) {
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
      data-testid={`campo-travado-${campo}-${SLUG_CANAL[canal]}`}
    >
      <Label>{rotulo}</Label>

      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {carregando
            ? "Verificando anúncios publicados…"
            : (valorAtual ?? "—")}
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
