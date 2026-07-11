/**
 * Rastreio do job de importação — carrier em `SystemLog.details` (decisão do
 * Felipe: zero migração). Espelha o padrão dos jobs de import de marketplace
 * (payload JSON persistido + worker setImmediate + stale-check de 15min em
 * sync.usercase.ts), trocando o SyncLog (que exige marketplaceAccountId) pelo
 * SystemLog. Bônus: cada importação vira um registro de auditoria na tela de
 * Logs.
 *
 * O status "INTERROMPIDO" nunca é gravado: é derivado na leitura quando um
 * job RUNNING está sem heartbeat há mais de 15min (processo reiniciou no
 * meio). Re-executar é seguro — os executors são idempotentes.
 */

import prisma from "../../lib/prisma";
import type {
  ImportJobDetails,
  ImportJobProgress,
  ImportJobStatus,
  ImportReport,
} from "./import.types";

export const IMPORT_JOB_STALE_MS = 15 * 60 * 1000;
const HEARTBEAT_MIN_INTERVAL_MS = 1500;

export interface ImportJobStore {
  create(
    init: Omit<
      ImportJobDetails,
      "kind" | "status" | "startedAt" | "updatedAt"
    > & { actorUserId?: string; targetLabel?: string },
  ): Promise<string>;
  heartbeat(jobId: string, progress: ImportJobProgress): Promise<void>;
  finish(jobId: string, report: ImportReport): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  get(jobId: string): Promise<ImportJobStatus | null>;
  /** jobId de um job RUNNING (não-stale) para o mesmo alvo, se houver. */
  findRunning(targetUserId: string): Promise<string | null>;
}

function deriveState(details: ImportJobDetails): ImportJobStatus["status"] {
  if (details.status !== "RUNNING") return details.status;
  const updated = Date.parse(details.updatedAt);
  if (Number.isFinite(updated) && Date.now() - updated > IMPORT_JOB_STALE_MS) {
    return "INTERROMPIDO";
  }
  return "RUNNING";
}

export class SystemLogImportJobStore implements ImportJobStore {
  // Cópia local dos details por job: o worker é o único escritor, então o
  // heartbeat não precisa de read-modify-write no banco.
  private local = new Map<string, ImportJobDetails>();
  private lastWrite = new Map<string, number>();

  async create(
    init: Omit<
      ImportJobDetails,
      "kind" | "status" | "startedAt" | "updatedAt"
    > & { actorUserId?: string; targetLabel?: string },
  ): Promise<string> {
    const now = new Date().toISOString();
    const details: ImportJobDetails = {
      kind: "IMPORT_JOB",
      status: "RUNNING",
      targetUserId: init.targetUserId,
      system: init.system,
      entity: init.entity,
      previewHash: init.previewHash,
      progress: init.progress,
      startedAt: now,
      updatedAt: now,
    };
    const log = await prisma.systemLog.create({
      data: {
        userId: init.actorUserId ?? null,
        action: "IMPORT_JOB",
        resource: "ImportJob",
        resourceId: init.targetUserId,
        level: "INFO",
        message: `Importação ${init.entity} (${init.system}) → ${init.targetLabel ?? init.targetUserId}`,
        details: details as unknown as object,
      },
      select: { id: true },
    });
    this.local.set(log.id, details);
    this.lastWrite.set(log.id, Date.now());
    return log.id;
  }

  async heartbeat(jobId: string, progress: ImportJobProgress): Promise<void> {
    const details = this.local.get(jobId);
    if (!details) return;
    details.progress = progress;
    details.updatedAt = new Date().toISOString();
    // Throttle: no máximo 1 write por ~1,5s (o polling do front é de 2s).
    const last = this.lastWrite.get(jobId) ?? 0;
    if (Date.now() - last < HEARTBEAT_MIN_INTERVAL_MS) return;
    this.lastWrite.set(jobId, Date.now());
    await prisma.systemLog.update({
      where: { id: jobId },
      data: { details: details as unknown as object },
    });
  }

