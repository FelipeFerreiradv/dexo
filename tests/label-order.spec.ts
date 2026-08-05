import { describe, it, expect, afterEach } from "vitest";

import {
  orderBySelection,
  selectAllIdsInPrintOrder,
} from "../app/lib/label-order";

/**
 * Helper puro da ordem canônica das etiquetas.
 *
 * O contrato provado aqui:
 *  (a) o PDF sai na ordem em que o usuário selecionou, não na ordem da tela;
 *  (b) id que sumiu da coleção é ignorado sem quebrar;
 *  (c) "selecionar todos" entrega o mais antigo primeiro (lista newest-first);
 *  (d) com NEXT_PUBLIC_LABELS_ORDER_LEGACY=1 as duas funções voltam a ser
 *      byte-idênticas ao comportamento anterior.
 */

type Item = { id: string; sku: string };

const item = (id: string): Item => ({ id, sku: `SKU-${id}` });

// Lista como a tela serve hoje: mais novo primeiro.
const LISTA_NEWEST_FIRST: Item[] = [
  "10",
  "9",
  "8",
  "7",
  "6",
  "5",
  "4",
  "3",
  "2",
  "1",
].map(item);

const ids = (list: Item[]) => list.map((i) => i.id);

afterEach(() => {
  delete process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY;
});

describe("orderBySelection", () => {
  it("respeita a ordem de seleção, não a ordem da coleção", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(ids(orderBySelection(items, ["c", "a", "b"], (i) => i.id))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("seleção 3, 1, 2 gera PDF 3, 1, 2 (caso do enunciado)", () => {
    const items = [item("1"), item("2"), item("3")];
    expect(ids(orderBySelection(items, ["3", "1", "2"], (i) => i.id))).toEqual([
      "3",
      "1",
      "2",
    ]);
  });

  it("seleção fora da ordem da lista não é reordenada pela lista", () => {
    // A lista está newest-first; o usuário clicou de baixo para cima.
    const selecao = ["1", "2", "3"];
    expect(
      ids(orderBySelection(LISTA_NEWEST_FIRST, selecao, (i) => i.id)),
    ).toEqual(["1", "2", "3"]);
  });

  it("ignora id que não está mais na coleção sem quebrar", () => {
    const items = [item("a"), item("b")];
    expect(
      ids(orderBySelection(items, ["a", "sumiu", "b"], (i) => i.id)),
    ).toEqual(["a", "b"]);
  });

  it("devolve vazio quando nenhum id selecionado existe na coleção", () => {
    const items = [item("a")];
    expect(orderBySelection(items, ["x", "y"], (i) => i.id)).toEqual([]);
  });

  it("lista vazia devolve vazio", () => {
    expect(orderBySelection([] as Item[], ["a"], (i) => i.id)).toEqual([]);
  });

  it("seleção vazia devolve vazio", () => {
    expect(orderBySelection([item("a")], [], (i) => i.id)).toEqual([]);
  });

  it("seleção de 1 item devolve exatamente aquele item", () => {
    const items = [item("a"), item("b"), item("c")];
    const out = orderBySelection(items, ["b"], (i) => i.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(items[1]);
  });

  it("id repetido na seleção não duplica a etiqueta", () => {
    const items = [item("a"), item("b")];
    expect(ids(orderBySelection(items, ["a", "a", "b"], (i) => i.id))).toEqual([
      "a",
      "b",
    ]);
  });

  it("devolve as MESMAS referências dos itens da coleção", () => {
    const items = [item("a"), item("b")];
    const out = orderBySelection(items, ["b", "a"], (i) => i.id);
    expect(out[0]).toBe(items[1]);
    expect(out[1]).toBe(items[0]);
  });

  it("não muta a coleção nem a seleção recebidas", () => {
    const items = [item("a"), item("b"), item("c")];
    const selecao = ["c", "a"];
    orderBySelection(items, selecao, (i) => i.id);
    expect(ids(items)).toEqual(["a", "b", "c"]);
    expect(selecao).toEqual(["c", "a"]);
  });

  it("é linear em 5.000 itens (sem O(n·m) escondido)", () => {
    const grandes = Array.from({ length: 5000 }, (_, i) => item(String(i)));
    // Seleciona todos, na ordem inversa da coleção.
    const selecao = grandes.map((i) => i.id).reverse();

    const t0 = Date.now();
    const out = orderBySelection(grandes, selecao, (i) => i.id);
    const elapsed = Date.now() - t0;

    expect(out).toHaveLength(5000);
    expect(out[0].id).toBe("4999");
    expect(out[4999].id).toBe("0");
    // O caminho antigo (includes dentro de filter) faria 25 milhões de
    // comparações aqui. Teto folgado: o que se quer provar é a ausência de
    // comportamento quadrático, não um número de milissegundos.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("selectAllIdsInPrintOrder", () => {
  it("inverte a ordem visível para entregar o mais antigo primeiro", () => {
    expect(selectAllIdsInPrintOrder(LISTA_NEWEST_FIRST, (i) => i.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
  });

  it("selecionar todos + orderBySelection = PDF do mais antigo ao mais novo", () => {
    const selecao = selectAllIdsInPrintOrder(LISTA_NEWEST_FIRST, (i) => i.id);
    const paginas = orderBySelection(LISTA_NEWEST_FIRST, selecao, (i) => i.id);
    expect(ids(paginas)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
  });

  it("lista vazia devolve vazio", () => {
    expect(selectAllIdsInPrintOrder([] as Item[], (i) => i.id)).toEqual([]);
  });

  it("não muta a coleção recebida", () => {
    const items = [item("a"), item("b"), item("c")];
    selectAllIdsInPrintOrder(items, (i) => i.id);
    expect(ids(items)).toEqual(["a", "b", "c"]);
  });
});

describe("kill-switch NEXT_PUBLIC_LABELS_ORDER_LEGACY=1", () => {
  it("orderBySelection volta a devolver a ordem da COLEÇÃO", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    const selecao = ["1", "2", "3"];
    expect(
      ids(orderBySelection(LISTA_NEWEST_FIRST, selecao, (i) => i.id)),
    ).toEqual(["3", "2", "1"]);
  });

  it("orderBySelection legado é idêntico ao filter+includes anterior", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    const selecao = ["8", "3", "10"];
    const anterior = LISTA_NEWEST_FIRST.filter((i) => selecao.includes(i.id));
    expect(orderBySelection(LISTA_NEWEST_FIRST, selecao, (i) => i.id)).toEqual(
      anterior,
    );
  });

  it("selectAllIdsInPrintOrder volta a ser a ordem visível", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    expect(selectAllIdsInPrintOrder(LISTA_NEWEST_FIRST, (i) => i.id)).toEqual(
      LISTA_NEWEST_FIRST.map((i) => i.id),
    );
  });

  it("legado ignora id ausente, como o filter anterior", () => {
    process.env.NEXT_PUBLIC_LABELS_ORDER_LEGACY = "1";
    const out = orderBySelection([item("a")], ["a", "sumiu"], (i) => i.id);
    expect(ids(out)).toEqual(["a"]);
  });
});
