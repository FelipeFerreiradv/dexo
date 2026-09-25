import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

// Contrato HTTP do DANFE de nota CANCELADA — download (tela, PDV) e anexo do
// e-mail. Regressão de suporte da DLS (25/09/2026): o DANFE da NF-e 716, cancelada,
// saía idêntico ao de nota válida e a cliente quase cancelou a nota certa (717).
//
// O que NÃO pode mudar: nota que não está cancelada recebe exatamente os mesmos
// bytes de antes, sem nem consultar a auditoria.

const TENANT = "tenant-dls";
const db = vi.hoisted(() => ({
  nfeEmitida: { findFirst: vi.fn() },
  nfeAuditLog: { findFirst: vi.fn() },
}));
const enviados = vi.hoisted(() => [] as Array<{ to: string; attachments: Array<{ filename: string; content: Buffer }> }>);

vi.mock("../../app/lib/prisma", () => ({ default: db }));
vi.mock("@/app/lib/prisma", () => ({ default: db }));
vi.mock("../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => {
    request.user = { id: "colaborador-1", dataOwnerId: TENANT };
  },
}));
vi.mock("../../app/fiscal/generators/load-avatar", () => ({ loadTenantAvatar: async () => null }));
vi.mock("../../app/services/email.service", () => ({
  EmailService: class {
    async send(m: any) {
      enviados.push(m);
    }
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import { DANFE_CANCELADA_SEM_CARIMBO, fiscalRoutes } from "../../app/routes/fiscal.routes";
import { FiscalStorageService } from "../../app/fiscal/storage/fiscal-storage.service";
import { NfeRepository } from "../../app/repositories/nfe.repository";
import { DanfePdfService } from "../../app/fiscal/generators/danfe-pdf.service";
import { DanfeNfcePdfService } from "../../app/fiscal/generators/danfe-nfce-pdf.service";
import { NfeXmlBuilderSefazService } from "../../app/fiscal/sefaz/nfe-xml-builder-sefaz.service";
import { makeConfig, makeDraft, makeItem } from "./__helpers__/test-draft";

async function textos(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams: unknown[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) streams.push(doc.context.lookup(contents.get(i)));
    } else if (contents) streams.push(contents);
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const raw = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) out.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
  }
  return out;
}

const builder = new NfeXmlBuilderSefazService();
function xmlAutorizado(): string {
  const out = builder.build({
    draft: makeDraft({ itens: [makeItem(), makeItem({ codigo: "P2", descricao: "OUTRO ITEM" })] }),
    config: makeConfig(),
    numero: 716,
    dhEmi: new Date("2026-09-25T09:30:00-03:00"),
    cNF: "87654321",
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">',
    out.xml.replace(/^<\?xml[^?]*\?>\s*/, ""),
    '<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb>',
    `<chNFe>${out.chaveAcesso}</chNFe>`,
    "<dhRecbto>2026-09-25T09:32:34-03:00</dhRecbto><nProt>242260455399718</nProt>",
    "<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>",
  ].join("");
}

const XML_PATH = "/storage/tenant-dls/xml-autorizado/nfe-716.xml";
const PDF_PATH = "/storage/tenant-dls/danfe/nfe-716.pdf";
const EVENTO_CANCELADA = {
  createdAt: new Date("2026-09-25T13:07:47Z"),
  detalhes: { justificativa: "emissao incorreta", protocolo: "242260455490192" },
};

let app: FastifyInstance;
let arquivos: Map<string, Buffer>;
let pdfGuardado: Buffer;
let cupomGuardado: Buffer;
let xml: string;

function nota(over: Record<string, unknown> = {}) {
  return {
    id: "nfe-716",
    numero: 716,
    serie: 1,
    modelo: "55",
    status: "AUTHORIZED",
    chaveAcesso: "4".repeat(44),
    danfePdfPath: PDF_PATH,
    xmlAutorizadoPath: XML_PATH,
    xmlOriginalPath: null,
    ...over,
  };
}

beforeAll(async () => {
  xml = xmlAutorizado();
  // O PDF "guardado na autorização" — gerado no layout legado, como as notas antigas.
  pdfGuardado = Buffer.from(
    await new DanfePdfService().generate(makeDraft({ itens: [makeItem()] }), makeConfig(), "4".repeat(44), "242260455399718"),
  );
  cupomGuardado = Buffer.from(
    await new DanfeNfcePdfService().generate({
      draft: makeDraft({ modelo: "65", numero: 123, pagamentosJson: [{ meio: "PIX", valor: 100 }] as any, itens: [makeItem()] }),
      config: makeConfig(),
      chaveAcesso: "4".repeat(44),
      protocolo: "342260000000001",
      dataAutorizacao: new Date("2026-07-17T12:00:00-03:00"),
      qrCode: "https://hom.sat.sef.sc.gov.br/nfce/consulta?p=" + "4".repeat(44) + "|2|2|1|" + "A".repeat(40),
      urlChave: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
    } as any),
  );
  app = Fastify();
  await app.register(fiscalRoutes, { prefix: "/fiscal" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

let salvarDanfe: MockInstance;
let auditoria: MockInstance;
beforeEach(() => {
  arquivos = new Map([
    [XML_PATH, Buffer.from(xml, "utf8")],
    [PDF_PATH, Buffer.from(pdfGuardado)],
  ]);
  vi.spyOn(FiscalStorageService.prototype, "readFile").mockImplementation(async (p: string) => arquivos.get(p) ?? null);
  salvarDanfe = vi.spyOn(FiscalStorageService.prototype, "saveDanfePdf");
  auditoria = vi.spyOn(NfeRepository.prototype, "addAuditLog").mockResolvedValue(undefined as never);
  db.nfeEmitida.findFirst.mockReset();
  db.nfeAuditLog.findFirst.mockReset();
  db.nfeAuditLog.findFirst.mockResolvedValue(EVENTO_CANCELADA);
  enviados.length = 0;
  vi.stubEnv("EMAIL_ENABLED", "true");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const baixar = () => app.inject({ method: "GET", url: "/fiscal/nfe/nfe-716/danfe" });

describe("GET /fiscal/nfe/:id/danfe — nota NÃO cancelada fica byte a byte como antes", () => {
  it("PDF guardado (sem re-render): devolve exatamente os bytes do arquivo, sem consultar a auditoria", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota());
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(pdfGuardado)).toBe(true);
    expect(db.nfeAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it("re-render do XML: devolve exatamente o que o renderer gera (relógio congelado)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    db.nfeEmitida.findFirst.mockResolvedValue(nota());
    const esperado = Buffer.from(await new DanfePdfService().generateFromXml(xml, null));
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(esperado)).toBe(true);
    expect(await textos(res.rawPayload)).not.toContain("NF-e CANCELADA");
    expect(db.nfeAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it("só CANCELLED é carimbado: qualquer outro status devolve o arquivo intacto", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    for (const status of ["SENDING", "REJECTED", "INUTILIZED", "DRAFT", "cancelled", "CANCELADA"]) {
      db.nfeEmitida.findFirst.mockResolvedValue(nota({ status }));
      const res = await baixar();
      expect(res.statusCode, status).toBe(200);
      expect(Buffer.from(res.rawPayload).equals(pdfGuardado), status).toBe(true);
    }
    expect(db.nfeAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it("conteúdo que nem é PDF continua saindo como sempre saiu (nada tenta lê-lo)", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    arquivos.set(PDF_PATH, Buffer.from("conteudo legado qualquer"));
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "AUTHORIZED" }));
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("conteudo legado qualquer");
  });
});

describe("GET /fiscal/nfe/:id/danfe — nota CANCELADA sai carimbada", () => {
  it("PDF guardado: carimbado com data e protocolo; o arquivo em disco não é tocado", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    const noDisco = Buffer.from(arquivos.get(PDF_PATH)!);
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const t = await textos(res.rawPayload);
    expect(t).toContain("NF-e CANCELADA");
    expect(t).toContain("Cancelamento registrado em 25/09/2026 10:07");
    expect(t).toContain("Protocolo de cancelamento 242260455490192");
    expect(t).toContain("Este documento não tem valor fiscal");
    expect(arquivos.get(PDF_PATH)!.equals(noDisco)).toBe(true);
    expect(salvarDanfe).not.toHaveBeenCalled();
  });

  it("re-render do XML: também carimbado, com o conteúdo do DANFE preservado", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "true");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    const t = await textos(res.rawPayload);
    expect(t).toContain("NF-e CANCELADA");
    expect(t).toContain("OUTRO ITEM");
  });

  it("a auditoria é lida no escopo do tenant e da nota, pelo evento CANCELADA mais recente", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    await baixar();
    expect(db.nfeEmitida.findFirst.mock.calls[0][0].where).toEqual({ id: "nfe-716", userId: TENANT });
    expect(db.nfeAuditLog.findFirst).toHaveBeenCalledTimes(1);
    const q = db.nfeAuditLog.findFirst.mock.calls[0][0];
    expect(q.where).toEqual({ nfeId: "nfe-716", userId: TENANT, evento: "CANCELADA" });
    expect(q.orderBy).toEqual({ createdAt: "desc" });
  });

  it("sem evento de cancelamento na auditoria: a marca sai, sem data nem protocolo, pedindo para conferir", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    db.nfeAuditLog.findFirst.mockResolvedValue(null);
    const t = await textos((await baixar()).rawPayload);
    expect(t).toContain("NF-e CANCELADA");
    expect(t).toContain("Confira a situação pela chave de acesso");
    expect(t).not.toContain("Este documento não tem valor fiscal");
    expect(t.some((x) => x.startsWith("Cancelamento registrado") || x.startsWith("Protocolo de cancelamento"))).toBe(false);
  });

  it("cancelamento SEM protocolo (Focus V1 aceita qualquer HTTP 200): não afirma 'sem valor fiscal'", async () => {
    // A SEFAZ pode ter RECUSADO (erro_cancelamento) e a nota seguir autorizada; o Dexo
    // gravou CANCELLED com protocolo null. O DANFE não pode declarar o que não se provou.
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    db.nfeAuditLog.findFirst.mockResolvedValue({ createdAt: EVENTO_CANCELADA.createdAt, detalhes: { protocolo: null, justificativa: "x" } });
    const t = await textos((await baixar()).rawPayload);
    expect(t).toContain("NF-e CANCELADA");
    expect(t).toContain("Cancelamento registrado em 25/09/2026 10:07");
    expect(t).toContain("Sem protocolo de cancelamento da SEFAZ");
    expect(t).not.toContain("Este documento não tem valor fiscal");
  });

  it("falha ao LER a auditoria não impede a marca", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    db.nfeAuditLog.findFirst.mockRejectedValue(new Error("pool esgotado"));
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    expect(await textos(res.rawPayload)).toContain("NF-e CANCELADA");
  });

  it("protocolo gravado como número também aparece", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    db.nfeAuditLog.findFirst.mockResolvedValue({ createdAt: EVENTO_CANCELADA.createdAt, detalhes: { protocolo: 242260455490192 } });
    expect(await textos((await baixar()).rawPayload)).toContain("Protocolo de cancelamento 242260455490192");
  });

  it("se não der para carimbar, NÃO entrega o PDF sem a marca: 500 dizendo por quê", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    arquivos.set(PDF_PATH, Buffer.from("arquivo corrompido"));
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED", xmlAutorizadoPath: null }));
    const res = await baixar();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: DANFE_CANCELADA_SEM_CARIMBO });
    expect(res.body).not.toContain("arquivo corrompido");
  });

  it("cupom NFC-e cancelado (impressão do PDV usa esta rota): 'NFC-e CANCELADA'", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    arquivos.set(PDF_PATH, Buffer.from(cupomGuardado));
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED", modelo: "65", xmlAutorizadoPath: null }));
    const res = await baixar();
    expect(res.statusCode).toBe(200);
    const t = await textos(res.rawPayload);
    expect(t).toContain("NFC-e CANCELADA");
    expect(t).not.toContain("NF-e CANCELADA");
  });

  it("nota sem DANFE gravado continua 404, cancelada ou não", async () => {
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED", danfePdfPath: null }));
    expect((await baixar()).statusCode).toBe(404);
  });
});

