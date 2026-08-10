import { beforeEach, describe, expect, it, vi } from "vitest";

// O resolvedor de provedor é injetado: assim este spec não depende do `.env` da
// máquina, que tem provedor de verdade configurado.
let provedorDeImagem: any = null;
vi.mock("../app/ai/core/provider", async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    resolveAiProvider: (cap: string) =>
      cap === "imagem" ? provedorDeImagem : real.resolveAiProvider(cap),
  };
});

import {
  anexosDisponiveis,
  classificarAnexo,
  imagemDisponivel,
  lerAnexo,
  mensagemDeFalhaDeAnexo,
} from "../app/ai/anexo/leitura.service";
import { AI_CONSTANTS } from "../app/ai/core/ai-constants";

// ===========================================================================
// A leitura de um anexo. Fase 8.
//
// ⭐ O DESENHO QUE ESTE SPEC PROTEGE: ler não é perguntar. Nada aqui responde
// nada — devolve TEXTO, que o lojista confere antes de mandar a pergunta.
//
// E a regra que separa esta fase da anterior: SÓ O QUE CUSTA É COBRADO. Imagem
// chama modelo e é `pago: true`; XML de NF-e é lido localmente pelo
// `parseNfeXml` e é `pago: false`.
// ===========================================================================

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x41),
]);

