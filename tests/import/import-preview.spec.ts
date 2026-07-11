import { describe, it, expect, vi, beforeEach } from "vitest";
import XLSX from "xlsx";

// GUARDRAIL central: a PRÉVIA nunca escreve. O prisma mockado só tem os
// métodos de LEITURA usados pelos preloads + spies de escrita que DEVEM
// permanecer intocados na prévia.
vi.mock("../../app/lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(async () => ({
        id: "admin-1",
        email: "cliente@x.com",
        name: "Cliente",
        role: "ADMIN",
        parentUserId: null,
      })),
    },
    location: {
      findMany: vi.fn(async () => [{ id: "l1", code: "LOCAL1" }]),
      findFirst: vi.fn(async () => null), // findByCode do usecase → miss
      // No APPLY, o LocationUseCase real chama repo.create →
      // prisma.location.create; devolve um registro plausível para o
      // mapPrismaToLocation do repositório.
      create: vi.fn(async (args: { data: { code: string } }) => ({
        id: "new-1",
        userId: "admin-1",
        code: args.data.code,
        description: null,
        maxCapacity: 0,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { products: 0, children: 0 },
      })),
      update: vi.fn(),
    },
    product: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    systemLog: {
      create: vi.fn(async () => ({ id: "log-1" })),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
    },
  },
}));

import prisma from "../../app/lib/prisma";

type AnyMock = ReturnType<typeof vi.fn>;
const prismaMock = prisma as unknown as {
  user: { findUnique: AnyMock };
  location: {
    findMany: AnyMock;
    findFirst: AnyMock;
    create: AnyMock;
    update: AnyMock;
  };
  product: { update: AnyMock; updateMany: AnyMock };
  systemLog: {
    create: AnyMock;
    update: AnyMock;
    findUnique: AnyMock;
    findMany: AnyMock;
  };
};
const writeSpies = {
  locationCreate: prismaMock.location.create,
  locationUpdate: prismaMock.location.update,
  productUpdate: prismaMock.product.update,
  productUpdateMany: prismaMock.product.updateMany,
};

import { ImportPreviewUseCase } from "../../app/usecases/import/import-preview.usecase";
import { ImportApplyUseCase } from "../../app/usecases/import/import-apply.usecase";
import { InMemoryImportJobStore } from "../../app/usecases/import/import-job.store";
import {
  ImportConflictError,
  ImportValidationError,
} from "../../app/usecases/import/import.types";
import {
  computePreviewHash,
  MAPPER_VERSION,
} from "../../app/usecases/import/lib/preview-hash";

function pecasXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["# Cod Peca", "Localizacao"],
      ["1", "LOCAL 1"], // já existe (preload devolve LOCAL1)
      ["2", "Local 44 - Caixa 9"], // nova
    ]),
    "Planilha1",
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { fieldname: "file", filename: "pecas.xlsx", buffer };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("import/preview — dry-run obrigatório", () => {
  it("gera contadores + previewHash e NÃO escreve nada", async () => {
    const usecase = new ImportPreviewUseCase();
    const result = await usecase.preview({
      targetUserId: "admin-1",
      system: "VAAPT",
      entity: "LOCALIZACOES",
      files: [pecasXlsx()],
    });

    expect(result.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.report.dryRun).toBe(true);
    expect(result.report.contadores.a_criar).toBe(1);
    expect(result.report.contadores.ja_existiam).toBe(1);
    expect(result.arquivos[0].tipo).toBe("VAAPT_PECAS");

    // ZERO escritas na prévia.
    for (const spy of Object.values(writeSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(prismaMock.systemLog.create).not.toHaveBeenCalled();
  });

  it("alvo colaborador/superadmin é recusado", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: "colab-1",
      email: "c@x.com",
      name: "Colab",
      role: "USER",
      parentUserId: "admin-1",
    } as never);
    const usecase = new ImportPreviewUseCase();
    await expect(
      usecase.preview({
        targetUserId: "colab-1",
        system: "VAAPT",
        entity: "LOCALIZACOES",
        files: [pecasXlsx()],
      }),
    ).rejects.toThrow(ImportValidationError);
  });

  it("entidade ainda não habilitada → erro claro", async () => {
    const usecase = new ImportPreviewUseCase();
    await expect(
      usecase.preview({
        targetUserId: "admin-1",
        system: "DEXO",
        entity: "CONTAS",
        files: [pecasXlsx()],
      }),
    ).rejects.toThrow(/não está disponível/i);
  });
});

