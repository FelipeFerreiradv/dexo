"use client";

// Read-only, purely presentational mock of how the listing will look on
// Mercado Livre. No fetch, no effects, no state, no mutation — props in, JSX out.
//
// Mercado Livre colors are kept as SCOPED arbitrary Tailwind values inside this
// file only (yellow #FFE600, blue #3483FA, green #00A650, grays) so they never
// leak into the rest of the app's theme.
//
// Dynamic content comes from the form view-model. Everything labelled
// "placeholder visual" below is STATIC/illustrative, present only so the mock
// resembles a real ML listing page.

import React from "react";
import { ImageOff, ChevronDown } from "lucide-react";
import type { ListingPreviewViewModel } from "./preview-utils";

export function MlListingPreview({ vm }: { vm: ListingPreviewViewModel }) {
  const mainImage = vm.images[0];

  return (
    <div className="rounded-lg bg-[#EBEBEB] p-2 sm:p-4 text-[#333]">
      {/* Cartão branco principal */}
      <div className="overflow-hidden rounded-lg bg-white shadow-sm">
        {/* Realce amarelo decorativo (identidade ML) — placeholder visual */}
        <div className="h-1.5 w-full bg-[#FFE600]" />

        {/* Breadcrumb de categoria (dinâmico) */}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-4 py-2 text-xs text-[#3483FA]">
          {vm.mlBreadcrumb.map((crumb, i) => (
            <span key={`${crumb}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-[#999]">›</span>}
              <span className="hover:underline">{crumb}</span>
            </span>
          ))}
        </div>

        {/* Barra "Verifique compatibilidade" — placeholder visual (estática) */}
        <div className="mx-4 mb-3 rounded-md border border-[#ededed] bg-white p-3">
          <p className="text-sm font-medium text-[#333]">
            Verifique se é compatível com seu veículo
          </p>
          <p className="mb-2 text-xs text-[#999]">
            Selecione os dados para conferir a compatibilidade.
          </p>
          <div className="flex flex-wrap gap-2">
            {["Marca", "Modelo", "Ano", "Versão"].map((f) => (
              <div
                key={f}
                className="flex min-w-[110px] flex-1 items-center justify-between rounded border border-[#ddd] px-2 py-1.5 text-xs text-[#999]"
              >
                <span>Selecionar</span>
                <ChevronDown className="h-3 w-3" />
              </div>
            ))}
          </div>
        </div>

        {/* Conteúdo: galeria | centro | box de compra */}
        <div className="flex flex-col gap-4 px-4 pb-4 lg:flex-row">
          {/* Galeria (dinâmica) */}
          <div className="flex gap-2 lg:w-[42%]">
            {/* Miniaturas verticais */}
            {vm.images.length > 0 && (
              <div className="flex flex-col gap-2">
                {vm.images.slice(0, 5).map((url, idx) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={`${url}-${idx}`}
                    src={url}
                    alt=""
                    className={`h-10 w-10 rounded border object-cover ${
                      idx === 0 ? "border-[#3483FA]" : "border-[#ddd]"
                    }`}
                  />
                ))}
              </div>
            )}
            {/* Imagem principal / placeholder */}
            <div className="flex flex-1 items-center justify-center rounded-lg bg-[#fafafa]">
              {mainImage ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={mainImage}
                  alt={vm.title}
                  className="max-h-72 w-full rounded-lg object-contain"
                />
              ) : (
                <div className="flex h-56 w-full flex-col items-center justify-center gap-2 text-[#bbb]">
                  <ImageOff className="h-10 w-10" />
                  <span className="text-xs">Sem imagem</span>
                </div>
              )}
            </div>
          </div>

          {/* Coluna central (dinâmica) */}
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2 text-xs text-[#999]">
              <span>{vm.condition}</span>
              {/* placeholder visual */}
              <span>|</span>
              <span>+1000 vendidos</span>
            </div>

            <h3 className="text-lg font-semibold leading-snug text-[#333] sm:text-xl">
              {vm.title}
            </h3>

            <div className="pt-1">
              <span className="text-3xl font-light text-[#333]">
                {vm.mlPriceFormatted}
              </span>
            </div>
            {/* parcelas — placeholder visual (ilustrativo) */}
            <p className="text-sm text-[#00A650]">em até 12x sem juros</p>
            <button
              type="button"
              disabled
              className="block text-left text-xs text-[#3483FA]"
            >
              Ver os meios de pagamento
            </button>

            {vm.description && (
              <p className="line-clamp-3 pt-1 text-sm text-[#666]">
                {vm.description}
              </p>
            )}

            {/* O que você precisa saber (dinâmico) */}
            {(vm.specs.length > 0 || vm.compatibilitySummary) && (
              <div className="pt-2">
                <p className="mb-1 text-sm font-semibold text-[#333]">
                  O que você precisa saber sobre este produto
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-[#666]">
                  {vm.specs.map((s) => (
                    <li key={`${s.label}-${s.value}`}>
                      {s.label}: {s.value}
                    </li>
                  ))}
                  <li>Tipo de veículo: carro/caminhonete</li>
                  {vm.compatibilitySummary && (
                    <li>Compatível com: {vm.compatibilitySummary}</li>
                  )}
                </ul>
                <button
                  type="button"
                  disabled
                  className="mt-1 text-xs text-[#3483FA]"
                >
                  Ver características
                </button>
              </div>
            )}
          </div>

          {/* Box de compra (direita) */}
          <div className="w-full space-y-3 rounded-lg border border-[#e6e6e6] p-3 lg:w-[280px]">
            {vm.freeShipping && (
              <span className="inline-block rounded bg-[#00A650] px-2 py-0.5 text-xs font-semibold text-white">
                FRETE GRÁTIS
              </span>
            )}
            {/* datas de entrega — placeholder visual */}
            <p className="text-sm font-medium text-[#00A650]">
              Chegará grátis entre amanhã e sexta-feira
            </p>

            <p className="text-sm font-semibold text-[#333]">{vm.stockLabel}</p>

            {vm.warranty && (
              <p className="text-xs text-[#666]">Garantia: {vm.warranty}</p>
            )}

            {/* Botões decorativos */}
            <button
              type="button"
              disabled
              className="w-full rounded-md bg-[#3483FA] py-2 text-sm font-medium text-white"
            >
              Comprar agora
            </button>
            <button
              type="button"
              disabled
              className="w-full rounded-md bg-[#E3EDFB] py-2 text-sm font-medium text-[#3483FA]"
            >
              Adicionar ao carrinho
            </button>

            <p className="text-xs text-[#666]">
              Vendido por{" "}
              <span className="font-medium text-[#3483FA]">
                {vm.mlAccountLabel}
              </span>
            </p>

            {/* selos — placeholder visual */}
            <div className="space-y-1 border-t border-[#eee] pt-2 text-xs text-[#666]">
              <p>Devolução grátis. Você tem 30 dias.</p>
              <p>Compra Garantida.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