  async finish(jobId: string, report: ImportReport): Promise<void> {
    const details = this.local.get(jobId);
    if (!details) return;
    details.status = "DONE";
    details.report = report;
    details.finishedAt = new Date().toISOString();
    details.updatedAt = details.finishedAt;
    await prisma.systemLog.update({
      where: { id: jobId },
      data: { details: details as unknown as object },
    });
    this.local.delete(jobId);
    this.lastWrite.delete(jobId);
  }

  async fail(jobId: string, error: string): Promise<void> {
    const details = this.local.get(jobId);
    if (!details) return;
    details.status = "ERROR";
    details.error = error;
    details.finishedAt = new Date().toISOString();
    details.updatedAt = details.finishedAt;
    await prisma.systemLog.update({
      where: { id: jobId },
      data: { details: details as unknown as object, level: "ERROR" },
    });
    this.local.delete(jobId);
    this.lastWrite.delete(jobId);
  }

  async get(jobId: string): Promise<ImportJobStatus | null> {
    const log = await prisma.systemLog.findUnique({
      where: { id: jobId },
      select: { id: true, action: true, details: true },
    });
    if (!log || log.action !== "IMPORT_JOB" || !log.details) return null;
    const details = log.details as unknown as ImportJobDetails;
    if (details.kind !== "IMPORT_JOB") return null;
    const { kind: _kind, status: _status, ...rest } = details;
    return { jobId: log.id, status: deriveState(details), ...rest };
  }

  async findRunning(targetUserId: string): Promise<string | null> {
    const logs = await prisma.systemLog.findMany({
      where: {
        action: "IMPORT_JOB",
        details: { path: ["targetUserId"], equals: targetUserId },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, details: true },
    });
    for (const log of logs) {
      const details = log.details as unknown as ImportJobDetails | null;
      if (!details || details.kind !== "IMPORT_JOB") continue;
      if (deriveState(details) === "RUNNING") return log.id;
    }
    return null;
  }
}

/** Store em memória — usado nos testes (sem banco). */
export class InMemoryImportJobStore implements ImportJobStore {
  private jobs = new Map<string, ImportJobDetails>();
  private seq = 0;

  async create(
    init: Omit<
      ImportJobDetails,
      "kind" | "status" | "startedAt" | "updatedAt"
    > & { actorUserId?: string; targetLabel?: string },
  ): Promise<string> {
    const now = new Date().toISOString();
    const id = `job-${++this.seq}`;
    this.jobs.set(id, {
      kind: "IMPORT_JOB",
      status: "RUNNING",
      targetUserId: init.targetUserId,
      system: init.system,
      entity: init.entity,
      previewHash: init.previewHash,
      progress: init.progress,
      startedAt: now,
      updatedAt: now,
    });
    return id;
  }

  async heartbeat(jobId: string, progress: ImportJobProgress): Promise<void> {
    const d = this.jobs.get(jobId);
    if (!d) return;
    d.progress = progress;
    d.updatedAt = new Date().toISOString();
  }

  async finish(jobId: string, report: ImportReport): Promise<void> {
    const d = this.jobs.get(jobId);
    if (!d) return;
    d.status = "DONE";
    d.report = report;
    d.finishedAt = new Date().toISOString();
    d.updatedAt = d.finishedAt;
  }

  async fail(jobId: string, error: string): Promise<void> {
    const d = this.jobs.get(jobId);
    if (!d) return;
    d.status = "ERROR";
    d.error = error;
    d.finishedAt = new Date().toISOString();
    d.updatedAt = d.finishedAt;
  }

  async get(jobId: string): Promise<ImportJobStatus | null> {
    const d = this.jobs.get(jobId);
    if (!d) return null;
    const { kind: _kind, status: _status, ...rest } = d;
    return { jobId, status: deriveState(d), ...rest };
  }

  async findRunning(targetUserId: string): Promise<string | null> {
    for (const [id, d] of this.jobs) {
      if (d.targetUserId === targetUserId && deriveState(d) === "RUNNING") {
        return id;
      }
    }
    return null;
  }
}
