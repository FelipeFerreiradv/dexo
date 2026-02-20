export const BRANDS = [
  "Hyundai",
  "Honda",
  "Toyota",
  "Chevrolet",
  "Volkswagen",
  "Ford",
  "Fiat",
  "Renault",
  "Nissan",
  "Mitsubishi",
  "Peugeot",
  "Citroën",
  "Kia",
  "Suzuki",
  "BMW",
  "Mercedes",
];

// ML catalog with optional subcategories (children). We'll flatten child categories for ML listing selection and keep parents for generic category suggestions.
export const ML_CATALOG = [
  {
    id: "MLB1747",
    value: "Motor e Peças",
    keywords: [
      "motor",
      "biela",
      "pistão",
      "virabrequim",
      "cabeçote",
      "bloco",
      "comando",
      "válvula",
      "junta",
    ],
    children: [
      {
        id: "MLB1747-01",
        value: "Motor e Peças > Motor",
        keywords: ["motor", "bloco", "cárter"],
      },
      {
        id: "MLB1747-02",
        value: "Motor e Peças > Componentes",
        keywords: ["pistão", "biela", "cabeçote"],
      },
    ],
  },
  {
    id: "MLB1748",
    value: "Suspensão",
    keywords: [
      "amortecedor",
      "mola",
      "bandeja",
      "pivô",
      "pivo",
      "bieleta",
      "batente",
      "coifa",
      "bucha",
    ],
    children: [
      {
        id: "MLB1748-01",
        value: "Suspensão > Amortecedor",
        keywords: ["amortecedor"],
      },
      { id: "MLB1748-02", value: "Suspensão > Mola", keywords: ["mola"] },
    ],
  },
  {
    id: "MLB1749",
    value: "Freios",
    keywords: ["freio", "disco", "pastilha", "pinça", "cilindro"],
    children: [
      {
        id: "MLB1749-01",
        value: "Freios > Pastilhas e Discos",
        keywords: ["pastilha", "disco"],
      },
    ],
  },
  {
    id: "MLB1754",
    value: "Carroceria e Lataria",
    keywords: [
      "porta",
      "capô",
      "parachoque",
      "retrovisor",
      "maçaneta",
      "vidro",
    ],
    children: [
      {
        id: "MLB1754-01",
        value: "Carroceria e Lataria > Portas",
        keywords: ["porta"],
      },
    ],
  },
  {
    id: "MLB1750",
    value: "Elétrica Automotiva",
    keywords: ["alternador", "motor de arranque", "bobina", "sensor", "módulo"],
    children: [
      {
        id: "MLB1750-01",
        value: "Elétrica > Alternador",
        keywords: ["alternador"],
      },
    ],
  },
  {
    id: "MLB1765",
    value: "Acessórios para Veículos",
    keywords: ["acessório", "acessorios", "acessório para veículos"],
    children: [
      {
        id: "MLB1765-01",
        value:
          "Acessórios para Veículos > Peças de Carros e Caminhonetes > Suspensão e Direção > Cubo de Roda",
        keywords: [
          "cubo de roda",
          "cubo roda",
          "cubo de roda dianteiro",
          "cubo traseiro",
        ],
      },
    ],
  },
  {
    id: "MLB1758",
    value: "Filtros",
    keywords: ["filtro", "oleo", "ar", "combustível"],
    children: [],
  },
  { id: "MLB1764", value: "Outros", keywords: [], children: [] },
];

// Top-level categories for UI fields that expect friendly labels
export const ML_CATEGORIES = ML_CATALOG.map((c) => ({
  id: c.id,
  value: c.value,
  keywords: c.keywords,
}));

// Flattened list for detailed ML selection (children first), each item has id, value (display), keywords
export const ML_CATEGORY_OPTIONS = ML_CATALOG.flatMap((c) => {
  if (c.children && c.children.length > 0) {
    return c.children.map((ch) => ({
      id: ch.id,
      value: ch.value,
      keywords: ch.keywords,
    }));
  }
  return [{ id: c.id, value: c.value, keywords: c.keywords }];
});

