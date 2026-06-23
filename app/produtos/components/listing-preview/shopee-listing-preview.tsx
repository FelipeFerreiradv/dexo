"use client";

// Read-only, purely presentational mock of how the listing will look on Shopee.
// No fetch, no effects, no state, no mutation — props in, JSX out.
//
// Shopee colors are kept as SCOPED arbitrary Tailwind values inside this file
// only (orange #EE4D2D, light #FEEEEA, grays) so they never leak into the rest
// of the app's theme.
//
// Dynamic content comes from the form view-model. Everything labelled
// "placeholder visual" below is STATIC/illustrative, present only so the mock
// resembles a real Shopee listing page. Shopee has no price/free-shipping
// override field, so price = base price and the shipping line is illustrative.

import React from "react";
import { ImageOff, Search, Minus, Plus, ShoppingCart } from "lucide-react";
import type { ListingPreviewViewModel } from "./preview-utils";

export function ShopeeListingPreview({ vm }: { vm: ListingPreviewViewModel }) {
  const mainImage = vm.images[0];

  return (
    <div className="overflow-hidden rounded-lg bg-[#f5f5f5] text-[#333]">
      {/* Header laranja com logo + busca decorativa — placeholder visual */}
      <div className="flex items-center gap-3 bg-[#EE4D2D] px-4 py-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/marketplaces/shopee.svg"
          alt="Shopee"
          className="h-6 w-auto brightness-0 invert"
        />
        <div className="flex flex-1 items-center rounded bg-white px-2 py-1.5">
          <span className="flex-1 text-xs text-[#bbb]">Buscar na Shopee</span>
          <Search className="h-4 w-4 text-[#EE4D2D]" />
        </div>
        <ShoppingCart className="h-5 w-5 text-white" />
      </div>

      <div className="p-2 sm:p-4">
        <div className="rounded-lg bg-white p-3 sm:p-4">
          {/* Breadcrumb cinza (dinâmico) */}
          <div className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-[#888]">
            {vm.shopeeBreadcrumb.map((crumb, i) => (
              <span key={`${crumb}-${i}`} className="flex items-center gap-1">
                {i > 0 && <span>›</span>}
                <span className={i === 0 ? "text-[#EE4D2D]" : ""}>{crumb}</span>
              </span>
            ))}
          </div>

          {/* Galeria + info */}
          <div className="flex flex-col gap-4 md:flex-row">
            {/* Galeria (dinâmica) */}
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
                        idx === 0 ? "border-[#EE4D2D]" : "border-[#eee]"
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
                <span>Nenhuma Avaliação Ainda</span>
                <span>Denunciar</span>
              </div>

              {/* Bloco de preço (dinâmico) */}
              <div className="rounded bg-[#fafafa] p-3">
                <span className="text-2xl font-semibold text-[#EE4D2D] sm:text-3xl">
                  {vm.shopeePriceFormatted}
                </span>
                {/* placeholder visual */}
                <span className="ml-2 text-xs text-[#888]">
                  no Pix com cupom
                </span>
              </div>

              {/* Frete — placeholder visual (Shopee não tem campo de frete grátis) */}
              <div className="flex gap-2 text-sm">
                <span className="text-[#888]">Frete</span>
                <div>
                  <p className="text-[#333]">São Paulo, São Paulo</p>
                  <p className="text-[#EE4D2D]">Frete grátis com cupom</p>
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
                  className="flex items-center gap-1.5 rounded border border-[#EE4D2D] bg-[#FEEEEA] px-4 py-2 text-sm font-medium text-[#EE4D2D]"
                >
                  <ShoppingCart className="h-4 w-4" />
                  Adicionar Ao Carrinho
                </button>
                <button
                  type="button"
                  disabled
                  className="rounded bg-[#EE4D2D] px-5 py-2 text-sm font-medium text-white"
                >
                  Compre Com Cupom {vm.shopeePriceFormatted}
                </button>
              </div>
            </div>
          </div>

          {/* Card da loja (dinâmico: nome da conta) */}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#eee] pt-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#EE4D2D] text-sm font-semibold text-white">
              {/* inicial da loja; o label sempre tem fallback não-vazio */}
              {vm.shopeeAccountLabel.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-[#333]">
                {vm.shopeeAccountLabel}
              </p>
              {/* placeholder visual */}
              <p className="text-xs text-[#888]">Último Login Há pouco</p>
            </div>
            {/* botões + métricas — placeholder visual */}
            <div className="flex gap-2">
              <button
                type="button"
                disabled
                className="rounded border border-[#EE4D2D] px-3 py-1.5 text-xs text-[#EE4D2D]"
              >
                Conversar Agora
              </button>
              <button
                type="button"
                disabled
                className="rounded border border-[#ddd] px-3 py-1.5 text-xs text-[#555]"
              >
                Ver Página Da Loja
              </button>
            </div>
            <div className="flex w-full gap-6 text-xs text-[#888] sm:w-auto">
              <span>Avaliações: 212</span>
              <span>Produtos: 5,2mil</span>
              <span>Seguidores: 33</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
