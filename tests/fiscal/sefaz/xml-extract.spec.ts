import { describe, it, expect } from "vitest";
import {
  extractTagValue,
  extractTagValueNs,
  extractIntValue,
  extractDateValue,
} from "../../../app/fiscal/sefaz/xml-extract";

describe("xml-extract — extractTagValue (sem namespace)", () => {
  it("extrai conteudo entre tags simples", () => {
    expect(extractTagValue("<a>hello</a>", "a")).toBe("hello");
  });

  it("retorna null quando a tag nao existe", () => {
    expect(extractTagValue("<a>hello</a>", "b")).toBeNull();
  });

  it("trim do whitespace", () => {
    expect(extractTagValue("<a>  hi  </a>", "a")).toBe("hi");
  });

  it("nao casa tag com prefixo de namespace", () => {
    expect(extractTagValue("<ns:cStat>107</ns:cStat>", "cStat")).toBeNull();
  });
});

describe("xml-extract — extractTagValueNs (com ou sem namespace)", () => {
  it("extrai tag sem prefixo", () => {
    expect(extractTagValueNs("<cStat>107</cStat>", "cStat")).toBe("107");
  });

  it("extrai tag com prefixo arbitrario", () => {
    expect(extractTagValueNs("<nfe:cStat>107</nfe:cStat>", "cStat")).toBe("107");
    expect(extractTagValueNs("<a-b:cStat>107</a-b:cStat>", "cStat")).toBe("107");
  });

  it("aceita atributos na tag de abertura", () => {
    const xml = '<cStat xmlns="http://example.com">107</cStat>';
    expect(extractTagValueNs(xml, "cStat")).toBe("107");
  });

  it("retorna null quando ausente", () => {
    expect(extractTagValueNs("<x>1</x>", "y")).toBeNull();
  });

  it("retorna a primeira ocorrencia", () => {
    const xml = "<cStat>107</cStat><cStat>108</cStat>";
    expect(extractTagValueNs(xml, "cStat")).toBe("107");
  });
});

describe("xml-extract — extractIntValue", () => {
  it("converte para numero", () => {
    expect(extractIntValue("<n>42</n>", "n")).toBe(42);
  });

  it("retorna null quando ausente", () => {
    expect(extractIntValue("<x>42</x>", "n")).toBeNull();
  });

  it("retorna null quando nao numerico", () => {
    expect(extractIntValue("<n>abc</n>", "n")).toBeNull();
  });
});

describe("xml-extract — extractDateValue", () => {
  it("converte ISO8601 para Date", () => {
    const xml = "<dhRecbto>2026-05-14T12:00:00-03:00</dhRecbto>";
    const date = extractDateValue(xml, "dhRecbto");
    expect(date).not.toBeNull();
    expect(date!.getUTCFullYear()).toBe(2026);
  });

  it("retorna null para data invalida", () => {
    expect(extractDateValue("<d>nao-e-data</d>", "d")).toBeNull();
  });
});
