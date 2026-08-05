"use client";

import { useCallback, useEffect, useState } from "react";

import { type ProductSort } from "@/app/interfaces/product.interface";

/**
 * Chave da versão anterior, que persistia a escolha. Mantida só para APAGAR o
 * resíduo de quem já usou o seletor — sem isso, quem experimentou "SKU
 * crescente" continuaria com a chave parada no navegador para sempre.
 * Pode sair do código depois de 05/09/2026.
 */
const CHAVE_LEGADA = "dexo:produtos:sort";

/** Rótulos do seletor. A ordem aqui é a ordem que aparece na tela. */
export const PRODUCT_SORT_LABELS: Record<ProductSort, string> = {
  recentes: "Mais recentes",
  sku_asc: "SKU crescente",
  sku_desc: "SKU decrescente",
};

/**
 * Ordenação da lista de Produtos.
 *
 * NÃO é persistida — de propósito, desde 05/08/2026. A versão anterior gravava
 * a escolha no `localStorage`, e isso tinha um efeito que ninguém pediu:
 * bastava experimentar "SKU crescente" UMA vez para a lista abrir naquela
 * ordem em toda visita seguinte, indefinidamente. O sintoma relatado em
 * produção foi "cadastrei um produto e ele não apareceu onde sempre aparecia":
 * a ordenação por SKU seguia valendo, silenciosamente, dias depois do teste.
 *
 * Agora a página sempre abre em "Mais recentes", que é o comportamento
 * histórico da lista; a ordenação por SKU vale enquanto o usuário está naquela
 * tela, que é justamente quando ele precisa dela (imprimir etiqueta em ordem).
 */
export function useProductSort(
  defaultValue: ProductSort = "recentes",
): [ProductSort, (next: ProductSort) => void] {
  const [sort, setSort] = useState<ProductSort>(defaultValue);

  // Limpeza única do resíduo da versão que persistia.
  useEffect(() => {
    try {
      window.localStorage.removeItem(CHAVE_LEGADA);
    } catch {
      // localStorage pode estar bloqueado (modo privado etc.) — ignora.
    }
  }, []);

  const set = useCallback((next: ProductSort) => setSort(next), []);

  return [sort, set];
}
