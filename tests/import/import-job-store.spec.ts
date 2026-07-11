import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    systemLog: {
      create: vi.fn(async () => ({ id: "log-1" })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    location: { findMany: vi.fn(async () => []) },
    user: { findUnique: vi.fn(async () => null) },
  },
}));

import prisma from "../../app/lib/prisma";

type AnyMock = ReturnType<typeof vi.fn>;
const prismaMock = prisma as unknown as {
  systemLog: {
    create: AnyMock;
    update: AnyMock;
    findUnique: AnyMock;
    findMany: AnyMock;
  };
};

import {
  SystemLogImportJobStore,
  InMemoryImportJobStore,
  IMPORT_JOB_STALE_MS,
} from "../../app/usecases/import/import-job.store";
import type { ImportReport } from "../../app/usecases/import/import.types";

const baseInit = {
  targetUserId: "admin-1",
  system: "VAAPT" as const,
  entity: "LOCALIZACOES" as const,
  previewHash: "hash",
  progress: { fase: "iniciando", processadas: 0, total: 0 },
};

const fakeReport: ImportReport = {
  system: "VAAPT",
  entity: "LOCALIZACOES",
  targetUserId: "admin-1",
  dryRun: false,
  contadores: { criadas: 2 },
  erros: [],
  avisos: [],
  amostra: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("import/job-store — SystemLog carrier", () => {
  it("create grava SystemLog action=IMPORT_JOB com details RUNNING", async () => {
    const store = new SystemLogImportJobStore();
    const jobId = await store.create({ ...baseInit, actorUserId: "super-1" });
    expect(jobId).toBe("log-1");
    const arg = prismaMock.systemLog.create.mock.calls[0][0] as {
      data: { action: string; details: { status: string; kind: string } };
    };
    expect(arg.data.action).toBe("IMPORT_JOB");
    expect(arg.data.details.kind).toBe("IMPORT_JOB");
    expect(arg.data.details.status).toBe("RUNNING");
  });

  it("finish persiste DONE + report; fail persiste ERROR + level ERROR", async () => {
    const store = new SystemLogImportJobStore();
    const jobId = await store.create(baseInit);
    await store.finish(jobId, fakeReport);
    const upd = prismaMock.systemLog.update.mock.calls.at(-1)?.[0] as {
      data: { details: { status: string; report?: unknown } };
    };
    expect(upd.data.details.status).toBe("DONE");
    expect(upd.data.details.report).toBeTruthy();

    const jobId2 = await store.create(baseInit);
    await store.fail(jobId2, "explodiu");
    const upd2 = prismaMock.systemLog.update.mock.calls.at(-1)?.[0] as {
      data: { details: { status: string; error?: string }; level?: string };
    };
    expect(upd2.data.details.status).toBe("ERROR");
    expect(upd2.data.details.error).toBe("explodiu");
    expect(upd2.data.level).toBe("ERROR");
  });

  it("heartbeat é throttled (2 chamadas imediatas = 1 write)", async () => {
    const store = new SystemLogImportJobStore();
    const jobId = await store.create(baseInit);
    const before = prismaMock.systemLog.update.mock.calls.length;
    await store.heartbeat(jobId, { fase: "x", processadas: 1, total: 10 });
    await store.heartbeat(jobId, { fase: "x", processadas: 2, total: 10 });
    // O create marca lastWrite → nenhum write nos ~1,5s seguintes.
    expect(prismaMock.systemLog.update.mock.calls.length).toBe(before);
  });

  it("get deriva INTERROMPIDO quando RUNNING está sem heartbeat >15min", async () => {
    const stale = new Date(Date.now() - IMPORT_JOB_STALE_MS - 1000).toISOString();
    prismaMock.systemLog.findUnique.mockResolvedValueOnce({
      id: "log-9",
      action: "IMPORT_JOB",
      details: {
        kind: "IMPORT_JOB",
        status: "RUNNING",
        targetUserId: "admin-1",
        system: "VAAPT",
        entity: "LOCALIZACOES",
        previewHash: "h",
        progress: { fase: "x", processadas: 5, total: 10 },
        startedAt: stale,
        updatedAt: stale,
      },
    } as never);
    const store = new SystemLogImportJobStore();
    const status = await store.get("log-9");
    expect(status?.status).toBe("INTERROMPIDO");
  });

  it("get ignora logs que não são IMPORT_JOB", async () => {
    prismaMock.systemLog.findUnique.mockResolvedValueOnce({
      id: "log-8",
      action: "LOGIN",
      details: { foo: 1 },
    } as never);
    const store = new SystemLogImportJobStore();
    expect(await store.get("log-8")).toBeNull();
  });
});

describe("import/job-store — InMemory (testes/fallback)", () => {
  it("ciclo completo create → heartbeat → finish", async () => {
    const store = new InMemoryImportJobStore();
    const jobId = await store.create(baseInit);
    await store.heartbeat(jobId, { fase: "x", processadas: 3, total: 9 });
    let s = await store.get(jobId);
    expect(s?.status).toBe("RUNNING");
    expect(s?.progress.processadas).toBe(3);
    expect(await store.findRunning("admin-1")).toBe(jobId);

    await store.finish(jobId, fakeReport);
    s = await store.get(jobId);
    expect(s?.status).toBe("DONE");
    expect(await store.findRunning("admin-1")).toBeNull();
  });
});
