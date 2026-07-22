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
import { resolveRunner } from "./import-runners";
import { resolveEffectiveSelection, SYSTEM_LABELS } from "./import-selection";
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
    // Resolve o (sistema, entidade) EFETIVO: honra a seleção do operador
    // quando bate com os arquivos; se não bater, deduz o sistema pelos
    // próprios arquivos (resgata o "escolhi o sistema errado").
    const {
      system,
      entity,
      files: detected,
      ignored,
      autoDetected,
    } = resolveEffectiveSelection(input.system, input.entity, input.files);
    const runner = resolveRunner(system, entity);

    const report = await runner({
      targetUserId: input.targetUserId,
      files: detected,
      dryRun: true,
    });

    // Também no relatório (e não só nas dicas): é o objeto que o operador
    // copia/guarda, e o apply mostra apenas ele.
    if (ignored.length > 0) {
      report.ignorados = ignored.map((i) => ({
        arquivo: i.filename,
        motivo: i.motivo,
      }));
    }

    const dicas = buildDicas(report);
    if (ignored.length > 0) {
      dicas.unshift(
        `${ignored.length} arquivo(s) foram ignorados (não pertencem a esta importação): ${ignored
          .map((i) => `${i.filename} — ${i.motivo}`)
          .join("; ")}.`,
      );
    }
    if (autoDetected) {
      dicas.unshift(
        `Detectei que os arquivos são do sistema “${SYSTEM_LABELS[system]}” — ajustei a importação automaticamente. Confira a prévia abaixo antes de aplicar.`,
      );
    }

    return {
      // Devolve o EFETIVO (o hash e o apply usam este par); assim o front
      // reflete o sistema realmente usado, mesmo se o operador errou o seletor.
      system,
      entity,
      targetUserId: input.targetUserId,
      previewHash: computePreviewHash({
        targetUserId: input.targetUserId,
        system,
        entity,
        files: input.files,
      }),
      arquivos: detected.map((f) => ({
        campo: f.fieldname,
        nome: f.filename,
        linhas: f.rows.length,
        tipo: f.kind,
      })),
      dicas,
      report,
    };
  }
}
