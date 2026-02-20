import {
  parseTitleToFields,
  mapSuggestedCategory,
} from "../app/lib/product-parser";

async function getMlCategories() {
  // Prefer local cached file (useful if fetch has issues in this environment)
  try {
    const fs = await import("fs/promises");
    const text = await fs.readFile("scripts/tmp-ml-categories.json", "utf8");
    const json = JSON.parse(text);
    return json.categories as Array<{ id: string; value: string }>;
  } catch (err) {
    // Fallback to HTTP fetch
    const res = await fetch("http://localhost:3333/marketplace/ml/categories", {
      headers: { email: "fefelbf@gmail.com" },
    });
    if (!res.ok) throw new Error(`failed to fetch categories: ${res.status}`);
    const json = await res.json();
    return json.categories as Array<{ id: string; value: string }>;
  }
}

function findMatch(
  title: string,
  mlOptions: Array<{ id: string; value: string }>,
) {
  const t = title.toLowerCase();

  // 1) Exact fullPath match
  for (const opt of mlOptions) {
    if (t.includes(opt.value.toLowerCase())) {
      return {
        method: "fullPath",
        mlId: opt.id,
        fullPath: opt.value,
        category: opt.value.split(">")[0].trim(),
      };
    }
  }

  // 2) Match by leaf label
  for (const opt of mlOptions) {
    const leaf = opt.value.split(">").pop()!.trim().toLowerCase();
    if (leaf && t.includes(leaf)) {
      return {
        method: "leaf",
        mlId: opt.id,
        fullPath: opt.value,
        category: opt.value.split(">")[0].trim(),
      };
    }
  }

  // 3) Fallback to parser heuristics
  const parsed = parseTitleToFields(title);
  const mappedRes = mapSuggestedCategory(parsed.category || "");
  const mapped =
    (mappedRes && (mappedRes.detailedValue || mappedRes.topLevel)) || "";
  // Try to find an mlOption whose full path starts with mapped
  const found = mlOptions.find((o) =>
    o.value.toLowerCase().startsWith(mapped.toLowerCase()),
  );
  if (found) {
    return {
      method: "heuristic",
      mlId: found.id,
      fullPath: found.value,
      category: found.value.split(">")[0].trim(),
      parsed,
    };
  }

  return { method: "none", parsed };
}

async function main() {
  try {
    const mlOptions = await getMlCategories();
    const titles = [
      "Cubo de Roda Toyota Corolla 2016",
      "Porta Dianteira Fiat Palio 2005",
      "Alternador 12V Honda",
      "Pastilha de freio dianteira Gol",
      "Amortecedor dianteiro KA",
      "Sensor que não existe na lista",
    ];

    const results = titles
      .map((t) => ({
        title: t,
        ...findMatch(t, mlOptions),
      }))
      .map((r) => {
        // Simulate what the UI review would display for the Mercado Livre category
        const createMLListing = true; // assume the user enabled ML listing during review
        let displayedCategory = "Não especificada";
        if (createMLListing) {
          if (r.mlId) {
            const fromOptions = mlOptions.find((c) => c.id === r.mlId)?.value;
            const fromTop = null; // in UI we also check top-level mapping by id, but our mlOptions contains detailed ids
            displayedCategory =
              fromOptions || fromTop || r.category || "Não especificada";
          } else {
            displayedCategory = r.category || "Não especificada";
          }
        }
        return { ...r, displayedCategory };
      });

    console.log(JSON.stringify({ results }, null, 2));
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}

main();
