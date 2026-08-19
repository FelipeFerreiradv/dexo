"use client";

// Mock read-only de como o anúncio vai aparecer na OLX. Sem fetch, sem efeito,
// sem estado — props in, JSX out (espelha MagaluListingPreview).
//
// Visual aproximado da página real da OLX: header roxo (#6E0AD6) com wordmark
// "OLX" + busca, galeria, título, preço grande, localização, card do vendedor e
// CTAs "Bater papo"/"Fazer proposta" (desabilitados, só ilustrativos). Cores
// ficam como valores Tailwind arbitrários ESCOPADOS neste arquivo, pra não
// vazar pro tema do app. Conteúdo dinâmico vem do view-model.

import React from "react";
import {
  ImageOff,
  Search,
  Heart,
  MapPin,
  MessageCircle,
  Tag,
  ShieldCheck,
} from "lucide-react";
import type { ListingPreviewViewModel } from "./preview-utils";

export function OlxListingPreview({
  vm,
}: {
  vm: ListingPreviewViewModel;
}) {
  const mainImage = vm.images[0];
  const sellerInitial = vm.olxAccountLabel.charAt(0).toUpperCase();

  return (
    <div className="overflow-hidden rounded-lg bg-[#f2f2f2] text-[#333]">
      {/* Header roxo (logo + busca + favoritos) */}
      <div className="bg-[#6E0AD6] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="rounded bg-white px-1.5 py-0.5 text-lg font-black tracking-tight text-[#6E0AD6]">
            OLX
          </span>
          <div className="flex flex-1 items-center rounded bg-white px-2 py-1.5">
            <span className="flex-1 text-xs text-[#bbb]">
              Encontre carros, imóveis, autopeças e mais
            </span>
            <Search className="h-3.5 w-3.5 text-[#6E0AD6]" />
          </div>
          <Heart className="hidden h-5 w-5 text-white sm:block" />
        </div>
      </div>

      <div className="space-y-3 p-2 sm:p-4">
        {/* Breadcrumb de categoria (dinâmico, se houver) */}
        {vm.olxCategoryLabel && (
          <p className="flex items-center gap-1 text-[11px] text-[#888]">
            <Tag className="h-3 w-3" />
            {vm.olxCategoryLabel}
          </p>
        )}

        {/* Card principal: galeria | info+preço */}
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          {/* Galeria (dinâmica) */}
          <div className="rounded-lg bg-white p-3">
            <div className="flex items-center justify-center rounded border border-[#eee] bg-[#fafafa]">
              {mainImage ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={mainImage}
                  alt={vm.title}
                  className="max-h-72 w-full object-contain"
                />
              ) : (
                <div className="flex h-64 w-full flex-col items-center justify-center gap-2 text-[#ccc]">
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
                      idx === 0 ? "border-[#6E0AD6]" : "border-[#eee]"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Coluna direita: preço, título, vendedor, CTAs */}
          <div className="space-y-3">
            <div className="rounded-lg bg-white p-4">
              <span className="text-2xl font-bold text-[#333] sm:text-3xl">
                {vm.olxPriceFormatted}
              </span>
              <h3 className="mt-1 text-sm font-medium leading-snug text-[#333]">
                {vm.title}
              </h3>
              <p className="mt-1 text-xs text-[#666]">{vm.stockLabel}</p>
              <div className="mt-3 flex items-start gap-1 text-[11px] text-[#666]">
                <MapPin className="mt-0.5 h-3.5 w-3.5 text-[#6E0AD6]" />
                Localização informada no seu perfil OLX
              </div>
              <button
                type="button"
                disabled
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-[#6E0AD6] px-4 py-2 text-sm font-semibold text-white"
              >
                <MessageCircle className="h-4 w-4" />
                Bater papo
              </button>
              <button
                type="button"
                disabled
                className="mt-2 w-full rounded-full border border-[#6E0AD6] px-4 py-2 text-sm font-semibold text-[#6E0AD6]"
              >
                Fazer uma proposta
              </button>
            </div>

            {/* Card do vendedor (dinâmico: nome da conta) */}
            <div className="rounded-lg bg-white p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#6E0AD6] text-sm font-semibold text-white">
                  {sellerInitial}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#333]">
                    {vm.olxAccountLabel}
                  </p>
                  <p className="flex items-center gap-1 text-[11px] text-[#6E0AD6]">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Anúncio publicado pelo Dexo
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Descrição (dinâmico) */}
        {vm.description && (
          <div className="rounded-lg bg-white p-4">
            <h4 className="mb-2 text-sm font-semibold text-[#333]">Descrição</h4>
            <p className="whitespace-pre-line text-sm text-[#555]">
              {vm.description}
            </p>
          </div>
        )}

        {/* Detalhes (dinâmico: specs) */}
        {vm.specs.length > 0 && (
          <div className="rounded-lg bg-white p-4">
            <h4 className="mb-2 text-sm font-semibold text-[#333]">Detalhes</h4>
            <table className="w-full text-sm">
              <tbody>
                {vm.specs.map((s, i) => (
                  <tr key={s.label} className={i % 2 === 1 ? "bg-[#f7f7f7]" : ""}>
                    <td className="py-1.5 pl-2 pr-4 text-[#888]">{s.label}</td>
                    <td className="py-1.5 pr-2 text-[#333]">{s.value}</td>
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
