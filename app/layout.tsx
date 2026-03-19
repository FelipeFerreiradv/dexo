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
        width: 1200,
        height: 630,
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
  icons: {
    icon: [
      {
        url: "/icon-light-32x32.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/icon-dark-32x32.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
    apple: "/apple-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
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
        <Providers>
          <MainLayoutWrapper>{children}</MainLayoutWrapper>
        </Providers>
      </body>
    </html>
  );
}
