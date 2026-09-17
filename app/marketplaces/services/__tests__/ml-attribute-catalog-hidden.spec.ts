import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// prisma mockado como {} → leituras/escritas de cache falham-abrem (fail-open),
// então getAll cai na API (mockada) e exercita normalize().
vi.mock("@/app/lib/prisma", () => ({ default: {} }));

import fs from "node:fs";
import path from "node:path";
import { MLApiService } from "../ml-api.service";
import {
  MLAttributeCatalogService,
  normalizeMLCategoryAttribute,
} from "../ml-attribute-catalog.service";

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

/**
 * Tags cruas separadas para a regra de obrigatórios (ML_REQUIRED_ATTRS_BLOCK).
 * O `required` LARGO não muda — é o que o asterisco e o preflight antigo leem.
 */
describe("MLAttributeCatalogService.normalize — tags cruas (obrigatórios do ML)", () => {
  beforeEach(() => {
    MLAttributeCatalogService._clearMemory();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("N1: grava os 4 booleanos SEMPRE, inclusive false (tags {} e tags completas)", () => {
    const vazio = normalizeMLCategoryAttribute({ id: "A", tags: {} });
    expect(vazio).toMatchObject({
      requiredTag: false,
      catalogRequiredTag: false,
      conditionalRequiredTag: false,
      fixedTag: false,
    });
    // Sem `tags` nenhuma também grava false (nunca undefined = "cache antigo").
    const semTags = normalizeMLCategoryAttribute({ id: "B" });
    expect(typeof semTags.requiredTag).toBe("boolean");
    expect(typeof semTags.fixedTag).toBe("boolean");

    const completo = normalizeMLCategoryAttribute({
      id: "C",
      tags: {
        required: true,
        catalog_required: true,
        conditional_required: true,
        fixed: true,
      },
    });
    expect(completo).toMatchObject({
      requiredTag: true,
      catalogRequiredTag: true,
      conditionalRequiredTag: true,
      fixedTag: true,
      required: true,
    });
  });

  it("N1b: o getAll (caminho da API) já devolve os booleanos", async () => {
    vi.spyOn(MLApiService, "getCategoryAttributes").mockResolvedValue([
      { id: "SO_CAT", name: "x", value_type: "string", tags: { catalog_required: true } },
    ] as any);
    const [a] = await MLAttributeCatalogService.getAll("MLB-TAGS-1");
    expect(a).toMatchObject({
      required: true,
      requiredTag: false,
      catalogRequiredTag: true,
      fixedTag: false,
      conditionalRequiredTag: false,
    });
  });

  const FIXTURES = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "tests",
    "fixtures",
    "ml-category-attributes",
  );
  const arquivosReais = fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".raw.json"));

  it("N2: em toda fixture real, `required` continua `required||catalog_required||fixed`", () => {
    expect(arquivosReais.length).toBeGreaterThanOrEqual(8);
    for (const arq of arquivosReais) {
      const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, arq), "utf8"));
      for (const attr of raw.attributes as any[]) {
        const n = normalizeMLCategoryAttribute(attr);
        const t = attr.tags || {};
        expect(n.required, `${arq}/${attr.id}`).toBe(
          Boolean(t.required || t.catalog_required || t.fixed),
        );
        expect(n.requiredTag).toBe(Boolean(t.required));
        expect(n.fixedTag).toBe(Boolean(t.fixed));
      }
    }
  });

  it("N3: getRequired continua devolvendo a lista LARGA (MOUNT_TYPE incluído)", async () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, "MLB2221.raw.json"), "utf8"),
    );
    vi.spyOn(MLApiService, "getCategoryAttributes").mockResolvedValue(
      raw.attributes,
    );
    const ids = (await MLAttributeCatalogService.getRequired("MLB2221")).map(
      (a) => a.id,
    );
    expect(ids).toContain("MOUNT_TYPE");
    expect(ids).toContain("VEHICLE_TYPE");
    expect(ids).toContain("PART_NUMBER");
  });
});
