/**
 * PRÉVIA de importação — parseia, detecta, roda o executor com dryRun=true
 * (ZERO escritas; os executors só fazem leituras de preload) e devolve o
 * relatório + o `previewHash` que o apply exigirá de volta.
 *
 * A prévia é consultiva: o banco pode mudar entre prévia e apply; quem
 * garante a correção é a idempotência do apply (preloads frescos). O
 * relatório FINAL do job é a fonte de verdade.
 */

import type {
  ImportEntity,
  ImportFile,
  ImportReport,
  ImportSystem,
  PreviewResult,
} from "./import.types";
import { detectAndValidate } from "./import-detector";
import { resolveRunner } from "./import-runners";
import { assertTargetAdmin } from "./import-target";
import { computePreviewHash } from "./lib/preview-hash";

const ORDER_HINT =
  "Ordem recomendada: Clientes → Localizações → Sucatas → Vínculo de produtos → Contas → NF-e.";

function buildDicas(report: ImportReport): string[] {
  const dicas: string[] = [ORDER_HINT];
  if (report.semProduto && report.semProduto.total > 0) {
    dicas.push(
      `${report.semProduto.total} SKU(s) do arquivo não têm produto correspondente no Dexo — serão pulados e reportados (nunca vinculados a outro produto). Confira se o "Importar anúncios" já foi executado.`,
    );
  }
  if (report.ambiguos && report.ambiguos.total > 0) {
    dicas.push(
      `${report.ambiguos.total} SKU(s) casam MAIS de um produto (diferem só em caixa/espaços) — por segurança, não serão vinculados.`,
    );
  }
  dicas.push(
    "A prévia é uma estimativa; o relatório final da aplicação é a fonte de verdade.",
  );
  return dicas;
}

export class ImportPreviewUseCase {
  async preview(input: {
    targetUserId: string;
    system: ImportSystem;
    entity: ImportEntity;
    files: ImportFile[];
  }): Promise<PreviewResult> {
    await assertTargetAdmin(input.targetUserId);
    // Resolve o runner ANTES de parsear: entidade indisponível falha rápido.
    const runner = resolveRunner(input.system, input.entity);
    const detected = detectAndValidate(input.system, input.entity, input.files);

    const report = await runner({
      targetUserId: input.targetUserId,
      files: detected,
      dryRun: true,
    });

    return {
      system: input.system,
      entity: input.entity,
      targetUserId: input.targetUserId,
      previewHash: computePreviewHash(input),
      arquivos: detected.map((f) => ({
        campo: f.fieldname,
        nome: f.filename,
        linhas: f.rows.length,
        tipo: f.kind,
      })),
      dicas: buildDicas(report),
      report,
    };
  }
}
