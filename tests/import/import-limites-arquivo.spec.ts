/**
 * Limites de tamanho da importação de bases legadas.
 *
 * O bug que originou estes testes: a migração do Emp595 traz um xlsx de
 * 36,1 MB com 653.240 linhas × 12 colunas (7.838.880 células) e batia em DOIS
 * muros independentes — o teto de 20 MB do multipart e o teto fixo de 5 M
 * células do leitor de xlsx. Elevar só o primeiro deixaria o arquivo subir
 * para morrer no segundo.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import XLSX from "xlsx";
import fastify, { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import FormData from "form-data";

import {
  checkImportFiles,
  formatBytes,
  IMPORT_FILE_TOO_LARGE_MESSAGE,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_TOTAL_BYTES,
  IMPORT_TOO_MANY_FILES_MESSAGE,
} from "../../lib/import-limits";
import {
  readXlsxBuffer,
  sheetCellBudget,
} from "../../app/usecases/import/parse/xlsx-reader";
import { detectFile } from "../../app/usecases/import/import-detector";
import { resolveEffectiveSelection } from "../../app/usecases/import/import-selection";
import { ImportValidationError } from "../../app/usecases/import/import.types";

/* ------------------------------ Helpers -------------------------------- */

function xlsxBufferOf(aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Planilha1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const MB = 1024 * 1024;

/* ------------------- Orçamento de células (xlsx-reader) ----------------- */

describe("sheetCellBudget — teto de células proporcional ao arquivo", () => {
  const ANTIGO = 5_000_000;

  it("NUNCA fica abaixo do teto fixo antigo (zero regressão por construção)", () => {
    // Qualquer planilha que passava com o teto fixo de 5M continua passando:
    // o piso do orçamento novo É o valor antigo.
    for (const bytes of [0, 1, 1024, 100 * 1024, 1 * MB, 2 * MB, 2.5 * MB]) {
      expect(sheetCellBudget(bytes)).toBeGreaterThanOrEqual(ANTIGO);
    }
  });

  it("arquivo pequeno recebe EXATAMENTE o orçamento antigo (bomba segue barrada)", () => {
    // É onde vivem as bombas de dimensão: arquivo minúsculo, faixa enorme.
    expect(sheetCellBudget(10 * 1024)).toBe(ANTIGO);
    expect(sheetCellBudget(1 * MB)).toBe(ANTIGO);
  });

  it("cresce com o tamanho do arquivo, até o teto de memória", () => {
    expect(sheetCellBudget(4 * MB)).toBeGreaterThan(ANTIGO);
    expect(sheetCellBudget(4 * MB)).toBeLessThan(sheetCellBudget(6 * MB));
    // Teto absoluto: derivado da memória (~137 bytes/célula medidos).
    expect(sheetCellBudget(500 * MB)).toBe(sheetCellBudget(1000 * MB));
  });

  it("comporta o arquivo REAL do Emp595 (36,1 MB / 7.838.880 células)", () => {
    const CELULAS_REAIS = 653_240 * 12;
    expect(CELULAS_REAIS).toBeGreaterThan(ANTIGO); // era barrado antes
    expect(sheetCellBudget(37_868_558)).toBeGreaterThan(CELULAS_REAIS);
  });

  it("é monotônico (mais bytes nunca dão orçamento menor)", () => {
    let anterior = -1;
    for (let mb = 0; mb <= 40; mb += 2) {
      const atual = sheetCellBudget(mb * MB);
      expect(atual).toBeGreaterThanOrEqual(anterior);
      anterior = atual;
    }
  });
});

describe("readXlsxBuffer — guard de dimensão", () => {
  /**
   * Bomba de dimensão: ~16 KB de arquivo declarando 7.800.000 células (488
   * células por byte; um export real fica em 0,22). Construída UMA vez: o
   * `XLSX.write` percorre a faixa DECLARADA, então cada reconstrução custa
   * segundos — três cópias derrubavam o worker do vitest. O caso extremo
   * (~700M células) já é coberto por `import-detector.spec.ts`.
   */
  let bomba: Buffer;
  beforeAll(() => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["A", "B"], ["1", "2"]]);
    sheet["!ref"] = "A1:Z300000";
    XLSX.utils.book_append_sheet(wb, sheet, "Planilha1");
    bomba = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }, 60_000);

  it("bomba de dimensão continua rejeitada", () => {
    expect(bomba.length).toBeLessThan(100 * 1024); // é mesmo um arquivo pequeno
    expect(() => readXlsxBuffer(bomba)).toThrow(/células/);
  });

  it("o erro de dimensão é ImportValidationError (vira 400, não 500)", () => {
    // Antes era `Error` cru: `sendImportError` só converte
    // ImportValidationError/ImportConflictError em 4xx, então o operador
    // recebia "Erro na importação de dados" com HTTP 500 para um arquivo que
    // ele pode consertar.
    expect(() => readXlsxBuffer(bomba)).toThrow(ImportValidationError);
  });

  it("a mensagem diz o orçamento efetivo daquele arquivo", () => {
    expect(() => readXlsxBuffer(bomba)).toThrow(
      new RegExp(sheetCellBudget(bomba.length).toLocaleString("pt-BR")),
    );
  });
});

