import { describe, expect, it } from "vitest";
import {
  decideLocationScan,
  type ScanResolveData,
} from "../app/produtos/lib/location-scan-decision";
import type { LocationSelectItem } from "../app/produtos/lib/location-select-filter";

const LOC_ID = "cln1a2b3c4d5e6f7g8h9i0j1k";
const OTHER_ID = "clz9y8x7w6v5u4t3s2r1q0p1o";

function makeOption(over: Partial<LocationSelectItem> = {}): LocationSelectItem {
  return {
    id: LOC_ID,
    code: "A-01",
    fullPath: "Galpão 1 > Prateleira A > A-01",
    maxCapacity: 10,
    productsCount: 3,
    isFull: false,
    ...over,
  };
}

function makeResolved(
  over: Partial<NonNullable<ScanResolveData["location"]>> = {},
): ScanResolveData {
  return {
    kind: "location",
    location: {
      id: LOC_ID,
      code: "A-01",
      description: null,
      maxCapacity: 10,
      productsCount: 3,
      isFull: false,
      ...over,
    },
  };
}

describe("decideLocationScan — localização válida", () => {
  it("seleciona com fullPath vindo das options quando o id tem match", () => {
    expect(decideLocationScan(makeResolved(), [makeOption()], null)).toEqual({
      type: "select",
      id: LOC_ID,
      code: "A-01",
      fullPath: "Galpão 1 > Prateleira A > A-01",
    });
  });

  it("cai para o code quando o id não está nas options (recém-criada)", () => {
    const decision = decideLocationScan(
      makeResolved(),
      [makeOption({ id: OTHER_ID, code: "B-02", fullPath: "B-02" })],
      null,
    );
    expect(decision).toEqual({
      type: "select",
      id: LOC_ID,
      code: "A-01",
      fullPath: "A-01",
    });
  });

  it("options vazias → seleciona com fullPath = code", () => {
    expect(decideLocationScan(makeResolved(), [], null)).toEqual({
      type: "select",
      id: LOC_ID,
      code: "A-01",
      fullPath: "A-01",
    });
  });
});

describe("decideLocationScan — lotada (paridade com o combobox)", () => {
  it("rejeita lotada que não é a atualmente selecionada", () => {
    const decision = decideLocationScan(
      makeResolved({ isFull: true, productsCount: 10 }),
      [makeOption()],
      OTHER_ID,
    );
    expect(decision).toEqual({
      type: "reject",
      tone: "warning",
      message: 'Localização "A-01" está lotada (10/10).',
    });
  });

  it("rejeita lotada quando não há nada selecionado", () => {
    const decision = decideLocationScan(
      makeResolved({ isFull: true, productsCount: 10 }),
      [makeOption()],
      null,
    );
    expect(decision.type).toBe("reject");
  });

  it("aceita lotada quando é a já selecionada (isenção do editar)", () => {
    const decision = decideLocationScan(
      makeResolved({ isFull: true, productsCount: 10 }),
      [makeOption()],
      LOC_ID,
    );
    expect(decision.type).toBe("select");
  });

  it("isFull do servidor prevalece sobre option stale dizendo que há vaga", () => {
    const decision = decideLocationScan(
      makeResolved({ isFull: true, productsCount: 10 }),
      [makeOption({ isFull: false, productsCount: 3 })],
      null,
    );
    expect(decision.type).toBe("reject");
  });

  it("isFull=false do servidor prevalece sobre option stale dizendo lotada", () => {
    const decision = decideLocationScan(
      makeResolved({ isFull: false }),
      [makeOption({ isFull: true, productsCount: 10 })],
      null,
    );
    expect(decision.type).toBe("select");
  });
});

describe("decideLocationScan — outros kinds", () => {
  it("QR de produto → rejeita com mensagem específica", () => {
    expect(
      decideLocationScan(
        { kind: "product", product: { id: OTHER_ID } },
        [makeOption()],
        null,
      ),
    ).toEqual({
      type: "reject",
      tone: "error",
      message: "Esse é um QR de produto — escaneie o QR de uma localização.",
    });
  });

  it("unknown → rejeita como não reconhecido", () => {
    expect(decideLocationScan({ kind: "unknown" }, [makeOption()], null)).toEqual(
      {
        type: "reject",
        tone: "error",
        message: "QR não reconhecido como localização.",
      },
    );
  });
});

describe("decideLocationScan — 404 e entradas inválidas", () => {
  it("404 de localização usa o error do backend", () => {
    expect(
      decideLocationScan(
        { kind: "location", error: "Localização não encontrada" },
        [makeOption()],
        null,
      ),
    ).toEqual({
      type: "reject",
      tone: "error",
      message: "Localização não encontrada",
    });
  });

  it("kind location sem body e sem error usa fallback", () => {
    expect(decideLocationScan({ kind: "location" }, [], null)).toEqual({
      type: "reject",
      tone: "error",
      message: "Localização não encontrada",
    });
  });

  it("data null/undefined → rejeita como não reconhecido", () => {
    for (const data of [null, undefined]) {
      expect(decideLocationScan(data, [makeOption()], null)).toEqual({
        type: "reject",
        tone: "error",
        message: "QR não reconhecido como localização.",
      });
    }
  });

  it("resposta sem kind (corpo inesperado) → rejeita como não reconhecido", () => {
    expect(decideLocationScan({}, [makeOption()], null).type).toBe("reject");
  });
});