function notaFiscal(itens: string, numero = "12345") {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<nfeProc><NFe><infNFe>` +
      `<ide><mod>55</mod><nNF>${numero}</nNF></ide>` +
      `<emit><xNome>DISTRIBUIDORA SAO JORGE LTDA</xNome></emit>` +
      itens +
      `</infNFe></NFe></nfeProc>`,
  );
}

const item = (nome: string, q: number, vUn: number, cProd = "P1") =>
  `<det><prod><cProd>${cProd}</cProd><cEAN>SEM GTIN</cEAN>` +
  `<xProd>${nome}</xProd><uCom>UN</uCom><qCom>${q}</qCom>` +
  `<vUnCom>${vUn}</vUnCom><vProd>${(q * vUn).toFixed(2)}</vProd></prod></det>`;

const NOTA = notaFiscal(item("PARAFUSO RODA M12", 10, 2.5));

const provedorQueLe = (conteudo: string) => ({
  name: "gemini",
  model: "m",
  describeImage: vi.fn().mockResolvedValue({
    ok: true,
    content: conteudo,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    provider: "gemini",
    model: "m",
    latencyMs: 1,
  }),
});

beforeEach(() => {
  provedorDeImagem = null;
});

describe("classificarAnexo", () => {
  it("arquivo vazio, gigante ou irreconhecível não passa da porta", () => {
    expect(classificarAnexo(Buffer.alloc(0))).toEqual({
      ok: false,
      motivo: "vazio",
    });
    expect(
      classificarAnexo(
        Buffer.alloc(AI_CONSTANTS.MAX_ANEXO_BYTES + 1),
        "image/jpeg",
      ),
    ).toEqual({ ok: false, motivo: "grande_demais" });
    expect(
      classificarAnexo(Buffer.from("%PDF-1.7 blablabla aqui"), "image/jpeg"),
    ).toEqual({ ok: false, motivo: "formato_invalido" });
  });

  it("⭐ o XML é caminho GRATUITO — classificado sem provedor nenhum", () => {
    provedorDeImagem = null;
    const r = classificarAnexo(NOTA, "text/xml");
    expect(r).toEqual({ ok: true, formato: "xml", tipo: "xml-nfe", pago: false });
  });

  it("⭐ a imagem é caminho PAGO", () => {
    provedorDeImagem = provedorQueLe("um cubo de roda");
    const r = classificarAnexo(JPEG, "image/jpeg");
    expect(r).toEqual({ ok: true, formato: "jpeg", tipo: "imagem", pago: true });
  });

  it("⚠️ imagem sem leitor é `indisponivel`, não `formato_invalido`", () => {
    // O arquivo está certo; o servidor é que não sabe ler. A UI já não deveria
    // ter oferecido `.jpg`, mas um `curl` chega aqui de qualquer jeito — e a
    // mensagem tem que dizer a verdade.
    provedorDeImagem = null;
    expect(classificarAnexo(JPEG, "image/jpeg")).toEqual({
      ok: false,
      motivo: "indisponivel",
    });
  });

  it("recusa imagem cujo rótulo não bate com os bytes", () => {
    provedorDeImagem = provedorQueLe("x");
    expect(classificarAnexo(JPEG, "image/png")).toEqual({
      ok: false,
      motivo: "formato_invalido",
    });
  });
});

describe("lerAnexo — XML de NF-e", () => {
  it("lê a nota sem chamar provedor nenhum", async () => {
    provedorDeImagem = null;
    const r = await lerAnexo({ buffer: NOTA, formato: "xml" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tipo).toBe("xml-nfe");
    expect(r.leitura).toContain("12345");
    expect(r.leitura).toContain("DISTRIBUIDORA SAO JORGE");
    expect(r.leitura).toContain("PARAFUSO RODA M12");
    // Os números saem do XML, não de inferência.
    expect(r.leitura).toContain("25,00");
    expect(r.resumo).toContain("12345");
  });

  it("XML que não é NF-e devolve o motivo LEGÍVEL do parser", async () => {
    const r = await lerAnexo({
      buffer: Buffer.from(`<?xml version="1.0"?><catalogo><x/></catalogo>`),
      formato: "xml",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("xml_invalido");
    // O texto vem do NfeParseError e é o que o lojista lê — saber QUAL nota não
    // serve é a diferença entre resolver sozinho e abrir chamado.
    expect(r.detalhe).toMatch(/NF-e/i);
    expect(mensagemDeFalhaDeAnexo(r.motivo, r.detalhe)).toBe(r.detalhe);
  });

  it("⭐ XXE não passa: DOCTYPE é recusado antes de qualquer parsing", async () => {
    const r = await lerAnexo({
      buffer: Buffer.from(
        `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><nfeProc/>`,
      ),
      formato: "xml",
    });
    expect(r.ok).toBe(false);
  });

  it("engole o BOM do Windows em vez de recusar a nota por causa dele", async () => {
    const comBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), NOTA]);
    const r = await lerAnexo({ buffer: comBom, formato: "xml" });
    expect(r.ok).toBe(true);
  });

  it("⭐ nota grande: o corte é DECLARADO, nunca silencioso", async () => {
    const muitos = Array.from({ length: 60 }, (_, i) =>
      item(`PECA ${i}`, 1, 10, `P${i}`),
    ).join("");
    const r = await lerAnexo({ buffer: notaFiscal(muitos), formato: "xml" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Sem a linha de aviso, o modelo somaria 40 itens e apresentaria como se
    // fosse a nota inteira.
    expect(r.leitura).toMatch(/e mais 20 produto/i);
    // O total do cabeçalho continua sendo o da NOTA TODA, não o dos 40.
    expect(r.leitura).toContain("60 produto(s) distinto(s)");
  });

  it("⭐ o corte cabe DENTRO do teto, com o aviso incluído", async () => {
    // ⚠️ ISTO JÁ ESTAVA ERRADO: o corte era feito no teto e o aviso acrescentado
    // DEPOIS, produzindo `MAX + 29`. A leitura volta ao servidor no corpo do
    // `/ai/chat`, onde `lerAnexosDoCorpo` faz `slice(0, MAX)` — e a fatia comia
    // exatamente o aviso. O modelo receberia uma nota truncada SEM SABER que
    // foi truncada, e somaria 40 dos 60 itens como se fossem a nota inteira.
    const enormes = Array.from({ length: 40 }, (_, i) =>
      item(`${"PECA MUITO DESCRITIVA ".repeat(20)}${i}`, 1, 10, `P${i}`),
    ).join("");
    const r = await lerAnexo({ buffer: notaFiscal(enormes), formato: "xml" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.leitura.length).toBeLessThanOrEqual(
      AI_CONSTANTS.MAX_ANEXO_LEITURA_CHARS,
    );
    expect(r.leitura).toContain("[leitura cortada por tamanho]");
    // O aviso SOBREVIVE à viagem de volta pelo corpo do /ai/chat.
    expect(
      r.leitura.slice(0, AI_CONSTANTS.MAX_ANEXO_LEITURA_CHARS),
    ).toContain("[leitura cortada por tamanho]");
  });

  it("⭐ quantidade FRACIONÁRIA da nota sai correta, não arredondada", async () => {
    // ⚠️ `NfeParsedItem.quantity` é `Math.round(soma de qCom)` — correto lá,
    // porque aquele campo vira `stock`, que é inteiro. Aqui não: 0,5 kg de
    // aditivo virava "1 KG", com o total certo ao lado, o que faz o erro
    // parecer centavo de arredondamento em vez do dobro da quantidade.
    const meioQuilo = notaFiscal(
      `<det><prod><cProd>A1</cProd><cEAN>SEM GTIN</cEAN>` +
        `<xProd>ADITIVO RADIADOR</xProd><uCom>KG</uCom><qCom>0.5</qCom>` +
        `<vUnCom>100.00</vUnCom><vProd>50.00</vProd></prod></det>`,
    );
    const r = await lerAnexo({ buffer: meioQuilo, formato: "xml" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.leitura).toContain("0,5 KG");
    expect(r.leitura).not.toContain("1 KG");
  });

  it("quantidade inteira continua saindo sem casas decimais", async () => {
    const r = await lerAnexo({ buffer: NOTA, formato: "xml" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.leitura).toContain("10 UN");
    expect(r.leitura).not.toMatch(/10,0+ UN/);
  });

  it("item de custo ZERO (bonificação) não estoura na divisão", async () => {
    const brinde = notaFiscal(
      `<det><prod><cProd>B1</cProd><cEAN>SEM GTIN</cEAN>` +
        `<xProd>BRINDE</xProd><uCom>UN</uCom><qCom>2</qCom>` +
        `<vUnCom>0</vUnCom><vProd>0</vProd></prod></det>`,
    );
    const r = await lerAnexo({ buffer: brinde, formato: "xml" });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.leitura).toContain("BRINDE");
    expect(r.leitura).not.toMatch(/NaN|Infinity/);
  });
});

describe("lerAnexo — imagem", () => {
  it("devolve a leitura e um resumo de uma linha", async () => {
    const p = provedorQueLe(
      "Cubo de roda dianteiro.\nMarca visível: SKF.\nCódigo estampado: VKBA 3660.",
    );
    const r = await lerAnexo({ buffer: JPEG, formato: "jpeg", provider: p });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tipo).toBe("imagem");
    expect(r.leitura).toContain("VKBA 3660");
    expect(r.resumo).toBe("Cubo de roda dianteiro.");
  });

  it("⭐ vai o mimetype CANÔNICO dos bytes, nunca o que o cliente declarou", async () => {
    const p = provedorQueLe("peça");
    await lerAnexo({ buffer: JPEG, formato: "jpeg", provider: p });
    expect(p.describeImage).toHaveBeenCalledWith(JPEG, "image/jpeg");
  });

  it("foto ilegível é `sem_leitura` — caso normal, e não erro de sistema", async () => {
    const r = await lerAnexo({
      buffer: JPEG,
      formato: "jpeg",
      provider: provedorQueLe("   \n  "),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("sem_leitura");
  });

  it("falha do provedor vira `erro_provedor`, sem vazar detalhe técnico", async () => {
    const r = await lerAnexo({
      buffer: JPEG,
      formato: "jpeg",
      provider: {
        name: "gemini",
        model: "m",
        describeImage: async () => ({ ok: false, reason: "timeout" }),
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("erro_provedor");
    // A mensagem que o usuário lê não cita provedor, modelo nem motivo técnico.
    const msg = mensagemDeFalhaDeAnexo(r.motivo, r.detalhe);
    expect(msg).not.toMatch(/gemini|timeout|deepseek|model/i);
  });

  it("provedor sem `describeImage` degrada em vez de estourar", async () => {
    const r = await lerAnexo({
      buffer: JPEG,
      formato: "jpeg",
      provider: { name: "deepseek", model: "v4" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("indisponivel");
  });

  it("leitura gigante do modelo é cortada antes de virar contexto eterno", async () => {
    const r = await lerAnexo({
      buffer: JPEG,
      formato: "jpeg",
      provider: provedorQueLe("A".repeat(50_000)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.leitura.length).toBeLessThanOrEqual(
      AI_CONSTANTS.MAX_ANEXO_LEITURA_CHARS + 40,
    );
  });
});

describe("anexosDisponiveis", () => {
  it("⭐ sem modelo de visão, sobra o XML — e o clipe continua útil", () => {
    provedorDeImagem = null;
    expect(imagemDisponivel()).toBe(false);
    expect(anexosDisponiveis()).toEqual([".xml"]);
  });

  it("com modelo de visão, entram as fotos", () => {
    provedorDeImagem = provedorQueLe("x");
    expect(imagemDisponivel()).toBe(true);
    const lista = anexosDisponiveis();
    expect(lista).toEqual([".jpg", ".jpeg", ".png", ".webp", ".xml"]);
    // Sem repetição: o `accept` do navegador não gosta.
    expect(new Set(lista).size).toBe(lista.length);
  });

  it("provedor sem `describeImage` (DeepSeek) não habilita foto", () => {
    provedorDeImagem = { name: "deepseek", model: "v4" };
    expect(anexosDisponiveis()).toEqual([".xml"]);
  });
});

describe("mensagens de falha", () => {
  it("⭐ nenhuma mensagem vaza provedor, modelo, chave ou nome de arquivo interno", () => {
    const motivos = [
      "indisponivel",
      "formato_invalido",
      "grande_demais",
      "vazio",
      "sem_leitura",
      "erro_provedor",
    ] as const;
    for (const m of motivos) {
      const texto = mensagemDeFalhaDeAnexo(m);
      expect(texto.length).toBeGreaterThan(10);
      expect(texto).not.toMatch(/gemini|deepseek|api|key|token|undefined/i);
    }
  });
});