/* --------------- Equivalência do modo denso (otimização) ---------------- */

describe("readXlsxBuffer — `dense: true` + `cellHTML: false` não mudam a saída", () => {
  /** Caminho ANTIGO, literal, para comparar contra o atual. */
  function lerModoAntigo(buffer: Buffer) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: null });
  }

  const COM_ESCAPE = [
    ["Titulo", "Localização"],
    ["PARA-CHOQUE <DIANT.> & CIA", "GALPÃO 1 > CX 9"],
  ];

  it("o reader PASSA `cellHTML: false` (e `dense: true`) para o XLSX.read", () => {
    // ⚠️ Espionar a chamada é a ÚNICA forma de testar isto: as duas opções são
    // escolhidas justamente por NÃO mudarem a saída, então nenhum assert sobre
    // o resultado consegue distinguir. A primeira versão deste teste montava os
    // próprios XLSX.read com as opções na mão — afirmava o comportamento da
    // BIBLIOTECA, e continuava verde com a opção removida do nosso código
    // (comprovado no mutation check).
    const spy = vi.spyOn(XLSX, "read");
    try {
      readXlsxBuffer(xlsxBufferOf(COM_ESCAPE));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatchObject({
        type: "buffer",
        dense: true,
        cellHTML: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("com `cellHTML: false` nenhuma célula carrega o campo `.h`", () => {
    // A outra metade: o que a opção efetivamente desliga. O SheetJS gera `.h`
    // (o texto HTML-escapado) em TODA célula de texto por padrão; ninguém aqui
    // lê `.h` — o sheet_to_json usa `.v`/`.w`.
    const buffer = xlsxBufferOf(COM_ESCAPE);
    const contaH = (opts: XLSX.ParsingOptions) => {
      const wb = XLSX.read(buffer, { type: "buffer", dense: true, ...opts });
      const sheet = wb.Sheets[wb.SheetNames[0]] as unknown as Array<
        Array<{ t?: string; h?: string } | undefined> | undefined
      >;
      let comH = 0;
      let texto = 0;
      for (const linha of sheet) {
        if (!linha) continue;
        for (const c of linha) {
          if (c && c.t === "s") {
            texto++;
            if (c.h !== undefined) comH++;
          }
        }
      }
      return { texto, comH };
    };

    expect(contaH({}).comH).toBeGreaterThan(0); // default da lib
    expect(contaH({ cellHTML: false })).toEqual({ texto: 4, comH: 0 });
  });

  it("a leitura continua idêntica com `<`, `>` e `&` (que o escape alteraria)", () => {
    const buffer = xlsxBufferOf(COM_ESCAPE);
    expect(readXlsxBuffer(buffer).rows).toEqual(lerModoAntigo(buffer));
    expect(readXlsxBuffer(buffer).rows[0]).toMatchObject({
      Titulo: "PARA-CHOQUE <DIANT.> & CIA",
    });
  });

  it("linhas idênticas com tipos e acentos misturados", () => {
    const buffer = xlsxBufferOf([
      ["# Cod Peca", "Nome peça", "Preço", "Ativo", "Localização", "Vazio"],
      ["0012", "PARA-CHOQUE DIANT.", 1234.56, true, "GALPÃO 1 > CX 9", null],
      ["0013", "Farol N°2 — LE", 0, false, "", null],
      ["0014", "", -1.5, null, "Área B", null],
    ]);
    expect(readXlsxBuffer(buffer).rows).toEqual(lerModoAntigo(buffer));
  });

  it("preserva o header e o getter tolerante a acento/caixa", () => {
    const buffer = xlsxBufferOf([
      ["# Cod Peca", "Localização"],
      ["100", "LOCAL 1"],
    ]);
    const t = readXlsxBuffer(buffer);
    expect(t.header).toEqual(["# Cod Peca", "Localização"]);
    expect(t.get(t.rows[0], "localizacao")).toBe("LOCAL 1");
    expect(t.shiftedLabels).toBe(false);
  });

  it("o getter memoizado devolve o mesmo que o rótulo cru, repetidamente", () => {
    // O `get` passou a memoizar a normalização do RÓTULO (roda por linha). O
    // que não pode mudar: variantes do mesmo rótulo continuam resolvendo, e
    // chamar duas vezes devolve o mesmo valor.
    const buffer = xlsxBufferOf([
      ["# Cod Peca", "Localização", "Valor (R$)"],
      ["100", "LOCAL 1", "10,50"],
      ["101", "LOCAL 2", "20,00"],
    ]);
    const t = readXlsxBuffer(buffer);
    for (const linha of t.rows) {
      for (const rotulo of [
        "# Cod Peca",
        "cod peca",
        "COD.PECA",
        "Localização",
        "localizacao",
        "Valor (R$)",
        "valor",
      ]) {
        expect(t.get(linha, rotulo)).toBe(t.get(linha, rotulo));
      }
    }
    expect(t.get(t.rows[0], "COD.PECA")).toBe("100");
    expect(t.get(t.rows[1], "localizacao")).toBe("LOCAL 2");
    expect(t.get(t.rows[0], "valor")).toBe("10,50");
    expect(t.get(t.rows[0], "coluna que não existe")).toBeNull();
  });

  it("continua reconhecendo o formato de rótulos deslocados (invoicy)", () => {
    const buffer = xlsxBufferOf([
      ["Relatório de notas", null, null, null],
      ["Numero", "Serie", "Chave", "Valor"],
      ["1", "1", "351", "10"],
    ]);
    const t = readXlsxBuffer(buffer);
    expect(t.shiftedLabels).toBe(true);
    expect(t.header).toEqual(["Numero", "Serie", "Chave", "Valor"]);
    expect(t.rows).toHaveLength(1);
    expect(t.get(t.rows[0], "Chave")).toBe("351");
  });

  it("aba de capa vazia continua sendo pulada", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Instruções"]]), "Capa");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["# Cod Peca"], ["100"]]),
      "Dados",
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const t = readXlsxBuffer(buffer);
    expect(t.sheetName).toBe("Dados");
    expect(t.rows).toHaveLength(1);
  });
});

/* --------------------- Memo do parse (custo repetido) ------------------- */

describe("detectFile — memoização do parse por arquivo", () => {
  function arquivo(name = "pecas.xlsx") {
    return {
      fieldname: "file",
      filename: name,
      buffer: xlsxBufferOf([
        ["# Cod Peca", "Nome peca", "Localizacao", "Cod Veiculo"],
        ["100", "PARACHOQUE", "CX 9", "36"],
      ]),
    };
  }

  it("reparsear o MESMO arquivo devolve o mesmo resultado, sem refazer o trabalho", () => {
    // Identidade referencial é a prova: um segundo parse produziria objetos
    // novos. `resolveEffectiveSelection` chama o detector até 4× por request
    // no caminho infeliz — com o export de 36 MB isso eram ~16s cada.
    const f = arquivo();
    const a = detectFile(f);
    const b = detectFile(f);
    expect(b).toBe(a);
    expect(b.rows).toBe(a.rows);
    expect(a.kind).toBe("VAAPT_PECAS");
  });

  it("arquivos DIFERENTES não compartilham resultado, mesmo com bytes iguais", () => {
    const buffer = arquivo().buffer;
    const f1 = { fieldname: "file", filename: "a.xlsx", buffer };
    const f2 = { fieldname: "file", filename: "b.xlsx", buffer };
    const a = detectFile(f1);
    const b = detectFile(f2);
    expect(b).not.toBe(a);
    expect(a.filename).toBe("a.xlsx");
    expect(b.filename).toBe("b.xlsx");
  });

  it("a FALHA também é memoizada (recusar não custa dois parses)", () => {
    const f = {
      fieldname: "file",
      filename: "vazio.xlsx",
      buffer: Buffer.from("<?xml version=\"1.0\"?><nfeProc/>", "utf8"),
    };
    let e1: unknown;
    let e2: unknown;
    try {
      detectFile(f);
    } catch (e) {
      e1 = e;
    }
    try {
      detectFile(f);
    } catch (e) {
      e2 = e;
    }
    expect(e1).toBeInstanceOf(ImportValidationError);
    expect(e2).toBe(e1);
  });

  it("resolveEffectiveSelection reaproveita o parse do detector", () => {
    const f = arquivo();
    const primeiro = detectFile(f);
    const res = resolveEffectiveSelection("VAAPT", "VINCULOS", [f]);
    expect(res.files[0]).toBe(primeiro);
  });
});

/* ------------------------- Constantes e mensagens ----------------------- */

describe("lib/import-limits — regra única para os dois lados", () => {
  it("o teto por arquivo cobre o maior export real (36,1 MB) com folga", () => {
    expect(IMPORT_MAX_FILE_BYTES).toBeGreaterThan(37_868_558);
  });

  it("o teto total é maior que o teto por arquivo", () => {
    expect(IMPORT_MAX_TOTAL_BYTES).toBeGreaterThan(IMPORT_MAX_FILE_BYTES);
  });

  it("formatBytes escreve em pt-BR", () => {
    expect(formatBytes(37_868_558)).toBe("36,1 MB");
    expect(formatBytes(100 * MB)).toBe("100 MB");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("checkImportFiles aceita a seleção real do Emp595", () => {
    expect(
      checkImportFiles([
        { name: "pecasEmp595.xlsx", size: 37_868_558 },
        { name: "PecasSemImagensEmp595.xlsx", size: 4_868_217 },
      ]),
    ).toBeNull();
  });

  it("checkImportFiles recusa arquivo acima do teto, nomeando o culpado", () => {
    const msg = checkImportFiles([
      { name: "ok.xlsx", size: 1 * MB },
      { name: "gigante.xlsx", size: IMPORT_MAX_FILE_BYTES + 1 },
    ]);
    expect(msg).toContain("gigante.xlsx");
    expect(msg).toContain(IMPORT_FILE_TOO_LARGE_MESSAGE);
  });

  it("checkImportFiles recusa arquivos demais", () => {
    const files = Array.from({ length: IMPORT_MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.csv`,
      size: 10,
    }));
    expect(checkImportFiles(files)).toContain(IMPORT_TOO_MANY_FILES_MESSAGE);
  });

  it("checkImportFiles recusa o somatório mesmo com cada arquivo dentro do teto", () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      name: `f${i}.xlsx`,
      size: IMPORT_MAX_FILE_BYTES,
    }));
    expect(files.every((f) => f.size <= IMPORT_MAX_FILE_BYTES)).toBe(true);
    expect(checkImportFiles(files)).toMatch(/somam/);
  });

  it("nada selecionado não é erro", () => {
    expect(checkImportFiles([])).toBeNull();
  });
});

/* ---------------- Rota: o limite por-requisição vence o global ---------- */

const previewMock = vi.fn();
const applyMock = vi.fn();

vi.mock("../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async () => {},
}));
vi.mock("../../app/middlewares/require-superadmin.middleware", () => ({
  requireSuperadmin: async () => {},
}));
vi.mock("../../app/usecases/import/import-preview.usecase", () => ({
  ImportPreviewUseCase: class {
    preview = (...args: unknown[]) => previewMock(...args);
  },
}));
vi.mock("../../app/usecases/import/import-apply.usecase", () => ({
  ImportApplyUseCase: class {
    apply = (...args: unknown[]) => applyMock(...args);
  },
}));

import { superadminImportRoutes } from "../../app/routes/superadmin-import.routes";

function formWith(files: Array<{ name: string; buffer: Buffer }>) {
  const form = new FormData();
  form.append("targetUserId", "user-1");
  form.append("system", "VAAPT");
  form.append("entity", "PACOTE");
  for (const f of files) {
    form.append("file", f.buffer, {
      filename: f.name,
      contentType: "application/vnd.ms-excel",
    });
  }
  return { headers: form.getHeaders(), body: form.getBuffer() };
}

describe("POST /superadmin/import/preview — limite de tamanho", () => {
  let app: FastifyInstance;
  /** Global BAIXO de propósito: se a rota não sobrescrevesse, tudo falharia. */
  const GLOBAL_BAIXO = 4 * 1024;

  beforeEach(async () => {
    previewMock.mockReset().mockResolvedValue({ ok: true });
    applyMock.mockReset().mockResolvedValue({ jobId: "job-1" });
    app = fastify();
    await app.register(multipart, { limits: { fileSize: GLOBAL_BAIXO } });
    await app.register(superadminImportRoutes, { prefix: "/superadmin" });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await app.close();
  });

  it("aceita arquivo MAIOR que o limite global do multipart", async () => {
    // É a prova do desenho: o teto da migração é da ROTA, não do registro
    // global — que continua valendo 20MB para as rotas de imagem.
    const grande = Buffer.alloc(GLOBAL_BAIXO * 8, 0x41);
    const { headers, body } = formWith([{ name: "pecas.xlsx", buffer: grande }]);
    const res = await app.inject({
      method: "POST",
      url: "/superadmin/import/preview",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const recebido = previewMock.mock.calls[0][0] as {
      files: Array<{ buffer: Buffer; filename: string }>;
    };
    expect(recebido.files).toHaveLength(1);
    expect(recebido.files[0].filename).toBe("pecas.xlsx");
    // Chegou INTEIRO — nada de truncar em silêncio.
    expect(recebido.files[0].buffer.length).toBe(grande.length);
  });

  it("os campos de texto continuam chegando junto", async () => {
    const { headers, body } = formWith([
      { name: "a.csv", buffer: Buffer.from("x") },
    ]);
    await app.inject({
      method: "POST",
      url: "/superadmin/import/preview",
      headers,
      payload: body,
    });
    expect(previewMock.mock.calls[0][0]).toMatchObject({
      targetUserId: "user-1",
      system: "VAAPT",
      entity: "PACOTE",
    });
  });

  it("aceita EXATAMENTE o limite de quantidade (o pacote maior tem 7)", async () => {
    // Fronteira: o teto do busboy dispara ao EXCEDER, não ao atingir. Se
    // disparasse ao atingir, um pacote legítimo de 12 planilhas quebraria.
    const files = Array.from({ length: IMPORT_MAX_FILES }, (_, i) => ({
      name: `f${i}.csv`,
      buffer: Buffer.from("a"),
    }));
    const { headers, body } = formWith(files);
    const res = await app.inject({
      method: "POST",
      url: "/superadmin/import/preview",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(
      (previewMock.mock.calls[0][0] as { files: unknown[] }).files,
    ).toHaveLength(IMPORT_MAX_FILES);
  });

  it("recusa com 400 e mensagem clara quando passam do limite de quantidade", async () => {
    const files = Array.from({ length: IMPORT_MAX_FILES + 2 }, (_, i) => ({
      name: `f${i}.csv`,
      buffer: Buffer.from("a"),
    }));
    const { headers, body } = formWith(files);
    const res = await app.inject({
      method: "POST",
      url: "/superadmin/import/preview",
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toBe(IMPORT_TOO_MANY_FILES_MESSAGE);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("o /apply herda exatamente o mesmo teto", async () => {
    const grande = Buffer.alloc(GLOBAL_BAIXO * 8, 0x41);
    const form = new FormData();
    form.append("targetUserId", "user-1");
    form.append("system", "VAAPT");
    form.append("entity", "PACOTE");
    form.append("previewHash", "hash-1");
    form.append("file", grande, { filename: "pecas.xlsx" });
    const res = await app.inject({
      method: "POST",
      url: "/superadmin/import/apply",
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(202);
    expect(applyMock.mock.calls[0][0]).toMatchObject({ previewHash: "hash-1" });
  });
});
