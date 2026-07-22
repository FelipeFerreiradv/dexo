import { createHash } from "crypto";
import type { ImportEntity, ImportFile, ImportSystem } from "../import.types";

/**
 * Versão do motor de mapeamento. Entra no hash da prévia: uma prévia gerada
 * antes de um deploy que mudou um mapper NÃO pode ser aplicada depois (o
 * plano executado seria diferente do previsto). Incrementar a cada mudança
 * de comportamento em mappers/executors.
 */
// 2: o detector passou a reconhecer a variante do relatório de veículos do
// Vaapt sem Marca/Modelo, e o mapper de sucatas lê os rótulos por sinônimo —
// uma prévia gerada antes deste deploy planejava menos sucatas do que o apply
// criaria.
export const MAPPER_VERSION = 2;

/**
 * Hash que liga a prévia ao apply: sha256 dos bytes dos arquivos (em ordem
 * determinística de fieldname+filename) + alvo + sistema + entidade + versão
 * do motor. O apply recalcula e compara — arquivo trocado/reordenado ou motor
 * atualizado ⇒ 409 "gere uma nova prévia".
 */
export function computePreviewHash(input: {
  targetUserId: string;
  system: ImportSystem;
  entity: ImportEntity;
  files: ImportFile[];
}): string {
  const h = createHash("sha256");
  const sorted = [...input.files].sort((a, b) =>
    `${a.fieldname}|${a.filename}`.localeCompare(
      `${b.fieldname}|${b.filename}`,
    ),
  );
  for (const f of sorted) {
    h.update(f.fieldname);
    h.update("|");
    h.update(f.buffer);
    h.update("|");
  }
  h.update(input.targetUserId);
  h.update("|");
  h.update(input.system);
  h.update("|");
  h.update(input.entity);
  h.update("|");
  h.update(String(MAPPER_VERSION));
  return h.digest("hex");
}

/** Hash curto (8 hex) de uma linha — marker de idempotência de contas. */
export function shortLineHash(parts: Array<string | number | null | undefined>): string {
  const h = createHash("sha256");
  h.update(parts.map((p) => String(p ?? "")).join("|"));
  return h.digest("hex").slice(0, 8);
}
