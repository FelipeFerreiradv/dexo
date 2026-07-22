/**
 * APLICAÇÃO da importação — confere o `previewHash` (arquivo byte-idêntico,
 * mesmo alvo/entidade e mesma versão do motor), garante 1 job por alvo e
 * dispara o worker via `setImmediate` (mesmo padrão dos imports de
 * marketplace em sync.usercase.ts). O estado do job vive em
 * SystemLog.details; o front acompanha por polling no GET /status/:jobId.
 */

import type {
  ImportEntity,
  ImportFile,
  ImportSystem,
} from "./import.types";
import { ImportConflictError } from "./import.types";
import { resolveRunner } from "./import-runners";
import { resolveEffectiveSelection } from "./import-selection";
import { assertTargetAdmin } from "./import-target";
import { computePreviewHash } from "./lib/preview-hash";
import type { ImportJobStore } from "./import-job.store";
import { SystemLogImportJobStore } from "./import-job.store";

// Trava EM PROCESSO por admin-alvo: o findRunning (persistido) sozinho é
// check-then-act — dois POST /apply quase simultâneos passariam ambos pela
// checagem antes do primeiro create. A API roda num único processo Node,
// então este Set fecha a janela de corrida de verdade; o findRunning segue
// cobrindo jobs que sobreviveram a um restart.
const applyingTargets = new Set<string>();

export class ImportApplyUseCase {
  constructor(
    private readonly store: ImportJobStore = new SystemLogImportJobStore(),
  ) {}

  async apply(input: {
    targetUserId: string;
    system: ImportSystem;
    entity: ImportEntity;
    files: ImportFile[];
    previewHash: string;
    /** Superadmin que disparou (vai para a auditoria no SystemLog). */
    actorUserId?: string;
  }): Promise<{ jobId: string }> {
    if (applyingTargets.has(input.targetUserId)) {
      throw new ImportConflictError(
        "Já existe uma importação em andamento para este administrador. Aguarde terminar.",
      );
    }
    applyingTargets.add(input.targetUserId);
    let jobStarted = false;
    try {
      const target = await assertTargetAdmin(input.targetUserId);

      // Resolve o (sistema, entidade) EFETIVO pelos arquivos (mesma lógica da
      // prévia) ANTES do hash — a auto-detecção pode ter ajustado o sistema na
      // prévia, então o hash tem de ser calculado sobre o par efetivo, senão
      // daria 409. Também valida a coerência (falha vira 400 síncrono, não job
      // ERROR); arquivos extras são ignorados, só os aceitos vão ao runner.
      const {
        system,
        entity,
        files: detected,
        ignored,
      } = resolveEffectiveSelection(input.system, input.entity, input.files);

      const expected = computePreviewHash({
        targetUserId: input.targetUserId,
        system,
        entity,
        files: input.files,
      });
      if (!input.previewHash || input.previewHash !== expected) {
        throw new ImportConflictError(
          "Prévia desatualizada (arquivo, alvo ou versão do motor mudaram). Gere uma nova prévia antes de aplicar.",
        );
      }

      const running = await this.store.findRunning(input.targetUserId);
      if (running) {
        throw new ImportConflictError(
          "Já existe uma importação em andamento para este administrador. Aguarde terminar.",
        );
      }

      const runner = resolveRunner(system, entity);

      const jobId = await this.store.create({
        targetUserId: input.targetUserId,
        system,
        entity,
        previewHash: input.previewHash,
        progress: { fase: "iniciando", processadas: 0, total: 0 },
        actorUserId: input.actorUserId,
        targetLabel: target.email,
      });

      jobStarted = true;
      setImmediate(() => {
        void this.runJob(jobId, input, detected, runner, ignored).finally(() => {
          applyingTargets.delete(input.targetUserId);
        });
      });

      return { jobId };
    } finally {
      // Falhou antes do job nascer ⇒ libera a trava já; com job rodando, a
      // liberação fica com o finally do worker.
      if (!jobStarted) applyingTargets.delete(input.targetUserId);
    }
  }

  private async runJob(
    jobId: string,
    input: { targetUserId: string },
    files: ReturnType<typeof resolveEffectiveSelection>["files"],
    runner: ReturnType<typeof resolveRunner>,
    ignored: ReturnType<typeof resolveEffectiveSelection>["ignored"],
  ): Promise<void> {
    try {
      const report = await runner({
        targetUserId: input.targetUserId,
        files,
        dryRun: false,
        onProgress: (p) => {
          // Fire-and-forget: o heartbeat é throttled e nunca derruba o job.
          void this.store.heartbeat(jobId, p).catch(() => undefined);
        },
      });
      // O apply roda assíncrono e o operador só vê o relatório final — sem
      // isto, um arquivo que o motor descartou some sem deixar rastro.
      if (ignored.length > 0) {
        report.ignorados = ignored.map((i) => ({
          arquivo: i.filename,
          motivo: i.motivo,
        }));
      }
      await this.store.finish(jobId, report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.store
        .fail(jobId, msg)
        .catch((e) =>
          console.error("[import] falha ao gravar erro do job", jobId, e),
        );
    }
  }
}
