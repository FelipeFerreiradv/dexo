/**
 * Presets de tela do Editor de Imagem (PR 6).
 *
 * Dimensões conferidas nas docs oficiais (30/07/2026):
 *  - Mercado Livre: recomenda 1200×1200 (mín. 500×500), fundo branco puro
 *    para a foto principal de produto.
 *  - Shopee: recomenda imagem quadrada; 1024×1024 cobre o zoom sem estourar
 *    o limite de 2MB do upload deles.
 * Os demais são proporções livres exportadas no maior lado 1600 (o mesmo
 * teto do pipeline de upload — nada aqui gera arquivo maior que o normal).
 */

export interface EditorPreset {
  id: string;
  label: string;
  /** Dimensões FINAIS do export, em px. `null` = usa o tamanho da imagem. */
  width: number | null;
  height: number | null;
}

export const EDITOR_PRESETS: EditorPreset[] = [
  { id: "ml-1200", label: "Mercado Livre (1200×1200)", width: 1200, height: 1200 },
  { id: "shopee-1024", label: "Shopee (1024×1024)", width: 1024, height: 1024 },
  { id: "square", label: "Quadrado 1:1 (1600×1600)", width: 1600, height: 1600 },
  { id: "landscape-4-3", label: "Paisagem 4:3 (1600×1200)", width: 1600, height: 1200 },
  { id: "portrait-3-4", label: "Retrato 3:4 (1200×1600)", width: 1200, height: 1600 },
  { id: "original", label: "Original (sem redimensionar)", width: null, height: null },
];

export const DEFAULT_PRESET_ID = "ml-1200";

/** Margem default: a peça ocupa ~88% do lado menor do canvas (padrão de
 *  anúncio de marketplace — respiro suficiente sem encolher a peça). */
export const DEFAULT_PADDING_PCT = 88;

export type BackgroundMode = "white" | "transparent" | "color";

export interface EditorBackground {
  mode: BackgroundMode;
  /** Cor CSS quando mode === "color" (ex.: "#f5f5f5"). */
  color?: string;
}

export function resolvePreset(id: string): EditorPreset {
  return (
    EDITOR_PRESETS.find((p) => p.id === id) ??
    EDITOR_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!
  );
}

/** Dimensões finais do export para um preset + imagem-fonte. */
export function presetExportSize(
  preset: EditorPreset,
  source: { width: number; height: number },
): { width: number; height: number } {
  if (preset.width && preset.height) {
    return { width: preset.width, height: preset.height };
  }
  return { width: Math.round(source.width), height: Math.round(source.height) };
}
