import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FiscalStorageService } from "../../../app/fiscal/storage/fiscal-storage.service";

// Numeração V2 (I3): o XML assinado de cada tentativa é gravado ANTES de
// transmitir, um arquivo por tentativa, sem nunca sobrescrever a prova.

describe("FiscalStorageService.saveXmlTentativa", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "dexo-fiscal-tentativa-"));
    vi.stubEnv("FISCAL_STORAGE_PATH", base);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("grava em {base}/{userId}/xml-assinado/{nfeId}-{numero}-{ts}.xml e devolve o caminho", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_789_000_000_000);
    const storage = new FiscalStorageService();
    const xml = '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe1"/></NFe>';

    const caminho = await storage.saveXmlTentativa("user-1", "nfe-abc", 101, xml);

    expect(caminho).toBe(
      path.join(base, "user-1", "xml-assinado", "nfe-abc-101-1789000000000.xml"),
    );
    expect(fs.readFileSync(caminho, "utf-8")).toBe(xml);
    // Lido de volta pelo mesmo serviço (é assim que o nfeProc pós-consulta nasce).
    expect((await storage.readFile(caminho))?.toString("utf-8")).toBe(xml);
  });

  it("mesmo estilo de caminho de saveXmlAutorizado (mesma base e usuário, pasta própria)", async () => {
    const storage = new FiscalStorageService();
    const autorizado = await storage.saveXmlAutorizado("user-1", "nfe-abc", "<a/>");
    const tentativa = await storage.saveXmlTentativa("user-1", "nfe-abc", 7, "<b/>");

    expect(path.dirname(path.dirname(tentativa))).toBe(
      path.dirname(path.dirname(autorizado)),
    );
    expect(path.basename(path.dirname(tentativa))).toBe("xml-assinado");
    expect(path.isAbsolute(tentativa)).toBe(path.isAbsolute(autorizado));
    // Não mexe no arquivo autorizado.
    expect(fs.readFileSync(autorizado, "utf-8")).toBe("<a/>");
  });

  it("preserva UTF-8 byte a byte (acentos no XML assinado)", async () => {
    const storage = new FiscalStorageService();
    const xml = "<xNome>AUTOPEÇAS SÃO JOSÉ — ÇÃÕ</xNome>";
    const caminho = await storage.saveXmlTentativa("u", "n", 1, xml);
    expect(fs.readFileSync(caminho)).toEqual(Buffer.from(xml, "utf-8"));
  });

  it("tentativas em instantes diferentes geram arquivos diferentes (nada sobrescrito)", async () => {
    const now = vi.spyOn(Date, "now");
    const storage = new FiscalStorageService();

    now.mockReturnValue(1_000);
    const t1 = await storage.saveXmlTentativa("u", "nfe-1", 101, "<t1/>");
    now.mockReturnValue(2_000);
    const t2 = await storage.saveXmlTentativa("u", "nfe-1", 101, "<t2/>");

    expect(t1).not.toBe(t2);
    expect(fs.readFileSync(t1, "utf-8")).toBe("<t1/>");
    expect(fs.readFileSync(t2, "utf-8")).toBe("<t2/>");
  });

  it("colisão no mesmo ms LANÇA (falha local antes de transmitir) e mantém a prova anterior", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const storage = new FiscalStorageService();

    const primeiro = await storage.saveXmlTentativa("u", "nfe-1", 101, "<original/>");
    await expect(
      storage.saveXmlTentativa("u", "nfe-1", 101, "<outra/>"),
    ).rejects.toThrow();
    expect(fs.readFileSync(primeiro, "utf-8")).toBe("<original/>");
  });

  it("não cria nada fora de xml-assinado", async () => {
    const storage = new FiscalStorageService();
    await storage.saveXmlTentativa("user-9", "nfe-9", 3, "<x/>");
    expect(fs.readdirSync(path.join(base, "user-9"))).toEqual(["xml-assinado"]);
  });
});
