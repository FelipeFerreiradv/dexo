/**
 * Acesso a colunas por RÓTULO, com sinônimos.
 *
 * Um mesmo sistema legado exporta variantes do mesmo relatório trocando o nome
 * de um campo ("Chassi" / "Numero chassi", "Valor da compra" / "valor_compra").
 * Sem isto, cada mapper acumularia `get(row,"A") ?? get(row,"B") ?? …` — que
 * além de repetitivo tem um bug embutido: uma CÉLULA VAZIA numa coluna que
 * existe faria o leitor cair para o sinônimo seguinte, que pode ser um campo
 * semanticamente diferente.
 *
 * Aqui a escolha do rótulo é decidida pelo HEADER (a coluna existe?) e só
 * depois se lê a célula — vazio continua vazio.
 */

import type { DetectedFile, ImportRow } from "../import.types";
import { createNormKeyMemo, normKey } from "./normalize";

/** Chaves normalizadas do header (acento/caixa/pontuação-insensíveis). */
export function headerKeys(file: DetectedFile): Set<string> {
  return new Set(file.header.map((h) => normKey(h)));
}

/** Alguma das colunas existe no arquivo? */
export function hasColumn(file: DetectedFile, ...labels: string[]): boolean {
  const keys = headerKeys(file);
  return labels.some((l) => keys.has(normKey(l)));
}

/**
 * Leitor de linha que resolve o PRIMEIRO rótulo presente no header. Construir
 * uma vez por arquivo (fora do laço) — o Set do header é calculado só aí.
 */
export function aliasReader(
  file: DetectedFile,
): (row: ImportRow, ...labels: string[]) => unknown {
  const keys = headerKeys(file);
  // Memo do rótulo: este leitor roda por LINHA (ver createNormKeyMemo).
  const nk = createNormKeyMemo();
  return (row, ...labels) => {
    for (const label of labels) {
      if (keys.has(nk(label))) return file.get(row, label);
    }
    return null;
  };
}
