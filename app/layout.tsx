import React from "react";
import type { Metadata, Viewport } from "next";

import "./globals.css";

import { Providers } from "./providers";
import { MainLayoutWrapper } from "@/components/main-layout-wrapper";

import {
  Inter,
  JetBrains_Mono,
  Bricolage_Grotesque,
  Fraunces,
  Outfit,
} from "next/font/google";

// Fontes da identidade visual Dexo (Manual de Marca):
// Inter = corpo/UI · JetBrains Mono = SKU/códigos/valores · Bricolage = títulos ·
// Fraunces = serif editorial (números grandes / itálico de acento).
// Carregadas como CSS variables e expostas ao <html> (cobre portais de
// dialog/sheet). Os tokens --font-sans/--font-mono/--font-display em globals.css
// apontam para estas variáveis.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});
// Fraunces (serif moderna, variável) — números editoriais grandes e itálicos de
// acento (par "dado & resultado" do manual). Exposta como CSS var; uso seletivo.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  style: ["normal", "italic"],
  display: "swap",
});
// Outfit (geométrica) — fonte do título "wordmark" (`nome.`) dos cabeçalhos de
// página. Exposta como CSS var p/ ser usada por componentes server E client
// (o PageHeader é importado por páginas dos dois tipos).
const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Dexo | Gestão de Estoque Centralizada",
    template: "%s | Dexo",
  },
  description:
    "Gerencie seu estoque de forma centralizada com integrações diretas ao Mercado Livre e Shopee. Simplifique operações e tome decisões baseadas em dados.",
  keywords: [
    "gestão de estoque",
    "controle de estoque",
    "marketplace",
    "Mercado Livre",
    "Shopee",
    "e-commerce",
    "ERP",
    "gestão de pedidos",
    "integração marketplace",
    "Dexo",
  ],
  authors: [{ name: "Dexo" }],
  creator: "Dexo",
  publisher: "Dexo",
  applicationName: "Dexo",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://dexo.com.br",
  ),
  openGraph: {
    type: "website",
    locale: "pt_BR",
    siteName: "Dexo",
    title: "Dexo | Gestão de Estoque Centralizada",
    description:
      "Gerencie seu estoque de forma centralizada com integrações diretas ao Mercado Livre e Shopee.",
    images: [
      {
        url: "/logo.jpg",
        width: 640,
        height: 640,
        alt: "Dexo - Gestão de Estoque Centralizada",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Dexo | Gestão de Estoque Centralizada",
    description:
      "Gerencie seu estoque de forma centralizada com integrações diretas ao Mercado Livre e Shopee.",
    images: ["/logo.jpg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  // Ícones (favicon/apple-icon) são gerados automaticamente pelas convenções de
  // arquivo do App Router: app/favicon.ico, app/icon.png e app/apple-icon.png
  // (todos a partir do logo Dexo). Sem refs manuais => sem 404 de ícones.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2ede2" },
    { media: "(prefers-color-scheme: dark)", color: "#070d12" },
  ],
};

// Dados estruturados (Schema.org) — ajudam mecanismos de busca a entender a
// marca Dexo (e podem habilitar resultados ricos / favicon na SERP). Estático,
// renderizado no servidor; não altera layout nem comportamento.
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://dexo.com.br";
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${appUrl}/#organization`,
      name: "Dexo",
      url: appUrl,
      logo: `${appUrl}/icon-512.png`,
      description:
        "Plataforma de gestão de estoque centralizada com integrações diretas ao Mercado Livre e Shopee.",
    },
    {
      "@type": "WebSite",
      "@id": `${appUrl}/#website`,
      name: "Dexo",
      url: appUrl,
      inLanguage: "pt-BR",
      publisher: { "@id": `${appUrl}/#organization` },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${inter.variable} ${jetbrainsMono.variable} ${bricolage.variable} ${fraunces.variable} ${outfit.variable}`}
      suppressHydrationWarning
    >
      <body className={`font-sans antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <Providers>
          <MainLayoutWrapper>{children}</MainLayoutWrapper>
        </Providers>
      </body>
    </html>
  );
}
