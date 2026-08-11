"use client";

// Mock read-only de como o anúncio vai aparecer no Facebook Marketplace. Sem
// fetch, sem efeito, sem estado — props in, JSX out (espelha
// MagaluListingPreview).
//
// Visual aproximado da página real do Marketplace: header azul (#1877F2) com
// wordmark "facebook" + busca, layout de duas colunas (galeria à esquerda,
// detalhes à direita), preço grande, CTA "Enviar mensagem" (desabilitado, só
// ilustrativo), card do vendedor e detalhes. Cores ficam como valores Tailwind
// arbitrários ESCOPADOS neste arquivo. Conteúdo dinâmico vem do view-model.

import React from "react";
import {
  ImageOff,
  Search,
  MapPin,
  MessageCircle,
  Tag,
  Store,
} from "lucide-react";
import type { ListingPreviewViewModel } from "./preview-utils";

export function FacebookListingPreview({
  vm,
}: {
  vm: ListingPreviewViewModel;
}) {
  const mainImage = vm.images[0];
  const sellerInitial = vm.facebookAccountLabel.charAt(0).toUpperCase();

  return (
    <div className="overflow-hidden rounded-lg bg-[#f0f2f5] text-[#1c1e21]">
      {/* Header azul (logo + busca) */}
      <div className="bg-[#1877F2] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold lowercase tracking-tight text-white">
            facebook
          </span>
          <span className="hidden text-sm font-medium text-white/90 sm:inline">
            Marketplace
          </span>
          <div className="flex flex-1 items-center rounded-full bg-white px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-[#65676b]" />
            <span className="ml-2 flex-1 text-xs text-[#bbb]">
              Pesquisar no Marketplace
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-2 sm:p-4">
        {/* Card principal: galeria | detalhes+preço */}
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          {/* Galeria (dinâmica) — fundo escuro como o Marketplace real */}
          <div className="flex items-center justify-center rounded-lg bg-[#18191a] p-2">
            {mainImage ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={mainImage}
                alt={vm.title}
                className="max-h-80 w-full object-contain"
              />
            ) : (
              <div className="flex h-72 w-full flex-col items-center justify-center gap-2 text-[#666]">
                <ImageOff className="h-10 w-10" />
                <span className="text-xs">Sem imagem</span>
              </div>
            )}
          </div>

          {/* Coluna direita: título, preço, CTA, vendedor */}
          <div className="space-y-3">
            <div className="rounded-lg bg-white p-4">
              <h3 className="text-lg font-semibold leading-snug text-[#1c1e21]">
                {vm.title}
              </h3>
              <p className="mt-1 text-2xl font-bold text-[#1c1e21]">
                {vm.facebookPriceFormatted}
              </p>
              {vm.facebookCategoryLabel && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-[#65676b]">
                  <Tag className="h-3 w-3" />
                  {vm.facebookCategoryLabel}
                </p>
              )}
              <div className="mt-2 flex items-start gap-1 text-[11px] text-[#65676b]">
                <MapPin className="mt-0.5 h-3.5 w-3.5 text-[#1877F2]" />
                Localização definida no seu catálogo
              </div>
              <p className="mt-1 text-xs text-[#65676b]">{vm.stockLabel}</p>
              <button
                type="button"
                disabled
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-[#1877F2] px-4 py-2 text-sm font-semibold text-white"
              >
                <MessageCircle className="h-4 w-4" />
                Enviar mensagem
              </button>
            </div>

            {/* Vendedor (dinâmico: nome da conta) */}
            <div className="rounded-lg bg-white p-4">
              <h4 className="mb-2 text-sm font-semibold text-[#1c1e21]">
                Informações do vendedor
              </h4>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1877F2] text-sm font-semibold text-white">
                  {sellerInitial}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#1c1e21]">
                    {vm.facebookAccountLabel}
                  </p>
                  <p className="flex items-center gap-1 text-[11px] text-[#1877F2]">
                    <Store className="h-3.5 w-3.5" />
                    Catálogo publicado pelo Dexo
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Descrição (dinâmico) */}
        {vm.description && (
          <div className="rounded-lg bg-white p-4">
            <h4 className="mb-2 text-sm font-semibold text-[#1c1e21]">
              Descrição
            </h4>
            <p className="whitespace-pre-line text-sm text-[#444]">
              {vm.description}
            </p>
          </div>
        )}

        {/* Detalhes (dinâmico: specs) */}
        {vm.specs.length > 0 && (
          <div className="rounded-lg bg-white p-4">
            <h4 className="mb-2 text-sm font-semibold text-[#1c1e21]">
              Detalhes
            </h4>
            <table className="w-full text-sm">
              <tbody>
                {vm.specs.map((s, i) => (
                  <tr key={s.label} className={i % 2 === 1 ? "bg-[#f7f8fa]" : ""}>
                    <td className="py-1.5 pl-2 pr-4 text-[#65676b]">
                      {s.label}
                    </td>
                    <td className="py-1.5 pr-2 text-[#1c1e21]">{s.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
