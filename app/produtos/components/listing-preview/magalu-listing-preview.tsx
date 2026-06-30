"use client";

// Mock read-only de como o anúncio vai aparecer no Magalu. Sem fetch, sem
// efeito, sem estado — props in, JSX out (espelha ShopeeListingPreview).
//
// Visual fiel à página real do Magalu: header azul (#0086FF) com wordmark
// "magalu" + busca, "Vendido por X e entregue por Magalu", caixa de preço com
// CTA VERDE "Adicionar à sacola" + "Comprar agora" outline, card da loja
// ("Loja oficial no Magalu") e Ficha Técnica em tabela. Cores ficam como valores
// Tailwind arbitrários ESCOPADOS neste arquivo, pra não vazar pro tema do app.
// Conteúdo dinâmico vem do view-model; o que está marcado "placeholder visual" é
// estático/ilustrativo. A categoria do Magalu é auto-resolvida no backend.

import React from "react";
import {
  ImageOff,
  Search,
  Heart,
  ShoppingBag,
  User,
  MapPin,
  Star,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import type { ListingPreviewViewModel } from "./preview-utils";

const NAV = [
  "Tem no magalu",
  "Cupons",
  "Celulares",
  "Eletrodomésticos",
  "TV e Vídeo",
  "Informática",
  "Móveis",
  "Saldão",
];

export function MagaluListingPreview({
  vm,
}: {
  vm: ListingPreviewViewModel;
}) {
  const mainImage = vm.images[0];
  const storeInitial = vm.magaluAccountLabel.charAt(0).toUpperCase();

  return (
    <div className="overflow-hidden rounded-lg bg-[#f0f0f0] text-[#333]">
      {/* Header azul (logo + localização + busca + ícones) */}
      <div className="bg-[#0086FF] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold lowercase tracking-tight text-white">
            magalu
          </span>
          <div className="hidden items-center gap-1 text-[11px] text-white/90 sm:flex">
            <MapPin className="h-3.5 w-3.5" />
            Região de Jundiaí/SP
          </div>
          <div className="flex flex-1 items-center rounded bg-white px-2 py-1.5">
            <span className="flex-1 text-xs text-[#bbb]">Buscar no Magalu</span>
            <span className="flex h-6 w-6 items-center justify-center rounded bg-[#0086FF]">
              <Search className="h-3.5 w-3.5 text-white" />
            </span>
          </div>
          <Heart className="hidden h-5 w-5 text-white sm:block" />
          <ShoppingBag className="h-5 w-5 text-white" />
          <User className="hidden h-5 w-5 text-white sm:block" />
        </div>
        <div className="mt-2 hidden flex-wrap gap-4 text-[11px] text-white/90 md:flex">
          {NAV.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      </div>

      <div className="space-y-3 p-2 sm:p-4">
        {/* Card principal: galeria | info | preço */}
        <div className="rounded-lg bg-white p-3 sm:p-4">
          <div className="grid gap-4 lg:grid-cols-[34%_1fr_260px]">
            {/* Galeria (dinâmica) */}
            <div>
              <div className="flex items-center justify-center rounded border border-[#eee] bg-[#fafafa]">
                {mainImage ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={mainImage}
                    alt={vm.title}
                    className="max-h-64 w-full object-contain"
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

            {/* Info central: rating, título, vendedor */}
            <div className="space-y-2">
              {/* avaliação — placeholder visual */}
              <div className="flex items-center gap-1 text-xs">
                <Star className="h-3.5 w-3.5 fill-[#f5a623] text-[#f5a623]" />
                <span className="font-medium text-[#f5a623]">4.6</span>
                <span className="text-[#888]">(22)</span>
              </div>
              <h3 className="text-base font-medium leading-snug text-[#333] sm:text-lg">
                {vm.title}
              </h3>
              <p className="text-xs text-[#666]">
                Vendido por{" "}
                <span className="text-[#0086FF]">{vm.magaluAccountLabel}</span>{" "}
                e entregue por <span className="font-semibold">Magalu</span>
              </p>
            </div>

            {/* Caixa de preço (direita) — CTA verde */}
            <div className="space-y-3 rounded-lg border border-[#eee] p-3">
              <div>
                <span className="text-2xl font-bold text-[#333] sm:text-3xl">
                  {vm.magaluPriceFormatted}
                </span>{" "}
                <span className="text-sm text-[#0086FF]">no Pix</span>
              </div>
              {/* região/entrega — placeholder visual */}
              <div className="flex items-start gap-1 text-[11px] text-[#666]">
                <MapPin className="mt-0.5 h-3.5 w-3.5 text-[#0086FF]" />
                Informe seu CEP para valores e prazos exatos.
              </div>
              <p className="text-xs text-[#666]">{vm.stockLabel}</p>
              <button
                type="button"
                disabled
                className="w-full rounded bg-[#00A650] px-4 py-2 text-sm font-semibold text-white"
              >
                Adicionar à sacola
              </button>
              <button
                type="button"
                disabled
                className="w-full rounded border border-[#0086FF] px-4 py-2 text-sm font-semibold text-[#0086FF]"
              >
                Comprar agora
              </button>
            </div>
          </div>
        </div>

        {/* Principais características (dinâmico: specs) */}
        {vm.specs.length > 0 && (
          <div className="rounded-lg bg-white p-4">
            <h4 className="mb-2 text-sm font-semibold text-[#333]">
              Principais características
            </h4>
            <ul className="ml-4 list-disc space-y-1 text-sm text-[#555]">
              {vm.specs.map((s) => (
                <li key={s.label}>
                  {s.label}: {s.value}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Ficha Técnica (dinâmico: specs em tabela com linhas zebradas) */}
        {vm.specs.length > 0 && (
          <div className="rounded-lg bg-white p-4">
            <h4 className="mb-2 text-sm font-semibold text-[#333]">
              Ficha Técnica
            </h4>
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

        {/* Card da loja (dinâmico: nome da conta) + selos de confiança */}
        <div className="rounded-lg bg-white p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#0086FF] text-sm font-semibold text-white">
              {storeInitial}
            </div>
            <div className="flex-1">
              <p className="flex items-center gap-1 text-sm font-medium text-[#333]">
                {vm.magaluAccountLabel}
              </p>
              <p className="flex items-center gap-1 text-xs text-[#0086FF]">
                Loja oficial no Magalu
                <ShieldCheck className="h-3.5 w-3.5" />
              </p>
            </div>
            {/* métricas — placeholder visual */}
            <div className="flex w-full gap-6 text-[11px] text-[#888] sm:w-auto">
              <span>+200mil produtos vendidos</span>
              <span>Entrega no prazo</span>
              <span>Responde rápido</span>
            </div>
          </div>
          {/* selos Magalu — placeholder visual */}
          <div className="mt-3 flex flex-wrap gap-4 border-t border-[#eee] pt-3 text-[11px] text-[#666]">
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-[#0086FF]" />
              Magalu garante a sua compra
            </span>
            <span className="flex items-center gap-1">
              <RefreshCw className="h-3.5 w-3.5 text-[#0086FF]" />
              Devolução gratuita em até 7 dias
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
