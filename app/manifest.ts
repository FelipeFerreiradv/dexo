import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dexo - Gestão de Estoque Centralizada",
    short_name: "Dexo",
    description:
      "Gerencie seu estoque de forma centralizada com integrações diretas ao Mercado Livre e Shopee.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#F2E205",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