export function suggestCategoryFromTitle(title: string): string | null {
  if (!title) return null;
  const tl = title.toLowerCase();

  // Try to match specific child categories first
  for (const cat of ML_CATEGORY_OPTIONS) {
    for (const kw of cat.keywords) {
      if (tl.includes(kw.toLowerCase())) return cat.value;
    }
  }

  // Fallback to top-level categories
  for (const cat of ML_CATEGORIES) {
    for (const kw of cat.keywords) {
      if (tl.includes(kw.toLowerCase())) return cat.value;
    }
  }

  return null;
}

/**
 * Normaliza a categoria sugerida (pode ser 'Top Level' ou 'Top > Child')
 * Retorna { topLevel?: string, detailedId?: string, detailedValue?: string }
 */
export function mapSuggestedCategory(suggested: string): {
  topLevel?: string;
  detailedId?: string;
  detailedValue?: string;
} {
  if (!suggested) return {};

  // If suggested exactly matches a child value, map to parent + child id
  const child = ML_CATEGORY_OPTIONS.find((c) => c.value === suggested);
  if (child) {
    // find parent that contains this child
    const parent = ML_CATALOG.find((p) =>
      p.children?.some((ch) => ch.id === child.id),
    );
    return {
      topLevel: parent
        ? parent.value
        : suggested.split(" > ")[0]?.trim() || suggested,
      detailedId: child.id,
      detailedValue: child.value,
    };
  }

  // If suggested is of the form 'Parent > Child', try to find the child by value
  if (suggested.includes(" > ")) {
    const childByValue = ML_CATEGORY_OPTIONS.find((c) => c.value === suggested);
    if (childByValue) {
      const parent = ML_CATALOG.find((p) =>
        p.children?.some((ch) => ch.id === childByValue.id),
      );
      return {
        topLevel: parent ? parent.value : suggested.split(" > ")[0].trim(),
        detailedId: childByValue.id,
        detailedValue: childByValue.value,
      };
    }
    // fallback - return parent portion
    const parentLabel = suggested.split(" > ")[0]?.trim();
    return { topLevel: parentLabel };
  }

  // If suggested matches a top-level value
  const top = ML_CATEGORIES.find((c) => c.value === suggested);
  if (top) return { topLevel: top.value };

  // Last resort: try to find a parent whose keywords match suggested
  for (const cat of ML_CATEGORIES) {
    for (const kw of cat.keywords) {
      if (suggested.toLowerCase().includes(kw.toLowerCase()))
        return { topLevel: cat.value };
    }
  }

  return { topLevel: suggested };
}

export function parseTitleToFields(title: string): {
  brand?: string;
  model?: string;
  year?: string;
  category?: string;
} {
  const res: {
    brand?: string;
    model?: string;
    year?: string;
    category?: string;
  } = {};
  if (!title) return res;

  const cleaned = title.replace(/[^A-Za-z0-9\s\-]/g, " ").trim();
  const cleanedLower = cleaned.toLowerCase();

  // Ano
  const yearMatch = cleaned.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) res.year = yearMatch[0];

  // Marca
  for (const b of BRANDS) {
    if (cleanedLower.includes(b.toLowerCase())) {
      res.brand = b;
      break;
    }
  }

  const tokens = cleaned.split(/\s+/);
  if (res.brand) {
    const idx = tokens.findIndex(
      (t) => t.toLowerCase() === res.brand!.toLowerCase(),
    );
    if (idx >= 0 && idx + 1 < tokens.length) {
      const candidate = tokens[idx + 1];
      if (/^[A-Za-z0-9\-]{2,20}$/.test(candidate))
        res.model = candidate.toUpperCase();
    }
  }

  // fallback model: letter+number token
  if (!res.model) {
    const m = cleaned.match(/\b([A-Za-z]{1,}[0-9]{1,4})\b/);
    if (m) res.model = m[1].toUpperCase();
  }

  // Categoria via keywords
  const category = suggestCategoryFromTitle(cleaned);
  if (category) res.category = category;

  return res;
}
