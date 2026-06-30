// Tipos da API de Categorias e Atributos da Magalu (VALIDADO na doc).
// GET /seller/v1/portfolios/categories (busca por name|id), /categories/hierarchy,
// /categories/{id}/attributes, /categories/{id}/datasheet.
// Escopos: open:portfolio-categories-seller:read (ou -channel:read).

export interface MagaluCategory {
  id: string;
  name?: string;
  parent_id?: string | null;
  path?: string;
  [key: string]: unknown;
}

/** Um atributo de variação (attributes) ou de ficha técnica (datasheet). */
export interface MagaluAttribute {
  id: string;
  name: string; // nome interno — é o que vai em {name, value} no SKU
  display_name?: string;
  type?: string; // text | number | choice | ...
  required?: "required" | "recommended" | "optional" | string;
  variation?: boolean;
  choices?: string[] | null;
  example?: string | null;
  [key: string]: unknown;
}
