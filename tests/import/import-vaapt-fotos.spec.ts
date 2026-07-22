/**
 * Importação das FOTOS das peças (Vaapt). O arquivo real tem uma linha por
 * foto (69.931 linhas → 13.648 peças, média 5,1 fotos/peça) e a chave é
 * "# idPeca", que é o mesmo valor que o vínculo usa como SKU.
 */

import { describe, it, expect, vi } from "vitest";
import XLSX from "xlsx";

vi.mock("../../app/lib/prisma", () => ({
  default: {
    product: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async () => []),
  },
}));

import {
  executePhotosPlan,
  runVaaptPhotos,
  type PhotoProductRef,
  type PhotosExecDeps,
} from "../../app/usecases/import/executors/product-photos.executor";
import {
  mapVaaptPhotos,
  MAX_FOTOS_POR_PECA,
} from "../../app/usecases/import/mappers/vaapt-fotos.mapper";
import {
  detectFile,
  detectAndValidate,
} from "../../app/usecases/import/import-detector";
import {
  availableEntities,
  isRunnerAvailable,
} from "../../app/usecases/import/import-runners";
import { newReport } from "../../app/usecases/import/import.types";
import type { ImportContext } from "../../app/usecases/import/import.types";

const HEADER = [
  "# idPeca",
  "Titulo",
  "SKU",
  "Preço",
  "intStatus",
  "Localização",
  "Quantidade inicial",
  "Quantidade disponivel",
  "Quantidade vendida",
  "Codigo ML",
  "strCodigoVeiculo",
  "Link das imagens",
];

/** Linha do arquivo real: só idPeca e o link importam para esta importação. */
const linha = (idPeca: unknown, url: unknown) => [
  idPeca,
  "LANTERNA",
  "EXCLUIDO", // o SKU do arquivo é sentinela em 17.742 linhas reais — não é usado
  "124.00",
  "Vendido",
  "CX PR 1",
  1000,
  1000,
  "0.000",
  "MLB1",
  "V76",
  url,
];

function fotosFile(rows: unknown[][], filename = "BackupImagesPecasEmp583.xlsx") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), "Planilha1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return detectFile({ fieldname: "file", filename, buffer });
}

const prod = (
  id: string,
  sku: string,
  imageUrl: string | null = null,
  imageUrls: string[] = [],
): PhotoProductRef => ({ id, sku, skuNormalized: sku.trim().toLowerCase(), imageUrl, imageUrls });

function makeDeps(products: PhotoProductRef[]) {
  const gravadas: Array<{ productId: string; imageUrl: string; imageUrls: string[] }> = [];
  const deps: PhotosExecDeps = {
    loadProductsBySkuNormalized: vi.fn(async (_u: string, norms: string[]) =>
      products.filter((p) => p.skuNormalized && norms.includes(p.skuNormalized)),
    ),
    setImageUrlsMany: vi.fn(
      async (items: Array<{ productId: string; imageUrl: string; imageUrls: string[] }>) => {
        gravadas.push(...items);
        return { count: items.length };
      },
    ) as PhotosExecDeps["setImageUrlsMany"],
  };
  return { deps, gravadas };
}

const ctx = (dryRun: boolean): ImportContext => ({
  targetUserId: "admin-1",
  files: [],
  dryRun,
});

