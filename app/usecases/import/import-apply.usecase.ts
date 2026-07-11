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
import { detectAndValidate } from "./import-detector";
import { resolveRunner } from "./import-runners";
import { assertTargetAdmin } from "./import-target";
import { computePreviewHash } from "./lib/preview-hash";
import type { ImportJobStore } from "./import-job.store";
import { SystemLogImportJobStore } from "./import-job.store";

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
    const target = await assertTargetAdmin(input.targetUserId);

    const expected = computePreviewHash(input);
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

    // Valida tudo ANTES de criar o job (falha vira 400 síncrono, não job ERROR).
    const runner = resolveRunner(input.system, input.entity);
    const detected = detectAndValidate(input.system, input.entity, input.files);

    const jobId = await this.store.create({
      targetUserId: input.targetUserId,
      system: input.system,
      entity: input.entity,
      previewHash: input.previewHash,
      progress: { fase: "iniciando", processadas: 0, total: 0 },
      actorUserId: input.actorUserId,
      targetLabel: target.email,
    });

    setImmediate(() => {
      void this.runJob(jobId, input, detected, runner);
    });

    return { jobId };
  }

  private async runJob(
    jobId: string,
    input: { targetUserId: string },
    files: ReturnType<typeof detectAndValidate>,
    runner: ReturnType<typeof resolveRunner>,
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
