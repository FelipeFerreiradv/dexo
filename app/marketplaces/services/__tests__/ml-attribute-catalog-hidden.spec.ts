import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// prisma mockado como {} → leituras/escritas de cache falham-abrem (fail-open),
// então getAll cai na API (mockada) e exercita normalize().
vi.mock("@/app/lib/prisma", () => ({ default: {} }));

import { MLApiService } from "../ml-api.service";
import { MLAttributeCatalogService } from "../ml-attribute-catalog.service";

describe("MLAttributeCatalogService.normalize — tags.hidden", () => {
  beforeEach(() => {
    MLAttributeCatalogService._clearMemory();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marca hidden a partir de tags.hidden e NUNCA rebaixa required", async () => {
    vi.spyOn(MLApiService, "getCategoryAttributes").mockResolvedValue([
      {
        id: "COR_CASA",
        name: "Cor da casa",
        value_type: "string",
        tags: { hidden: true },
      },
      {
        id: "REQ_HID",
        name: "Obrigatório oculto",
        value_type: "string",
        tags: { hidden: true, required: true },
      },
      { id: "NORMAL", name: "Normal", value_type: "string", tags: {} },
    ] as any);

    const out = await MLAttributeCatalogService.getAll("MLB-HID-1");
    const byId = new Map(out.map((a) => [a.id, a]));
    expect(byId.get("COR_CASA")?.hidden).toBe(true);
    expect(byId.get("COR_CASA")?.required).toBe(false);
    // hidden + required: hidden marcado, mas required preservado.
    expect(byId.get("REQ_HID")?.hidden).toBe(true);
    expect(byId.get("REQ_HID")?.required).toBe(true);
    expect(byId.get("NORMAL")?.hidden).toBe(false);
  });

  it("sem tag hidden → hidden=false (retrocompat) e required intacto", async () => {
    vi.spyOn(MLApiService, "getCategoryAttributes").mockResolvedValue([
      { id: "A", name: "A", value_type: "string", tags: { required: true } },
      {
        id: "B",
        name: "B",
        value_type: "string",
        tags: { catalog_required: true },
      },
    ] as any);
    const out = await MLAttributeCatalogService.getAll("MLB-HID-2");
    const byId = new Map(out.map((a) => [a.id, a]));
    expect(byId.get("A")?.hidden).toBe(false);
    expect(byId.get("A")?.required).toBe(true);
    // catalog_required continua contando como required (sem regressão).
    expect(byId.get("B")?.required).toBe(true);
  });
});
