import { describe, it, expect } from "vitest";

import { DanfeNfcePdfService } from "../../app/fiscal/generators/danfe-nfce-pdf.service";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

// Smoke do cupom DANFE NFC-e (80mm, pdf-lib + QR via pacote qrcode).

const svc = new DanfeNfcePdfService();

function input65(overrides: Partial<Parameters<DanfeNfcePdfService["generate"]>[0]> = {}) {
  return {
    draft: makeDraft({
      modelo: "65",
      numero: 123,
      pagamentosJson: [
        { meio: "PIX", valor: 60 },
        { meio: "DINHEIRO", valor: 40 },
      ] as any,
      itens: [
        makeItem({ descricao: "PECA A", valorTotal: 60, valorUnitario: 60 }),
        makeItem({
          id: "i2",
          numero: 2,
          descricao: "PECA B",
          valorTotal: 40,
          valorUnitario: 40,
        }),
      ],
    }),
    config: makeConfig(),
    chaveAcesso: "4".repeat(44),
    protocolo: "342260000000001",
    dataAutorizacao: new Date("2026-07-17T12:00:00-03:00"),
    qrCode:
      "https://hom.sat.sef.sc.gov.br/nfce/consulta?p=" +
      "4".repeat(44) +
      "|2|2|1|" +
      "A".repeat(40),
    urlChave: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
    ...overrides,
  };
}

describe("DanfeNfcePdfService.generate", () => {
  it("gera PDF válido (%PDF) com QR", async () => {
    const bytes = await svc.generate(input65());
    expect(bytes.byteLength).toBeGreaterThan(500);
    const head = Buffer.from(bytes.slice(0, 5)).toString("utf8");
    expect(head).toBe("%PDF-");
  });

  it("sem QR (fallback Focus) também gera PDF", async () => {
    const bytes = await svc.generate(
      input65({ qrCode: null, urlChave: null }),
    );
    const head = Buffer.from(bytes.slice(0, 5)).toString("utf8");
    expect(head).toBe("%PDF-");
  });

  it("consumidor não identificado (sem dest) não quebra", async () => {
    const i = input65();
    (i.draft as any).destinatarioJson = null;
    const bytes = await svc.generate(i);
    expect(Buffer.from(bytes.slice(0, 5)).toString("utf8")).toBe("%PDF-");
  });
});