describe("fotos — mapper", () => {
  it("agrupa as linhas por peça preservando a ordem das fotos", () => {
    const r = mapVaaptPhotos(
      fotosFile([
        linha(2808524, "https://s3/a.jpg"),
        linha(2808524, "https://s3/b.jpg"),
        linha(2808524, "https://s3/c.jpg"),
        linha(2809017, "https://s3/d.jpg"),
      ]),
    );
    expect(r.totalRows).toBe(4);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].sku).toBe("2808524");
    expect(r.items[0].urls).toEqual(["https://s3/a.jpg", "https://s3/b.jpg", "https://s3/c.jpg"]);
    expect(r.items[1].urls).toEqual(["https://s3/d.jpg"]);
  });

  it("URL repetida na MESMA peça entra uma vez só", () => {
    const r = mapVaaptPhotos(
      fotosFile([linha(1, "https://s3/a.jpg"), linha(1, "https://s3/a.jpg")]),
    );
    expect(r.items[0].urls).toEqual(["https://s3/a.jpg"]);
    expect(r.urlsDuplicadas).toBe(1);
  });

  it("a mesma URL pode servir a peças diferentes (o arquivo real repete)", () => {
    const r = mapVaaptPhotos(
      fotosFile([linha(1, "https://s3/a.jpg"), linha(2, "https://s3/a.jpg")]),
    );
    expect(r.items).toHaveLength(2);
    expect(r.urlsDuplicadas).toBe(0);
  });

  it("SEGURANÇA: só http(s) passa — javascript:/data:/relativo são descartados", () => {
    const r = mapVaaptPhotos(
      fotosFile([
        linha(1, "javascript:alert(1)"),
        linha(2, "data:text/html;base64,PHN2Zz4="),
        linha(3, "/uploads/a.jpg"),
        linha(4, "https://s3/ok.jpg"),
      ]),
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].sku).toBe("4");
    expect(r.urlsInvalidas).toBe(3);
  });

  it("linha sem '# idPeca' é contada como inválida, não derruba o arquivo", () => {
    const r = mapVaaptPhotos(
      fotosFile([linha(null, "https://s3/a.jpg"), linha(9, "https://s3/b.jpg")]),
    );
    expect(r.invalidRows).toBe(1);
    expect(r.items).toHaveLength(1);
  });

  it("peça cujas linhas são todas inválidas não vira item (array vazio nunca grava)", () => {
    const r = mapVaaptPhotos(fotosFile([linha(7, "ftp://x/a.jpg"), linha(7, "")]));
    expect(r.items).toHaveLength(0);
  });

  it(`corta no teto de ${MAX_FOTOS_POR_PECA} fotos por peça e avisa`, () => {
    const rows = Array.from({ length: MAX_FOTOS_POR_PECA + 5 }, (_, i) =>
      linha(1, `https://s3/${i}.jpg`),
    );
    const r = mapVaaptPhotos(fotosFile(rows));
    expect(r.items[0].urls).toHaveLength(MAX_FOTOS_POR_PECA);
    expect(r.avisos.some((a) => a.motivo.includes("limite"))).toBe(true);
  });
});

describe("fotos — executor", () => {
  const items = () =>
    mapVaaptPhotos(
      fotosFile([
        linha(100, "https://s3/a.jpg"),
        linha(100, "https://s3/b.jpg"),
        linha(200, "https://s3/c.jpg"),
      ]),
    ).items;

  it("PRÉVIA não grava nada e conta o que gravaria", async () => {
    const { deps, gravadas } = makeDeps([prod("p1", "100"), prod("p2", "200")]);
    const report = newReport("VAAPT", "FOTOS", "admin-1", true);
    await executePhotosPlan(ctx(true), report, items(), deps);
    expect(deps.setImageUrlsMany).not.toHaveBeenCalled();
    expect(gravadas).toHaveLength(0);
    expect(report.contadores.produtos_a_receber_foto).toBe(2);
    expect(report.contadores.fotos_no_plano).toBe(3);
  });

  it("APPLY grava a 1ª foto em imageUrl e todas em imageUrls", async () => {
    const { deps, gravadas } = makeDeps([prod("p1", "100"), prod("p2", "200")]);
    const report = newReport("VAAPT", "FOTOS", "admin-1", false);
    await executePhotosPlan(ctx(false), report, items(), deps);
    expect(gravadas).toHaveLength(2);
    const p1 = gravadas.find((g) => g.productId === "p1")!;
    expect(p1.imageUrl).toBe("https://s3/a.jpg");
    expect(p1.imageUrls).toEqual(["https://s3/a.jpg", "https://s3/b.jpg"]);
    expect(report.contadores.produtos_com_foto_gravada).toBe(2);
  });

  it("NÃO sobrescreve produto que já tem foto (nem por imageUrl, nem por imageUrls)", async () => {
    const { deps, gravadas } = makeDeps([
      prod("p1", "100", "https://dexo/minha.jpg"),
      prod("p2", "200", null, ["https://dexo/outra.jpg"]),
    ]);
    const report = newReport("VAAPT", "FOTOS", "admin-1", false);
    await executePhotosPlan(ctx(false), report, items(), deps);
    expect(gravadas).toHaveLength(0);
    expect(report.contadores.ja_tinha_foto).toBe(2);
  });

  it("reimportar é idempotente: 2ª rodada não grava nada", async () => {
    const primeira = makeDeps([prod("p1", "100"), prod("p2", "200")]);
    const r1 = newReport("VAAPT", "FOTOS", "admin-1", false);
    await executePhotosPlan(ctx(false), r1, items(), primeira.deps);
    expect(primeira.gravadas).toHaveLength(2);

    // O estado do banco depois da 1ª rodada: os produtos já têm foto.
    const segunda = makeDeps([
      prod("p1", "100", "https://s3/a.jpg", ["https://s3/a.jpg", "https://s3/b.jpg"]),
      prod("p2", "200", "https://s3/c.jpg", ["https://s3/c.jpg"]),
    ]);
    const r2 = newReport("VAAPT", "FOTOS", "admin-1", false);
    await executePhotosPlan(ctx(false), r2, items(), segunda.deps);
    expect(segunda.gravadas).toHaveLength(0);
    expect(r2.contadores.ja_tinha_foto).toBe(2);
  });

  it("peça sem produto no Dexo é reportada, NUNCA vinculada em outro", async () => {
    const { deps, gravadas } = makeDeps([prod("p1", "100")]);
    const report = newReport("VAAPT", "FOTOS", "admin-1", false);
    await executePhotosPlan(ctx(false), report, items(), deps);
    expect(gravadas.map((g) => g.productId)).toEqual(["p1"]);
    expect(report.semProduto?.total).toBe(1);
    expect(report.semProduto?.exemplos).toContain("200");
  });

  it("SKU ambíguo (2 produtos) não recebe foto", async () => {
    const { deps, gravadas } = makeDeps([
      prod("p1", "100"),
      prod("p1-bis", "100"),
      prod("p2", "200"),
    ]);
    const report = newReport("VAAPT", "FOTOS", "admin-1", false);
    await executePhotosPlan(ctx(false), report, items(), deps);
    expect(gravadas.map((g) => g.productId)).toEqual(["p2"]);
    expect(report.ambiguos?.total).toBe(1);
  });

  it("falha ao gravar um lote não derruba o job — vira erro no relatório", async () => {
    const { deps } = makeDeps([prod("p1", "100"), prod("p2", "200")]);
    deps.setImageUrlsMany = vi.fn(async () => {
      throw new Error("banco fora");
    }) as PhotosExecDeps["setImageUrlsMany"];
    const report = newReport("VAAPT", "FOTOS", "admin-1", false);
    await expect(
      executePhotosPlan(ctx(false), report, items(), deps),
    ).resolves.toBeUndefined();
    expect(report.contadores.erros).toBe(2);
    expect(report.erros[0].motivo).toContain("banco fora");
  });
});

