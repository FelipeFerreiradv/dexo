/**
 * Resolução do (sistema, entidade) EFETIVO da importação.
 *
 * O operador escolhe o sistema num seletor, mas há três opções que começam
 * com "IBR" (WebDesmonte clássico, export tabular e IBR Soft) — é fácil pegar
 * a errada e cair num "Falta o arquivo obrigatório…". Como cada arquivo se
 * identifica pela ASSINATURA de colunas, o sistema certo é dedutível só pelos
 * arquivos.
 *
 * Regra (zero-regressão): a seleção do operador é HONRADA sempre que bate com
 * os arquivos. Só quando ela NÃO bate (nenhum arquivo aceito) é que inferimos
 * o sistema pelos próprios arquivos e ajustamos — e mesmo aí a PRÉVIA mostra
 * exatamente o que será importado antes de qualquer escrita.
 */

import type { ImportEntity, ImportFile, ImportSystem } from "./import.types";
import { ImportValidationError } from "./import.types";
import {
  detectAndValidate,
  inferSystemEntity,
  type DetectResult,
} from "./import-detector";
import { isRunnerAvailable } from "./import-runners";

/** Rótulo humano por sistema (mensagens/dicas do servidor). */
export const SYSTEM_LABELS: Record<ImportSystem, string> = {
  VAAPT: "Vaapt",
  WEBDESMONTE: "IBR clássico — WebDesmonte (CSV)",
  IBR: "IBR — export tabular (estoque/NF-e)",
  IBRSOFT: "IBR Soft — export completo",
  DEXO: "Template Dexo (CSV)",
};

export interface EffectiveSelection extends DetectResult {
  system: ImportSystem;
  entity: ImportEntity;
  /** true = a seleção do operador não batia e o sistema foi deduzido. */
  autoDetected: boolean;
}

export function resolveEffectiveSelection(
  system: ImportSystem,
  entity: ImportEntity,
  files: ImportFile[],
): EffectiveSelection {
  // 1. Honra a seleção do operador quando ela bate com os arquivos.
  try {
    const res = detectAndValidate(system, entity, files);
    if (res.files.length > 0) {
      return { system, entity, ...res, autoDetected: false };
    }
  } catch (err) {
    // Só um erro de validação (seleção incoerente) autoriza a inferência;
    // qualquer outro erro sobe.
    if (!(err instanceof ImportValidationError)) throw err;
  }

  // 2. Seleção não bate → tenta inferir o sistema pelos próprios arquivos.
  const inferred = inferSystemEntity(files);
  if (
    inferred &&
    !(inferred.system === system && inferred.entity === entity) &&
    isRunnerAvailable(inferred.system, inferred.entity)
  ) {
    const res = detectAndValidate(inferred.system, inferred.entity, files);
    if (res.files.length > 0) {
      return {
        system: inferred.system,
        entity: inferred.entity,
        ...res,
        autoDetected: true,
      };
    }
  }

  // 3. Sem inferência confiante → repropaga o erro claro da seleção original
  //    (que já lista os arquivos ignorados e pede para conferir o sistema).
  return {
    system,
    entity,
    ...detectAndValidate(system, entity, files),
    autoDetected: false,
  };
}
