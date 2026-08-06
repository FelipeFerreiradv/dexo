import { describe, it, expect } from "vitest";

import {
  applyOemTags,
  splitOemTags,
  type MLAttributeEntry,
} from "../app/marketplaces/lib/ml-oem-tags.logic";

/**
 * Código OEM como lista de tags no payload do ML.
 *
 * O atributo `OEM` é `multivalued: true` na API real. Enviar
 * `value_name: "farol, dianteiro"` faz o ML guardar UMA tag com a vírgula
 * dentro; o correto é `values: [{name}, {name}]`.
 */

const OEM_IDS = new Set(["OEM"]);

describe("splitOemTags", () => {
  it("quebra por vírgula preservando a ordem digitada", () => {
    expect(splitOemTags("farol, dianteiro, direito")).toEqual([
      "farol",
      "dianteiro",
      "direito",
    ]);
  });

  it("tira espaços sobrando de cada tag", () => {
    expect(splitOemTags("  farol ,dianteiro  ,  direito  ")).toEqual([
      "farol",
      "dianteiro",
      "direito",
    ]);
  });

  it("descarta vazios de vírgula dupla, sobrando e no início", () => {
    expect(splitOemTags(",farol,,dianteiro,")).toEqual(["farol", "dianteiro"]);
    expect(splitOemTags(" , , ")).toEqual([]);
  });

  it("dedup EXATO, mantendo a primeira ocorrência", () => {
    expect(splitOemTags("farol, dianteiro, farol")).toEqual([
      "farol",
      "dianteiro",
    ]);
  });

  it("NÃO normaliza caixa: código de peça pode ser case-significativo", () => {
    expect(splitOemTags("AB123, ab123")).toEqual(["AB123", "ab123"]);
  });

  it("só vírgula separa — hífen e barra vivem DENTRO de código OEM", () => {
    expect(splitOemTags("5U0-121049")).toEqual(["5U0-121049"]);
    expect(splitOemTags("A/B 123")).toEqual(["A/B 123"]);
  });

  it("entrada vazia ou não-string devolve lista vazia", () => {
    expect(splitOemTags("")).toEqual([]);
    expect(splitOemTags(undefined as unknown as string)).toEqual([]);
    expect(splitOemTags(null as unknown as string)).toEqual([]);
  });
});

