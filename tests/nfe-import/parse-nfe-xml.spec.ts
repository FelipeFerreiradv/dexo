import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseNfeXml,
  NfeParseError,
} from "../../app/fiscal/nfe-import/parse-nfe-xml";

const fx = (name: string): string =>
  readFileSync(
    join(process.cwd(), "tests", "nfe-import", "fixtures", name),
    "utf-8",
  );

describe("parseNfeXml", () => {
  it("lê NF-e com wrapper nfeProc (1 item, N unidades)", () => {
    const r = parseNfeXml(fx("single-item.xml"));
    expect(r.items).toHaveLength(1);
    const item = r.items[0];
    expect(item.name).toBe("PASTILHA DE FREIO DIANTEIRA HONDA CIVIC");
    expect(item.costPrice).toBe(45.9);
    expect(item.quantity).toBe(5);
    expect(item.unit).toBe("UN");
    expect(item.lineTotal).toBe(229.5);
    expect(r.meta.numero).toBe("1");
    expect(r.meta.emitName).toBe("FORNECEDOR EXEMPLO LTDA");
    expect(r.meta.itemCount).toBe(1);
    expect(r.meta.groupedCount).toBe(1);
  });

  it("lê NF-e crua sem nfeProc (NFe/infNFe direto)", () => {
    const r = parseNfeXml(fx("no-nfeproc.xml"));
    expect(r.items).toHaveLength(1);
    expect(r.items[0].name).toBe("FILTRO DE OLEO MOTOR");
    expect(r.items[0].quantity).toBe(10);
    expect(r.items[0].costPrice).toBe(12.5);
  });

  it("agrupa itens repetidos (cProd+cEAN+xProd) somando quantidades", () => {
    const r = parseNfeXml(fx("repeated-items.xml"));
    expect(r.meta.itemCount).toBe(2);
    expect(r.meta.groupedCount).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].quantity).toBe(5);
    expect(r.items[0].costPrice).toBe(45.9); // 229.50 / 5
    expect(r.items[0].lineTotal).toBe(229.5);
  });

  it("mantém produtos distintos separados", () => {
    const r = parseNfeXml(fx("multi-item.xml"));
    expect(r.meta.groupedCount).toBe(2);
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(byName["AMORTECEDOR DIANTEIRO"].quantity).toBe(4);
    expect(byName["AMORTECEDOR DIANTEIRO"].costPrice).toBe(200);
    expect(byName["BATERIA 60AH"].quantity).toBe(2);
    expect(byName["BATERIA 60AH"].costPrice).toBe(300);
  });

  it("trunca name em 60 chars mas preserva fullName", () => {
    const r = parseNfeXml(fx("long-name.xml"));
    const item = r.items[0];
    expect(item.fullName.length).toBeGreaterThan(60);
    expect(item.name.length).toBe(60);
    expect(item.name).toBe(item.fullName.slice(0, 60));
  });

  it("bloqueia XXE: rejeita XML com DOCTYPE/ENTITY", () => {
    expect(() => parseNfeXml(fx("doctype-xxe.xml"))).toThrow(NfeParseError);
    expect(() => parseNfeXml(fx("doctype-xxe.xml"))).toThrow(/DOCTYPE/i);
  });

  it("rejeita modelo diferente de 55 (ex.: 65)", () => {
    expect(() => parseNfeXml(fx("model-65.xml"))).toThrow(NfeParseError);
    expect(() => parseNfeXml(fx("model-65.xml"))).toThrow(/modelo 55/i);
  });

  it("rejeita nota sem itens", () => {
    expect(() => parseNfeXml(fx("no-items.xml"))).toThrow(/sem itens/i);
  });

  it("rejeita conteúdo que não é NF-e (XML malformado/genérico)", () => {
    expect(() => parseNfeXml(fx("not-nfe.xml"))).toThrow(NfeParseError);
  });

  it("rejeita XML vazio ou só espaços", () => {
    expect(() => parseNfeXml("")).toThrow(NfeParseError);
    expect(() => parseNfeXml("   ")).toThrow(/vazio/i);
  });

  it("erros de parse carregam statusCode 400 para a rota mapear", () => {
    try {
      parseNfeXml("");
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect(e).toBeInstanceOf(NfeParseError);
      expect((e as NfeParseError).statusCode).toBe(400);
    }
  });
});
