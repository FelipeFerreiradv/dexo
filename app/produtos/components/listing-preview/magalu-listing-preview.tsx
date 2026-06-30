"use client";

// Mock read-only de como o anúncio vai aparecer no Magalu. Sem fetch, sem
// efeito, sem estado — props in, JSX out (espelha ShopeeListingPreview).
//
// Cores Magalu (azul #0086FF) ficam como valores Tailwind arbitrários ESCOPADOS
// neste arquivo, pra não vazar pro tema do app. Conteúdo dinâmico vem do
// view-model; o que está marcado "placeholder visual" é estático/ilustrativo.
// A categoria do Magalu é auto-resolvida no backend, então o breadcrumb é o
// caminho de domínio genérico (Veículos e Peças).

import React from "react";
import { ImageOff, Search, Minus, Plus, ShoppingCart } from "lucide-react";
import type { ListingPreviewViewModel } from "./preview-utils";

export function MagaluListingPreview({
  vm,
}: {
  vm: ListingPreviewViewModel;
}) {
  const mainImage = vm.images[0];

  return (
    <div className="overflow-hidden rounded-lg bg-[#f5f5f5] text-[#333]">
      {/* Header azul com logo (texto) + busca decorativa — placeholder visual */}
      <div className="flex items-center gap-3 bg-[#0086FF] px-4 py-2.5">
        <span className="text-lg font-bold italic text-white">magalu</span>
        <div className="flex flex-1 items-center rounded bg-white px-2 py-1.5">
          <span className="flex-1 text-xs text-[#bbb]">Buscar no Magalu</span>
          <Search className="h-4 w-4 text-[#0086FF]" />
        </div>
        <ShoppingCart className="h-5 w-5 text-white" />
      </div>

      <div className="p-2 sm:p-4">
        <div className="rounded-lg bg-white p-3 sm:p-4">
          {/* Breadcrumb (genérico — categoria resolvida no backend) */}
          <div className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-[#888]">
            {vm.magaluBreadcrumb.map((crumb, i) => (
              <span key={`${crumb}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span>›</span>}
                <span className={i === 0 ? "text-[#0086FF]" : ""}>{crumb}</span>
              </span>
            ))}
          </div>

          {/* Galeria + info */}
          <div className="flex flex-col gap-4 md:flex-row">
            <div className="md:w-[40%]">
              <div className="flex items-center justify-center rounded border border-[#eee] bg-[#fafafa]">
                {mainImage ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={mainImage}
                    alt={vm.title}
                    className="max-h-72 w-full object-contain"
                  />
                ) : (
                  <div className="flex h-56 w-full flex-col items-center justify-center gap-2 text-[#ccc]">
                    <ImageOff className="h-10 w-10" />
                    <span className="text-xs">Sem imagem</span>
                  </div>
                )}
              </div>
              {vm.images.length > 1 && (
                <div className="mt-2 flex gap-1.5">
                  {vm.images.slice(0, 5).map((url, idx) => (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      key={`${url}-${idx}`}
                      src={url}
                      alt=""
                      className={`h-12 w-12 rounded border object-cover ${
                        idx === 0 ? "border-[#0086FF]" : "border-[#eee]"
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Coluna direita (dinâmica) */}
            <div className="flex-1 space-y-3">
              <h3 className="text-base font-medium leading-snug text-[#333] sm:text-lg">
                {vm.title}
              </h3>

              {/* avaliações — placeholder visual */}
              <div className="flex items-center justify-between text-xs text-[#888]">
                <span>Nenhuma avaliação ainda</span>
                <span>Vendido e entregue por Magalu</span>
              </div>

              {/* Bloco de preço (dinâmico) */}
              <div className="rounded bg-[#fafafa] p-3">
                <span className="text-2xl font-semibold text-[#0086FF] sm:text-3xl">
                  {vm.magaluPriceFormatted}
                </span>
                {/* placeholder visual */}
                <span className="ml-2 text-xs text-[#888]">no Pix</span>
              </div>

              {/* Frete — placeholder visual */}
              <div className="flex gap-2 text-sm">
                <span className="text-[#888]">Frete</span>
                <div>
                  <p className="text-[#333]">Calculado no checkout</p>
                  <p className="text-[#0086FF]">Entrega Magalu</p>
                </div>
              </div>

              {/* Seletor de quantidade — placeholder visual (decorativo) */}
              <div className="flex items-center gap-3 text-sm">
                <span className="text-[#888]">Quantidade</span>
                <div className="flex items-center">
                  <span className="flex h-7 w-7 items-center justify-center rounded-l border border-[#ddd] text-[#888]">
                    <Minus className="h-3 w-3" />
                  </span>
                  <span className="flex h-7 w-10 items-center justify-center border-y border-[#ddd]">
                    1
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-r border border-[#ddd] text-[#888]">
                    <Plus className="h-3 w-3" />
                  </span>
                </div>
              </div>

              {/* Botões decorativos */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  disabled
                  className="flex items-center gap-1.5 rounded border border-[#0086FF] bg-[#E6F3FF] px-4 py-2 text-sm font-medium text-[#0086FF]"
                >
                  <ShoppingCart className="h-4 w-4" />
                  Adicionar à sacola
                </button>
                <button
                  type="button"
                  disabled
                  className="rounded bg-[#0086FF] px-5 py-2 text-sm font-medium text-white"
                >
                  Comprar agora
                </button>
              </div>
            </div>
          </div>

          {/* Card da loja (dinâmico: nome da conta) */}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#eee] pt-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#0086FF] text-sm font-semibold text-white">
              {vm.magaluAccountLabel.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-[#333]">
                {vm.magaluAccountLabel}
              </p>
              {/* placeholder visual */}
              <p className="text-xs text-[#888]">Loja parceira Magalu</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled
                className="rounded border border-[#0086FF] px-3 py-1.5 text-xs text-[#0086FF]"
              >
                Ver loja
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
