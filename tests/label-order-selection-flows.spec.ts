import { describe, it, expect, afterEach } from "vitest";

import { orderBySelection } from "../app/lib/label-order";
import {
  expandItemsToPages,
  normalizeQuantity,
} from "../app/produtos/lib/standalone-labels";

/**
 * Os fluxos de etiqueta ponta a ponta, no nível dos dados.
 *
 * A suíte roda em `environment: node`, sem jsdom nem testing-library, então não
 * dá para clicar no checkbox de verdade. O que estes testes reproduzem é a
 * composição EXATA que cada tela faz — a mesma coleção, a mesma estrutura de
 * seleção e as mesmas funções — de modo que qualquer troca de `orderBySelection`
 * por um `filter` de volta quebra aqui.
 *
 * Correspondência com o código de produção:
 *  - produto:      products-list.tsx `toggleSelectAll` + `handleGenerateLabels`
 *  - localização:  locations-list.tsx `handleGenerateLocationLabels`
 *  - avulsa:       standalone-label-dialog.tsx -> `expandItemsToPages`
 */

type Produto = { id: string; sku: string };
type Localizacao = { id: string; code: string };

afterEach(() => {
  delete process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY;
});

// ─────────────────────────────────────────────────────────────────────────────
// Produto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A listagem como o SQL entrega: ORDER BY (stock > 0) DESC, "createdAt" DESC.
 * Cadastrados 1..10 em sequência, todos com estoque => sai 10..1 na tela.
 */
const LISTA_PRODUTOS: Produto[] = Array.from({ length: 10 }, (_, i) => {
  const n = 10 - i;
  return { id: `prod-${n}`, sku: `SKU-${String(n).padStart(2, "0")}` };
});

/** O que `handleGenerateLabels` monta hoje para o gerador de PDF. */
const paginasDoPdf = (lista: Produto[], selecionados: string[]) =>
  orderBySelection(lista, selecionados, (p) => p.id).map((p) => p.sku);

/** `toggleSelectOne`: Set sobre o array anterior, preservando inserção. */
function toggleSelectOne(
  prev: string[],
  id: string,
  checked: boolean,
): string[] {
  const next = new Set(prev);
  if (checked) next.add(id);
  else next.delete(id);
  return Array.from(next);
}