describe("POST /fiscal/nfe/:id/resend-email — o anexo segue a mesma regra", () => {
  const enviar = () =>
    app.inject({ method: "POST", url: "/fiscal/nfe/nfe-716/resend-email", payload: { email: "compras@disauto.com.br" } });

  it("nota autorizada: anexo idêntico ao arquivo, auditoria e mensagem de sempre", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota());
    const res = await enviar();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, mensagem: "E-mail enviado para compras@disauto.com.br" });
    const anexos = enviados[0].attachments;
    expect(anexos.map((a) => a.filename)).toEqual(["nfe-1-716.xml", "danfe-1-716.pdf"]);
    expect(Buffer.from(anexos[1].content).equals(pdfGuardado)).toBe(true);
    expect(auditoria).toHaveBeenCalledWith("nfe-716", TENANT, "XML_REENVIADO", {
      email: "compras@disauto.com.br",
      attachmentCount: 2,
    });
    expect(db.nfeAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it("nota cancelada: o DANFE anexado sai carimbado", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED" }));
    const res = await enviar();
    expect(res.statusCode).toBe(200);
    const pdf = enviados[0].attachments.find((a) => a.filename.endsWith(".pdf"))!;
    const t = await textos(pdf.content);
    expect(t).toContain("NF-e CANCELADA");
    expect(t).toContain("Protocolo de cancelamento 242260455490192");
  });

  it("nota cancelada sem como carimbar: vai só o XML, e a resposta e a auditoria dizem que o DANFE ficou de fora", async () => {
    vi.stubEnv("NEXT_PUBLIC_DANFE_OFICIAL_ENABLED", "false");
    arquivos.set(PDF_PATH, Buffer.from("arquivo corrompido"));
    db.nfeEmitida.findFirst.mockResolvedValue(nota({ status: "CANCELLED", xmlAutorizadoPath: null, xmlOriginalPath: XML_PATH }));
    const res = await enviar();
    expect(res.statusCode).toBe(200);
    expect(res.json().mensagem).toMatch(/sem o DANFE/);
    expect(res.json().danfeOmitido).toBe(true);
    expect(enviados[0].attachments.map((a) => a.filename)).toEqual(["nfe-1-716.xml"]);
    expect(auditoria).toHaveBeenCalledWith("nfe-716", TENANT, "XML_REENVIADO", {
      email: "compras@disauto.com.br",
      attachmentCount: 1,
      danfeOmitido: "CANCELADA_SEM_CARIMBO",
    });
  });
});
