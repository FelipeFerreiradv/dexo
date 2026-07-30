import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Guard pré-claim do PR 5: o worker consulta os BREAKERS antes de fazer claim
// — com falha de infra certa em todos os elos, claim só queimaria uma
// tentativa do backoff. Mesmo molde de mocks do image-bg-worker.spec.ts.
const jobFindFirst = vi.fn();
const jobUpdateMany = vi.fn();
const jobUpdate = vi.fn();
const jobFindMany = vi.fn();
vi.mock("../app/lib/prisma", () => ({
  default: {
    imageBgJob: {
      findFirst: (...a: any[]) => jobFindFirst(...a),
      updateMany: (...a: any[]) => jobUpdateMany(...a),
      update: (...a: any[]) => jobUpdate(...a),
      findMany: (...a: any[]) => jobFindMany(...a),
    },
  },
}));
vi.mock("fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("../app/marketplaces/services/image-resize.service", () => ({
  processUploadedImage: vi.fn(),
}));
vi.mock("../app/marketplaces/services/rembg-telemetry", () => ({
  recordImageOutcome: vi.fn(),
  recordImageSentExternal: vi.fn(),
}));
vi.mock("../app/marketplaces/services/image-bg-swap", () => ({
  swapImageUrlReferences: vi.fn(),
}));
vi.mock("../app/services/system-log.service", () => ({
  SystemLogService: { logError: vi.fn() },
}));

import { ImageBgWorkerService } from "../app/marketplaces/services/image-bg-worker.service";
import {
  __resetRembgBreakers,
  externalRembgBreaker,
  localRembgBreaker,
} from "../app/marketplaces/services/rembg-breaker";

function openBreaker(breaker: typeof localRembgBreaker) {
  for (let i = 0; i < 5; i++) {
    breaker.beginAttempt();
    breaker.recordFailure("infra");
  }
}

function primeEmptyMaintenance() {
  jobUpdateMany.mockResolvedValueOnce({ count: 0 }); // reclaim de lease
  jobFindMany.mockResolvedValueOnce([]); // sweeps
}

const FALLBACK_ENVS = [
  "REMBG_FALLBACK_API_URL",
  "REMBG_FALLBACK_MAX_PER_DAY",
  "REMBG_SIDECAR_URL",
  "REMBG_ENABLED",
];

describe("ImageBgWorkerService — guard de breakers antes do claim (PR 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRembgBreakers();
    process.env.UPLOAD_ASYNC_REMBG = "1";
    for (const k of FALLBACK_ENVS) delete process.env[k];
    jobFindFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.UPLOAD_ASYNC_REMBG;
    for (const k of FALLBACK_ENVS) delete process.env[k];
  });

  it("sidecar configurado + breaker local ABERTO + sem externo: NÃO faz claim (manutenção segue rodando)", async () => {
    process.env.REMBG_SIDECAR_URL = "http://sidecar.test:8000";
    openBreaker(localRembgBreaker);
    primeEmptyMaintenance();

    await ImageBgWorkerService.runOnce();

    expect(jobUpdateMany).toHaveBeenCalledTimes(1); // reclaim rodou
    expect(jobFindMany).toHaveBeenCalledTimes(1); // sweeps rodaram
    expect(jobFindFirst).not.toHaveBeenCalled(); // claim SEGURADO
  });

  it("nada configurado e breakers fechados: claim procede (comportamento do PR 4 preservado)", async () => {
    primeEmptyMaintenance();
    await ImageBgWorkerService.runOnce();
    expect(jobFindFirst).toHaveBeenCalledTimes(1);
  });

  it("local aberto MAS externo configurado e saudável: claim procede (a cadeia pode servir)", async () => {
    process.env.REMBG_SIDECAR_URL = "http://sidecar.test:8000";
    process.env.REMBG_FALLBACK_API_URL = "https://sdk.photoroom.com/v1/segment";
    process.env.REMBG_FALLBACK_MAX_PER_DAY = "50";
    openBreaker(localRembgBreaker);
    primeEmptyMaintenance();

    await ImageBgWorkerService.runOnce();
    expect(jobFindFirst).toHaveBeenCalledTimes(1);
  });

  it("local aberto E externo aberto: segura o claim", async () => {
    process.env.REMBG_SIDECAR_URL = "http://sidecar.test:8000";
    process.env.REMBG_FALLBACK_API_URL = "https://sdk.photoroom.com/v1/segment";
    process.env.REMBG_FALLBACK_MAX_PER_DAY = "50";
    openBreaker(localRembgBreaker);
    openBreaker(externalRembgBreaker);
    primeEmptyMaintenance();

    await ImageBgWorkerService.runOnce();
    expect(jobFindFirst).not.toHaveBeenCalled();
  });
});