describe("etiquetas de produto", () => {
  it("a tela mostra 10..1 — é daí que vinha a queixa", () => {
    expect(LISTA_PRODUTOS.map((p) => p.sku)).toEqual([
      "SKU-10",
      "SKU-09",
      "SKU-08",
      "SKU-07",
      "SKU-06",
      "SKU-05",
      "SKU-04",
      "SKU-03",
      "SKU-02",
      "SKU-01",
    ]);
  });

  it('"selecionar todos" segue a ordem VISÍVEL — quem manda é o seletor de ordenação', () => {
    // `toggleSelectAll` faz `products.map(p => p.id)`: a ordem de impressão é a
    // ordem da tela. Com a lista no padrão (mais recentes), sai 10..1.
    const selecionados = LISTA_PRODUTOS.map((p) => p.id);
    expect(paginasDoPdf(LISTA_PRODUTOS, selecionados)).toEqual(
      LISTA_PRODUTOS.map((p) => p.sku),
    );
  });

  it("com a lista ordenada por SKU crescente, selecionar todos sai 01..10", () => {
    // É o que o seletor "SKU crescente" entrega: a API já devolve nessa ordem,
    // então a ordem visível JÁ é a ordem desejada de impressão.
    const listaAsc = [...LISTA_PRODUTOS].reverse();
    const selecionados = listaAsc.map((p) => p.id);
    expect(paginasDoPdf(listaAsc, selecionados)).toEqual([
      "SKU-01",
      "SKU-02",
      "SKU-03",
      "SKU-04",
      "SKU-05",
      "SKU-06",
      "SKU-07",
      "SKU-08",
      "SKU-09",
      "SKU-10",
    ]);
  });

  it("clicando 3, 1, 2 o PDF sai 3, 1, 2", () => {
    let sel: string[] = [];
    sel = toggleSelectOne(sel, "prod-3", true);
    sel = toggleSelectOne(sel, "prod-1", true);
    sel = toggleSelectOne(sel, "prod-2", true);

    expect(paginasDoPdf(LISTA_PRODUTOS, sel)).toEqual([
      "SKU-03",
      "SKU-01",
      "SKU-02",
    ]);
  });

  it("desmarcar e remarcar move o item para o FIM da fila de impressão", () => {
    let sel: string[] = [];
    sel = toggleSelectOne(sel, "prod-1", true);
    sel = toggleSelectOne(sel, "prod-2", true);
    sel = toggleSelectOne(sel, "prod-3", true);
    // Tira o 1 e devolve: ele passa a ser o último marcado.
    sel = toggleSelectOne(sel, "prod-1", false);
    sel = toggleSelectOne(sel, "prod-1", true);

    expect(paginasDoPdf(LISTA_PRODUTOS, sel)).toEqual([
      "SKU-02",
      "SKU-03",
      "SKU-01",
    ]);
  });

  it("a poda por página (products-list.tsx) preserva a ordem de seleção", () => {
    // O efeito que roda a cada mudança de `products`:
    //   setSelectedIds(prev => prev.filter(id => visiveis.has(id)))
    const selecionados = ["prod-5", "prod-2", "prod-9"];
    const paginaAtual = LISTA_PRODUTOS.slice(0, 5); // prod-10..prod-6
    const visiveis = new Set(paginaAtual.map((p) => p.id));
    const podado = selecionados.filter((id) => visiveis.has(id));

    expect(podado).toEqual(["prod-9"]);
    expect(paginasDoPdf(paginaAtual, podado)).toEqual(["SKU-09"]);
  });

  it("item que saiu da página não quebra a geração", () => {
    const paginaAtual = LISTA_PRODUTOS.slice(0, 3); // prod-10, prod-9, prod-8
    expect(paginasDoPdf(paginaAtual, ["prod-8", "prod-1", "prod-10"])).toEqual([
      "SKU-08",
      "SKU-10",
    ]);
  });

  it("com a flag legada, o PDF volta a ignorar a ordem de clique", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    // Clicou 1, 2, 3 — mas o legado devolve na ordem da coleção (10..1).
    expect(
      paginasDoPdf(LISTA_PRODUTOS, ["prod-1", "prod-2", "prod-3"]),
    ).toEqual(["SKU-03", "SKU-02", "SKU-01"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Localização
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /locations?tree=full` devolve a lista achatada em `code` ASC. A tela
 * renderiza a ÁRVORE (pré-ordem), então a ordem plana nem é a ordem visível —
 * mais um motivo para o PDF seguir a seleção, e não a coleção.
 */
const FLAT_LOCALIZACOES: Localizacao[] = [
  { id: "loc-a", code: "GAL-01" },
  { id: "loc-b", code: "GAL-02" },
  { id: "loc-c", code: "PRAT-99" }, // filha de GAL-01, mas ordena depois
];

describe("etiquetas de localização", () => {
  it("respeita a ordem de clique, não o code ASC da lista achatada", () => {
    const selecionados = new Set<string>();
    selecionados.add("loc-c");
    selecionados.add("loc-a");

    const out = orderBySelection(
      FLAT_LOCALIZACOES,
      Array.from(selecionados),
      (l) => l.id,
    );
    expect(out.map((l) => l.code)).toEqual(["PRAT-99", "GAL-01"]);
  });

  it("Set de seleção preserva a ordem de inserção mesmo com toggle", () => {
    const sel = new Set<string>();
    sel.add("loc-a");
    sel.add("loc-b");
    sel.delete("loc-a");
    sel.add("loc-a"); // volta para o fim

    const out = orderBySelection(
      FLAT_LOCALIZACOES,
      Array.from(sel),
      (l) => l.id,
    );
    expect(out.map((l) => l.code)).toEqual(["GAL-02", "GAL-01"]);
  });

  it("localização selecionada que sumiu da árvore é ignorada", () => {
    const out = orderBySelection(
      FLAT_LOCALIZACOES,
      ["loc-b", "loc-inexistente"],
      (l) => l.id,
    );
    expect(out.map((l) => l.code)).toEqual(["GAL-02"]);
  });

  it("com a flag legada volta ao code ASC da lista achatada", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    const out = orderBySelection(
      FLAT_LOCALIZACOES,
      ["loc-c", "loc-a"],
      (l) => l.id,
    );
    expect(out.map((l) => l.code)).toEqual(["GAL-01", "PRAT-99"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Etiqueta avulsa
// ─────────────────────────────────────────────────────────────────────────────

describe("etiqueta avulsa", () => {
  it("mantém a linha 1 antes da linha 2, com as cópias contíguas", () => {
    const pages = expandItemsToPages([
      { name: "Farol Esquerdo", sku: "AV-1", quantity: 3 },
      { name: "Farol Direito", sku: "AV-2", quantity: 2 },
    ]);

    expect(pages.map((p) => p.sku)).toEqual([
      "AV-1",
      "AV-1",
      "AV-1",
      "AV-2",
      "AV-2",
    ]);
  });

  it("três linhas com quantidades diferentes não se intercalam", () => {
    const pages = expandItemsToPages([
      { name: "A", sku: "AV-1", quantity: 1 },
      { name: "B", sku: "AV-2", quantity: 4 },
      { name: "C", sku: "AV-3", quantity: 2 },
    ]);

    expect(pages.map((p) => p.sku)).toEqual([
      "AV-1",
      "AV-2",
      "AV-2",
      "AV-2",
      "AV-2",
      "AV-3",
      "AV-3",
    ]);
  });

  it("quantidade ausente ou inválida vale 1 e não altera a ordem", () => {
    const pages = expandItemsToPages([
      { name: "A", sku: "AV-1" },
      { name: "B", sku: "AV-2", quantity: 0 },
      { name: "C", sku: "AV-3", quantity: -5 },
      { name: "D", sku: "AV-4", quantity: 2.9 },
    ]);

    expect(pages.map((p) => p.sku)).toEqual([
      "AV-1",
      "AV-2",
      "AV-3",
      "AV-4",
      "AV-4",
    ]);
    expect(normalizeQuantity(2.9)).toBe(2);
  });

  it("a expansão não depende da flag — este fluxo nunca esteve invertido", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    const pages = expandItemsToPages([
      { name: "A", sku: "AV-1", quantity: 2 },
      { name: "B", sku: "AV-2", quantity: 1 },
    ]);
    expect(pages.map((p) => p.sku)).toEqual(["AV-1", "AV-1", "AV-2"]);
  });
});
