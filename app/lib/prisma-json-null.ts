/**
 * Nulo de coluna `Json` no Prisma — a armadilha e a saída.
 *
 * ── A ARMADILHA ───────────────────────────────────────────────────────────
 *
 * Escrever `null` do JavaScript numa coluna `Json?` **NÃO** grava `NULL` do
 * SQL. Grava o literal JSON `null`, que é um VALOR: a coluna deixa de ser nula
 * para o banco e passa a casar com `IS NOT NULL`.
 *
 * Medido contra o banco de produção em 21/08/2026 (escrita numa linha real,
 * lida de volta com `jsonb_typeof`, dentro de transação desfeita):
 *
 *   data: { imageUrlsOverride: null }              -> jsonb_typeof = 'null'  ❌
 *   data: { imageUrlsOverride: Prisma.JsonNull }   -> jsonb_typeof = 'null'  ❌
 *   data: { imageUrlsOverride: Prisma.DbNull }     -> IS NULL de verdade     ✅
 *
 * ⚠️ E o Prisma **não reclama**: `updateMany` aceita `null` em campo `Json` sem
 * lançar nada. O `null` puro se comporta como `Prisma.JsonNull`. Não há erro no
 * log, não há teste vermelho — só linhas que passam a contar como "tem valor".
 *
 * ⚠️ O log de query do Prisma NÃO distingue os dois: serializa os dois como
 * `null` nos parâmetros. Quem tentar diagnosticar isso pelo log não vai ver
 * nada. O único jeito honesto é ler de volta com `jsonb_typeof`.
 *
 * ── POR QUE IMPORTA, SE A LEITURA É IGUAL ─────────────────────────────────
 *
 * Na leitura os dois casos chegam ao JavaScript como `null` (confirmado), e
 * todo consumidor faz `Array.isArray` / `typeof` / `!= null` antes de usar. Não
 * é bug de comportamento — é desperdício, e ele é caro onde existe índice
 * parcial `WHERE coluna IS NOT NULL`: as linhas "limpas" continuam dentro do
 * índice e continuam sendo carregadas.
 *
 * Em `ProductListing.imageUrlsOverride`, isso significava 919 linhas de resíduo
 * carregadas a cada troca de foto para encontrar 1 anúncio de verdade.
 *
 * ── COMO USAR ─────────────────────────────────────────────────────────────
 *
 * Toda escrita em coluna `Json?` que aceite "limpar" passa por aqui. As duas
 * formas cobrem os dois formatos de código que existem no projeto: campo a
 * campo (`campoJson`) e objeto montado dinamicamente (`comNulosDeJsonSeguros`).
 *
 * Precedente da casa, anterior a este arquivo: `product.repository.ts` já
 * fazia `data.attributes ?? Prisma.DbNull` para `Product.attributes`.
 *
 * ── O PASSIVO HISTÓRICO ───────────────────────────────────────────────────
 *
 * Este arquivo estanca a origem, mas não limpa o que já foi gravado errado. A
 * conversão das linhas antigas está em
 * `prisma/ddl/2026-08-21-product-listing-json-null-para-sql-null.sql`, para
 * rodar em produção DEPOIS do deploy deste código.
 *
 * Como saber, a qualquer momento, se ele já rodou:
 *
 *   SELECT count(*) FILTER (WHERE "imageUrlsOverride"  = 'null'::jsonb) AS fotos,
 *          count(*) FILTER (WHERE "attributesOverride" = 'null'::jsonb) AS ficha
 *     FROM "ProductListing";
 *
 * Zero nas duas = já foi convertido. Números altos com este código no ar = o
 * DDL ainda está pendente (o código novo não repõe resíduo, então eles param de
 * crescer, mas não caem sozinhos).
 */

import { Prisma } from "@prisma/client";

/**
 * Traduz um valor destinado a coluna `Json?` do Prisma.
 *
 *   `undefined` → `undefined`      não toca a coluna
 *   `null`      → `Prisma.DbNull`  limpa DE VERDADE (NULL do SQL)
 *   qualquer    → o próprio valor
 *
 * A distinção entre `undefined` e `null` é preservada de propósito: os
 * repositórios usam `undefined` para "o chamador não mandou este campo" e
 * `null` para "o chamador mandou limpar". Colapsar os dois mudaria
 * comportamento.
 */
export function campoJson(
  valor: unknown,
): typeof Prisma.DbNull | Prisma.InputJsonValue | undefined {
  if (valor === undefined) return undefined;
  if (valor === null) return Prisma.DbNull;
  return valor as Prisma.InputJsonValue;
}

/**
 * Colunas `Json?` do model `ProductListing`.
 *
 * ⚠️ Esta lista tem de acompanhar o schema. Uma coluna `Json?` nova que fique
 * de fora volta a gravar o literal JSON `null` em silêncio — sem erro, sem
 * teste vermelho. É por isso que existe
 * `tests/prisma-json-null.spec.ts`, que compara esta lista com o
 * `prisma/schema.prisma` e quebra se elas divergirem.
 */
export const COLUNAS_JSON_DE_PRODUCT_LISTING = [
  "compatDiagnostics",
  "imageUrlsOverride",
  "attributesOverride",
  "compatibilitiesOverride",
] as const;

/**
 * Versão para objeto montado dinamicamente (o formato do
 * `clearOverridesForEditedFields`, que acumula `campo = null` num `Record` e
 * escreve tudo de uma vez).
 *
 * Devolve uma CÓPIA: só as chaves listadas em `colunasJson` **e que valem
 * exatamente `null`** viram `Prisma.DbNull`. `undefined` e valores reais ficam
 * como estão, e as colunas escalares (`titleOverride`, `priceOverride`…) não
 * são tocadas — nelas o `null` do JavaScript já grava `NULL` do SQL.
 */
export function comNulosDeJsonSeguros<T extends Record<string, unknown>>(
  dados: T,
  colunasJson: readonly string[],
): Record<string, unknown> {
  const saida: Record<string, unknown> = { ...dados };
  for (const coluna of colunasJson) {
    if (saida[coluna] === null) saida[coluna] = Prisma.DbNull;
  }
  return saida;
}
