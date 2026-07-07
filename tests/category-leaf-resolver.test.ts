import { describe, expect, it, vi } from "vitest";
import {
  mlModeToLeafCuid,
  shopeeModeToLeafId,
} from "@/app/marketplaces/lib/category-leaf-resolver";

describe("mlModeToLeafCuid", () => {
  it("desce um nó-pai até a folha e devolve o cuid da folha", async () => {
    const deps = {
      findById: vi.fn(async (cuid: string) =>
        cuid === "cuid-parent" ? { externalId: "MLB190973" } : null,
      ),
      ensureLeaf: vi.fn(async (ext: string) =>
        ext === "MLB190973" ? { externalId: "MLB1000" } : { externalId: ext },
      ),
      findByExternalId: vi.fn(async (ext: string) =>
        ext === "MLB1000" ? { id: "cuid-leaf" } : null,
      ),
    };
    expect(await mlModeToLeafCuid("cuid-parent", deps)).toBe("cuid-leaf");
    expect(deps.ensureLeaf).toHaveBeenCalledWith("MLB190973");
  });

  it("mantém o cuid quando já é folha (ensureLeaf devolve o mesmo externalId)", async () => {
    const deps = {
      findById: vi.fn(async () => ({ externalId: "MLB1000" })),
      ensureLeaf: vi.fn(async (ext: string) => ({ externalId: ext })),
      findByExternalId: vi.fn(async () => ({ id: "nao-usar" })),
    };
    expect(await mlModeToLeafCuid("cuid-leaf", deps)).toBe("cuid-leaf");
    // Já-folha não deve reconverter via externalId.
    expect(deps.findByExternalId).not.toHaveBeenCalled();
  });

  it("fail-safe: findById nulo → mantém o original e não desce", async () => {
    const deps = {
      findById: vi.fn(async () => null),
      ensureLeaf: vi.fn(),
      findByExternalId: vi.fn(),
    };
    expect(await mlModeToLeafCuid("cuid-x", deps)).toBe("cuid-x");
    expect(deps.ensureLeaf).not.toHaveBeenCalled();
  });

  it("fail-safe: folha sem cuid correspondente → mantém o original", async () => {
    const deps = {
      findById: vi.fn(async () => ({ externalId: "MLB190973" })),
      ensureLeaf: vi.fn(async () => ({ externalId: "MLB1000" })),
      findByExternalId: vi.fn(async () => null),
    };
    expect(await mlModeToLeafCuid("cuid-parent", deps)).toBe("cuid-parent");
  });

  it("fail-safe: exceção nas deps → mantém o original", async () => {
    const deps = {
      findById: vi.fn(async () => {
        throw new Error("db down");
      }),
      ensureLeaf: vi.fn(),
      findByExternalId: vi.fn(),
    };
    expect(await mlModeToLeafCuid("cuid-x", deps)).toBe("cuid-x");
  });
});

describe("shopeeModeToLeafId", () => {
  it("prefixa SHP_, desce até a folha e devolve o id puro", async () => {
    const deps = {
      ensureLeaf: vi.fn(async (ext: string) =>
        ext === "SHP_102231" ? { externalId: "SHP_102601" } : { externalId: ext },
      ),
    };
    expect(await shopeeModeToLeafId("102231", deps)).toBe("102601");
    expect(deps.ensureLeaf).toHaveBeenCalledWith("SHP_102231");
  });

  it("mantém o id quando já é folha", async () => {
    const deps = {
      ensureLeaf: vi.fn(async (ext: string) => ({ externalId: ext })),
    };
    expect(await shopeeModeToLeafId("102601", deps)).toBe("102601");
  });

  it("fail-safe: ensureLeaf nulo → mantém o original", async () => {
    const deps = { ensureLeaf: vi.fn(async () => null) };
    expect(await shopeeModeToLeafId("102231", deps)).toBe("102231");
  });

  it("fail-safe: exceção → mantém o original", async () => {
    const deps = {
      ensureLeaf: vi.fn(async () => {
        throw new Error("x");
      }),
    };
    expect(await shopeeModeToLeafId("102231", deps)).toBe("102231");
  });
});