describe("registro da entidade — contrato UI ↔ rota", () => {
  it("VAAPT/FOTOS está no registry (é o que a UI e a rota consomem)", () => {
    expect(availableEntities()).toContainEqual({
      system: "VAAPT",
      entity: "FOTOS",
    });
    expect(isRunnerAvailable("VAAPT", "FOTOS")).toBe(true);
  });

  it("derivar a whitelist da rota não perde NENHUMA entidade da lista antiga", () => {
    // A rota tinha estas duas listas escritas à mão; agora ela as deriva de
    // availableEntities(). Este teste é a prova de que a troca só ADICIONA.
    const antesSystems = ["VAAPT", "WEBDESMONTE", "DEXO", "IBR", "IBRSOFT"];
    const antesEntities = [
      "CLIENTES",
      "LOCALIZACOES",
      "SUCATAS",
      "VINCULOS",
      "CONTAS",
      "NFE",
      "PACOTE",
      "ESTOQUE",
    ];
    const systems = new Set(availableEntities().map((a) => a.system));
    const entities = new Set(availableEntities().map((a) => a.entity));
    for (const s of antesSystems) expect(systems.has(s as never)).toBe(true);
    for (const e of antesEntities) expect(entities.has(e as never)).toBe(true);
    // …e adiciona a nova.
    expect(entities.has("FOTOS")).toBe(true);
  });
});

describe("fotos — detector e runner", () => {
  it("VAAPT/FOTOS aceita a planilha de imagens", () => {
    const f = fotosFile([linha(1, "https://s3/a.jpg")]);
    const res = detectAndValidate("VAAPT", "FOTOS", [f]);
    expect(res.files.map((x) => x.kind)).toEqual(["VAAPT_PECAS_IMAGENS"]);
    expect(res.ignored).toHaveLength(0);
  });

  it("o runner monta o relatório com as contagens do arquivo", async () => {
    const { deps } = makeDeps([prod("p1", "100")]);
    const file = fotosFile([
      linha(100, "https://s3/a.jpg"),
      linha(100, "https://s3/b.jpg"),
      linha(null, "https://s3/c.jpg"),
    ]);
    const report = await runVaaptPhotos(
      { targetUserId: "admin-1", files: [file], dryRun: true },
      deps,
    );
    expect(report.entity).toBe("FOTOS");
    expect(report.contadores.linhas_no_arquivo).toBe(3);
    expect(report.contadores.linhas_invalidas).toBe(1);
    expect(report.contadores.produtos_a_receber_foto).toBe(1);
  });
});
