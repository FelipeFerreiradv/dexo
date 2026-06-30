/**
 * Identidade visual Dexo para os relatórios PDF (Entregas B/C).
 * Fonte: Manual de Marca Dexo (Edição 01 · 2026). Paleta oficial de 14 cores —
 * usar SOMENTE estas. Mapeamento da referência (relatório corporativo) → Dexo:
 *  - Preto → Petróleo Profundo (nunca preto puro)
 *  - Vermelho/CTA → Amarelo Sinalização (destaques, asterisco-assinatura, KPIs)
 *  - Branco/cinza claro → Pergaminho / Creme Catálogo (fundos de página)
 *  - Verde/positivo → Verde Operação
 * Gradiente assinatura: Petróleo → Amarelo (áreas dos gráficos).
 */
export const DEXO = {
  carbono: "#070D12",
  petroleoProfundo: "#0E1F2A",
  petroleoMedio: "#1B3A4D",
  aco: "#3F4A52",
  acoClaro: "#7B8590",
  concreto: "#9CA39C",
  verdeOperacao: "#2C5F4F",
  verdeClaro: "#7FA395",
  amarelo: "#F2C419",
  amareloClaro: "#F0E58D",
  azulMagalu: "#2563EB",
  bege: "#E8DFCA",
  pergaminho: "#F2EDE2",
  creme: "#FBF7EE",
  branco: "#FFFFFF",
} as const;

/** Famílias de fonte registradas em fonts.ts (escopadas ao PDF, não afetam o app).
 *  Bricolage Grotesque / Fraunces / Inter são variable-only no Google Fonts (sem
 *  TTF estático que o @react-pdf aceita), então usamos os fallbacks estáticos OFL
 *  mais próximos da estrutura da marca (display grotesco pesado + sans industrial
 *  + mono técnico). */
export const FONT = {
  /** Display/manchetes/capa/números gigantes (fallback de Bricolage/Fraunces). */
  display: "ArchivoBlack",
  /** Corpo/UI/legendas (fallback de Inter): IBM Plex Sans. */
  sans: "PlexSans",
  /** Dados/números técnicos/IDs/rodapé: JetBrains Mono. */
  mono: "JetBrainsMono",
} as const;

/** ML × Shopee no gráfico: ML = Amarelo Sinalização, Shopee = Verde Operação,
 *  Outro = Aço Claro. (Sem o vermelho da referência.) */
export const PLATFORM_COLOR = {
  ML: DEXO.amarelo,
  SHOPEE: DEXO.verdeOperacao,
  MAGALU: DEXO.azulMagalu,
  OUTRO: DEXO.acoClaro,
} as const;

/** Dimensões A4 retrato em pontos (72dpi): 210×297mm. */
export const A4 = { width: 595.28, height: 841.89 } as const;
export const PAGE_MARGIN = 44;
