import { describe, expect, it, vi } from "vitest";
import { LocationUseCase } from "@/app/usecases/location.usercase";

// O construtor de LocationUseCase instancia o repositório internamente; nos
// testes sobrescrevemos o campo privado com um stub de `findAllFlat` (o loader
// achatado que passa a alimentar `listForSelect`). Só os campos que
// listForSelect lê importam nas linhas abaixo.
function makeUseCase(rows: any[]) {
  const useCase = new LocationUseCase();
  (useCase as any).locationRepository = {
    findAllFlat: vi.fn(async (_userId: string) => rows),
  };
  return useCase;
}

describe("LocationUseCase.listForSelect", () => {
  it("monta o caminho completo em qualquer profundidade (folha profunda)", async () => {
    // Hierarquia de 4 níveis: Barracão 1 > R1 > T1 > A2
    const rows = [
      { id: "root", code: "Barracão 1", parentId: undefined, maxCapacity: 0, productsCount: 0 },
      { id: "r1", code: "R1", parentId: "root", maxCapacity: 0, productsCount: 0 },
      { id: "t1", code: "T1", parentId: "r1", maxCapacity: 0, productsCount: 0 },
      { id: "a2", code: "A2", parentId: "t1", maxCapacity: 0, productsCount: 0 },
    ];
    const result = await makeUseCase(rows).listForSelect("u1");
    const byId = new Map(result.map((r) => [r.id, r]));

    expect(byId.get("a2")!.fullPath).toBe("Barracão 1 > R1 > T1 > A2");
    expect(byId.get("t1")!.fullPath).toBe("Barracão 1 > R1 > T1");
    expect(byId.get("r1")!.fullPath).toBe("Barracão 1 > R1");
    expect(byId.get("root")!.fullPath).toBe("Barracão 1");
    // Todos os nós aparecem como opção, inclusive as folhas profundas.
    expect(result).toHaveLength(4);
  });

  it("preserva productsCount/isFull e ordena por fullPath", async () => {
    const rows = [
      { id: "b", code: "B", parentId: undefined, maxCapacity: 2, productsCount: 2 }, // lotado
      { id: "a", code: "A", parentId: undefined, maxCapacity: 5, productsCount: 1 },
      { id: "c", code: "C", parentId: undefined, maxCapacity: 0, productsCount: 3 }, // sem capacidade
    ];
    const result = await makeUseCase(rows).listForSelect("u1");

    // Ordenado por fullPath.
    expect(result.map((r) => r.fullPath)).toEqual(["A", "B", "C"]);

    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get("b")!.isFull).toBe(true);
    expect(byId.get("a")!.isFull).toBe(false);
    // maxCapacity 0 nunca é considerado lotado (paridade com o comportamento atual).
    expect(byId.get("c")!.isFull).toBe(false);
    expect(byId.get("c")!.productsCount).toBe(3);
  });

  it("não trava nem estoura a pilha em ciclo de parentId (guard)", async () => {
    // Dados corrompidos: a -> b -> a.
    const rows = [
      { id: "a", code: "A", parentId: "b", maxCapacity: 0, productsCount: 0 },
      { id: "b", code: "B", parentId: "a", maxCapacity: 0, productsCount: 0 },
    ];
    const result = await makeUseCase(rows).listForSelect("u1");

    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.fullPath.length).toBeGreaterThan(0);
      // O guard limita a subida a no máximo 50 segmentos.
      expect(r.fullPath.split(" > ").length).toBeLessThanOrEqual(50);
    }
  });

  it("retorna lista vazia quando o usuário não tem localizações", async () => {
    const result = await makeUseCase([]).listForSelect("u1");
    expect(result).toEqual([]);
  });
});
