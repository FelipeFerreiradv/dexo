import { describe, it, expect, vi, beforeEach } from "vitest";
import { NfeSequenceService } from "../../app/fiscal/sequence/nfe-sequence.service";

// ── Mock do Prisma ──
// O service usa prisma.$transaction com raw queries para atomicidade.
// Nos testes unitários mockamos o prisma para validar a lógica sem banco.

let mockRows: { id: string; proximoNumero: number }[] = [];
let updateCalls: any[] = [];
let insertCalls: any[] = [];

const mockTx = {
  $queryRawUnsafe: vi.fn(async (sql: string, ...params: any[]) => {
    if (sql.includes("SELECT")) {
      return [...mockRows];
    }
    if (sql.includes("UPDATE")) {
      updateCalls.push(params);
      return { count: 1 };
    }
    if (sql.includes("INSERT")) {
      insertCalls.push(params);
      return { count: 1 };
    }
    return [];
  }),
};

vi.mock("../../app/lib/prisma", () => ({
  default: {
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      return fn(mockTx);
    }),
    nfeSequence: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: any) => args.create || args.update),
    },
  },
}));

describe("NfeSequenceService", () => {
  let service: NfeSequenceService;

  beforeEach(() => {
    service = new NfeSequenceService();
    mockRows = [];
    updateCalls = [];
    insertCalls = [];
    vi.clearAllMocks();
  });

  describe("reservarProximoNumero", () => {
    it("retorna 1 para primeira emissão (registro não existe)", async () => {
      // SELECT retorna vazio → INSERT → SELECT retry retorna vazio novamente
      // Quando não há registro, o service insere com proximoNumero=2 e retorna 1
      mockRows = [];

      const numero = await service.reservarProximoNumero(
        "user-1",
        "HOMOLOGACAO",
        1,
      );

      expect(numero).toBe(1);
    });

    it("retorna número existente e incrementa", async () => {
      mockRows = [{ id: "seq-1", proximoNumero: 42 }];

      const numero = await service.reservarProximoNumero(
        "user-1",
        "HOMOLOGACAO",
        1,
      );

      expect(numero).toBe(42);
      // Deve ter atualizado para 43
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
      expect(updateCalls[0][0]).toBe(43);
    });

    it("rejeita userId vazio", async () => {
      await expect(
        service.reservarProximoNumero("", "HOMOLOGACAO", 1),
      ).rejects.toThrow("userId é obrigatório");
    });

    it("rejeita série negativa", async () => {
      await expect(
        service.reservarProximoNumero("user-1", "HOMOLOGACAO", -1),
      ).rejects.toThrow("Série deve ser um inteiro não-negativo");
    });

    it("rejeita série decimal", async () => {
      await expect(
        service.reservarProximoNumero("user-1", "HOMOLOGACAO", 1.5),
      ).rejects.toThrow("Série deve ser um inteiro não-negativo");
    });

    it("aceita série 0", async () => {
      mockRows = [{ id: "seq-0", proximoNumero: 1 }];

      const numero = await service.reservarProximoNumero(
        "user-1",
        "HOMOLOGACAO",
        0,
      );

      expect(numero).toBe(1);
    });

    it("usa SELECT FOR UPDATE (raw query com FOR UPDATE)", async () => {
      mockRows = [{ id: "seq-1", proximoNumero: 10 }];

      await service.reservarProximoNumero("user-1", "PRODUCAO", 1);

      const selectCall = mockTx.$queryRawUnsafe.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("FOR UPDATE"),
      );
      expect(selectCall).toBeDefined();
    });

    it("incrementa sequencialmente em chamadas consecutivas", async () => {
      // Simula 3 chamadas consecutivas
      let currentNum = 10;
      mockTx.$queryRawUnsafe.mockImplementation(
        async (sql: string, ...params: any[]) => {
          if (sql.includes("SELECT")) {
            return [{ id: "seq-1", proximoNumero: currentNum }];
          }
          if (sql.includes("UPDATE")) {
            currentNum = params[0];
            return { count: 1 };
          }
          return [];
        },
      );

      const n1 = await service.reservarProximoNumero(
        "user-1",
        "HOMOLOGACAO",
        1,
      );
      const n2 = await service.reservarProximoNumero(
        "user-1",
        "HOMOLOGACAO",
        1,
      );
      const n3 = await service.reservarProximoNumero(
        "user-1",
        "HOMOLOGACAO",
        1,
      );

      expect(n1).toBe(10);
      expect(n2).toBe(11);
      expect(n3).toBe(12);
    });

    it("isolamento por ambiente: HOMOLOGACAO e PRODUCAO são independentes", async () => {
      const calls: string[] = [];
      mockTx.$queryRawUnsafe.mockImplementation(
        async (sql: string, ...params: any[]) => {
          if (sql.includes("SELECT")) {
            calls.push(params[1]); // ambiente é $2 → params[1]
            return [{ id: "seq-1", proximoNumero: 5 }];
          }
          if (sql.includes("UPDATE")) return { count: 1 };
          return [];
        },
      );

      await service.reservarProximoNumero("user-1", "HOMOLOGACAO", 1);
      await service.reservarProximoNumero("user-1", "PRODUCAO", 1);

      expect(calls).toContain("HOMOLOGACAO");
      expect(calls).toContain("PRODUCAO");
    });
  });

  describe("consultarProximoNumero", () => {
    it("retorna 1 quando registro não existe", async () => {
      const numero = await service.consultarProximoNumero(
        "user-novo",
        "HOMOLOGACAO",
        1,
      );
      expect(numero).toBe(1);
    });
  });

  describe("ajustarProximoNumero", () => {
    it("rejeita número menor ou igual ao atual", async () => {
      // consultarProximoNumero retorna 1 (default, sem registro)
      await expect(
        service.ajustarProximoNumero("user-1", "HOMOLOGACAO", 1, 1),
      ).rejects.toThrow("deve ser maior");
    });

    it("rejeita número zero", async () => {
      await expect(
        service.ajustarProximoNumero("user-1", "HOMOLOGACAO", 1, 0),
      ).rejects.toThrow("inteiro positivo");
    });

    it("rejeita número negativo", async () => {
      await expect(
        service.ajustarProximoNumero("user-1", "HOMOLOGACAO", 1, -5),
      ).rejects.toThrow("inteiro positivo");
    });

    it("rejeita número decimal", async () => {
      await expect(
        service.ajustarProximoNumero("user-1", "HOMOLOGACAO", 1, 5.5),
      ).rejects.toThrow("inteiro positivo");
    });
  });
});