describe("import/preview-hash — liga prévia→apply", () => {
  const base = {
    targetUserId: "admin-1",
    system: "VAAPT" as const,
    entity: "LOCALIZACOES" as const,
    files: [pecasXlsx()],
  };

  it("é estável para a mesma entrada", () => {
    expect(computePreviewHash(base)).toBe(computePreviewHash({ ...base }));
  });

  it("muda com bytes, alvo e entidade", () => {
    const h = computePreviewHash(base);
    expect(
      computePreviewHash({ ...base, targetUserId: "outro-admin" }),
    ).not.toBe(h);
    expect(computePreviewHash({ ...base, entity: "VINCULOS" })).not.toBe(h);
    const otherFile = {
      ...base.files[0],
      buffer: Buffer.concat([base.files[0].buffer, Buffer.from("x")]),
    };
    expect(computePreviewHash({ ...base, files: [otherFile] })).not.toBe(h);
  });

  it("MAPPER_VERSION participa do hash (prévia pré-deploy invalida)", () => {
    // Sanidade: a constante existe e é inteiro ≥1 — se mudar, hashes antigos
    // param de casar (comportamento desejado).
    expect(Number.isInteger(MAPPER_VERSION)).toBe(true);
    expect(MAPPER_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("import/apply — guardas", () => {
  it("hash divergente → ImportConflictError (409)", async () => {
    const usecase = new ImportApplyUseCase(new InMemoryImportJobStore());
    await expect(
      usecase.apply({
        targetUserId: "admin-1",
        system: "VAAPT",
        entity: "LOCALIZACOES",
        files: [pecasXlsx()],
        previewHash: "hash-errado",
      }),
    ).rejects.toThrow(ImportConflictError);
  });

  it("job RUNNING para o mesmo alvo → 409", async () => {
    const store = new InMemoryImportJobStore();
    await store.create({
      targetUserId: "admin-1",
      system: "VAAPT",
      entity: "LOCALIZACOES",
      previewHash: "h",
      progress: { fase: "x", processadas: 0, total: 0 },
    });
    const usecase = new ImportApplyUseCase(store);
    const files = [pecasXlsx()];
    const previewHash = computePreviewHash({
      targetUserId: "admin-1",
      system: "VAAPT",
      entity: "LOCALIZACOES",
      files,
    });
    await expect(
      usecase.apply({
        targetUserId: "admin-1",
        system: "VAAPT",
        entity: "LOCALIZACOES",
        files,
        previewHash,
      }),
    ).rejects.toThrow(/em andamento/i);
  });

  it("apply válido cria job e executa via worker (create chamado)", async () => {
    const store = new InMemoryImportJobStore();
    const usecase = new ImportApplyUseCase(store);
    const files = [pecasXlsx()];
    const previewHash = computePreviewHash({
      targetUserId: "admin-1",
      system: "VAAPT",
      entity: "LOCALIZACOES",
      files,
    });
    const { jobId } = await usecase.apply({
      targetUserId: "admin-1",
      system: "VAAPT",
      entity: "LOCALIZACOES",
      files,
      previewHash,
    });
    expect(jobId).toBeTruthy();

    // Espera o worker setImmediate terminar.
    await new Promise((r) => setTimeout(r, 50));
    const status = await store.get(jobId);
    expect(status?.status).toBe("DONE");
    expect(status?.report?.contadores.criadas).toBe(1); // LOCAL44-CAIXA9
    expect(status?.report?.contadores.ja_existiam).toBe(1); // LOCAL1
    // Apply de verdade ESCREVE via usecase → prisma.location.create.
    expect(writeSpies.locationCreate).toHaveBeenCalledTimes(1);
  });
});