describe("applyOemTags", () => {
  const attr = (e: MLAttributeEntry): MLAttributeEntry[] => [e];

  it("2+ tags viram `values` na ordem, sem value_name nem value_id", () => {
    const out = applyOemTags(
      attr({ id: "OEM", value_name: "farol, dianteiro, direito" }),
      OEM_IDS,
    );
    expect(out[0]).toEqual({
      id: "OEM",
      values: [{ name: "farol" }, { name: "dianteiro" }, { name: "direito" }],
    });
    expect(out[0].value_name).toBeUndefined();
    expect(out[0].value_id).toBeUndefined();
  });

  // O caminho dominante: praticamente todo produto tem um código só. Manter o
  // singular deixa o payload byte-idêntico ao que já vai hoje.
  it("UMA tag continua saindo como `value_name` singular", () => {
    const entrada = attr({ id: "OEM", value_name: "5U0121049" });
    const out = applyOemTags(entrada, OEM_IDS);
    expect(out[0]).toEqual({ id: "OEM", value_name: "5U0121049" });
    expect(out[0].values).toBeUndefined();
  });

  // EXPECTATIVA ALTERADA em 06/08/2026, com evidência de produção.
  //
  // Antes este teste exigia que a vírgula sobrando fosse PRESERVADA
  // (`"5U0121049,"`). Estava errado: o Mercado Livre separa o `value_name` por
  // vírgula por conta própria, então o que sobrava era um valor vazio — e, no
  // caso irmão de códigos repetidos, um `402 ...values.name.duplicated` que
  // impedia a publicação (medido no SKU 2791). Continua singular, agora limpo.
  it("vírgula sobrando é removida, e o valor continua singular", () => {
    const out = applyOemTags(attr({ id: "OEM", value_name: "5U0121049," }), OEM_IDS);
    expect(out[0]).toEqual({ id: "OEM", value_name: "5U0121049" });
    expect(out[0].values).toBeUndefined();
  });

  it("só espaços e vírgulas: entrada devolvida intacta", () => {
    const out = applyOemTags(attr({ id: "OEM", value_name: " , " }), OEM_IDS);
    expect(out[0]).toEqual({ id: "OEM", value_name: " , " });
  });

  it("NÃO toca em atributos fora do vocabulário de OEM", () => {
    const out = applyOemTags(
      [
        { id: "BRAND", value_name: "Volkswagen, Fiat" },
        { id: "PART_NUMBER", value_name: "a, b" },
        { id: "MATERIAL", value_id: "X", value_name: "Aço, Ferro" },
      ],
      OEM_IDS,
    );
    expect(out).toEqual([
      { id: "BRAND", value_name: "Volkswagen, Fiat" },
      { id: "PART_NUMBER", value_name: "a, b" },
      { id: "MATERIAL", value_id: "X", value_name: "Aço, Ferro" },
    ]);
  });

  it("preserva a posição do OEM no array e os vizinhos", () => {
    const out = applyOemTags(
      [
        { id: "BRAND", value_name: "VW" },
        { id: "OEM", value_name: "a, b" },
        { id: "SELLER_SKU", value_name: "SKU-1" },
      ],
      OEM_IDS,
    );
    expect(out.map((a) => a.id)).toEqual(["BRAND", "OEM", "SELLER_SKU"]);
    expect(out[1].values).toEqual([{ name: "a" }, { name: "b" }]);
    expect(out[2]).toEqual({ id: "SELLER_SKU", value_name: "SKU-1" });
  });

  // A escada de retry da publicação reprocessa o mesmo array várias vezes.
  it("IDEMPOTENTE: entrada já em `values` volta igual", () => {
    const jaLista = applyOemTags(attr({ id: "OEM", value_name: "a, b" }), OEM_IDS);
    const segundaPassada = applyOemTags(jaLista, OEM_IDS);
    expect(segundaPassada).toEqual(jaLista);
    expect(segundaPassada[0].values).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("PURA: não muta o array nem as entradas de origem", () => {
    const entrada: MLAttributeEntry[] = [{ id: "OEM", value_name: "a, b" }];
    const copia = JSON.parse(JSON.stringify(entrada));
    const out = applyOemTags(entrada, OEM_IDS);
    expect(entrada).toEqual(copia);
    expect(out).not.toBe(entrada);
  });

  it("array vazio devolve array vazio", () => {
    expect(applyOemTags([], OEM_IDS)).toEqual([]);
  });

  it("vocabulário vazio não converte nada", () => {
    const out = applyOemTags(
      attr({ id: "OEM", value_name: "a, b" }),
      new Set<string>(),
    );
    expect(out[0]).toEqual({ id: "OEM", value_name: "a, b" });
  });
});

/**
 * MEDIDO EM PRODUÇÃO — SKU 2791, 06/08/2026.
 *
 * O operador digitou o MESMO código três vezes: "teste, teste, teste". O dedup
 * colapsa para uma tag só e a versão original desta função devolvia o atributo
 * INALTERADO — ou seja, com a string de vírgulas intacta.
 *
 * O Mercado Livre separa o `value_name` por vírgula por conta própria e recusa
 * repetidos: `402 item.attribute.values.name.duplicated — Attribute OEM has
 * values with names: [teste] duplicated`. O anúncio não publicava.
 *
 * Confirmado contra a API (POST /items/validate) que mandar o valor já limpo
 * elimina o 402.
 */
describe("applyOemTags — repetidos que colapsam para uma tag só", () => {
  const OEM = new Set(["OEM"]);

  it("limpa a string quando os códigos repetidos viram um só", () => {
    const r = applyOemTags(
      [{ id: "OEM", value_name: "teste, teste, teste" }],
      OEM,
    );
    expect(r[0]).toEqual({ id: "OEM", value_name: "teste" });
    expect((r[0] as { values?: unknown }).values).toBeUndefined();
  });

  it("remove vírgula sobrando no fim", () => {
    const r = applyOemTags([{ id: "OEM", value_name: "5U0121049," }], OEM);
    expect(r[0]).toEqual({ id: "OEM", value_name: "5U0121049" });
  });

  it("um código sem separador continua BYTE-IDÊNTICO, pela mesma referência", () => {
    // A garantia que protege a esmagadora maioria dos produtos.
    const entrada = [{ id: "OEM", value_name: "5U0121049" }];
    const r = applyOemTags(entrada, OEM);
    expect(r[0]).toBe(entrada[0]);
  });

  it("espaço em volta não conta como separador e não altera o payload", () => {
    const entrada = [{ id: "OEM", value_name: "  5U0121049  " }];
    const r = applyOemTags(entrada, OEM);
    expect(r[0]).toBe(entrada[0]);
  });

  it("dois códigos distintos seguem virando lista de tags", () => {
    const r = applyOemTags([{ id: "OEM", value_name: "a, b" }], OEM);
    expect(r[0]).toEqual({ id: "OEM", values: [{ name: "a" }, { name: "b" }] });
  });

  it("continua idempotente depois da limpeza", () => {
    const uma = applyOemTags([{ id: "OEM", value_name: "teste, teste" }], OEM);
    const duas = applyOemTags(uma, OEM);
    expect(duas).toEqual(uma);
  });
});
