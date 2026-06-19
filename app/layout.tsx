import React from "react";
import type { Metadata, Viewport } from "next";

import "./globals.css";

import { Providers } from "./providers";
import { MainLayoutWrapper } from "@/components/main-layout-wrapper";

import {
  Geist,
  Geist_Mono,
  Geist as V0_Font_Geist,
  Geist_Mono as V0_Font_Geist_Mono,
  Source_Serif_4 as V0_Font_Source_Serif_4,
} from "next/font/google";

// Initialize fonts
const _geist = V0_Font_Geist({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
});
const _geistMono = V0_Font_Geist_Mono({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
});
const _sourceSerif_4 = V0_Font_Source_Serif_4({
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600", "700", "800", "900"],
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
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
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
    <html lang="pt-BR" suppressHydrationWarning>
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
