import { describe, expect, it } from "vitest";

import {
  MENSAGEM_PADRAO_DOWNLOAD,
  lerMensagemErroDownload,
  mensagemErroDownload,
  nomeArquivoDownload,
} from "../../app/notas-fiscais/lib/nfe-download-arquivo";

// O download do XML/DANFE nas três telas fazia `if (!res.ok) return;`: o clique
// não fazia nada. Depois do #376, o DANFE de nota CANCELADA que não pôde ser
// marcado responde 500 com a frase que manda usar o XML — e o colaborador sem a
// permissão fiscal recebe 403 PAGE_FORBIDDEN. As duas frases precisam chegar ao
// operador. E o PDF da cancelada precisa se distinguir na pasta de downloads.

const FRASE_CANCELADA =
  "Esta nota está CANCELADA e não foi possível marcar o DANFE como cancelado. Use o XML da nota.";
const FRASE_403 = "Seu acesso a esta área foi removido pelo administrador da conta.";

describe("mensagemErroDownload", () => {
  it("frase padrão é clara e em português", () => {
    expect(MENSAGEM_PADRAO_DOWNLOAD).toBe("Não foi possível baixar o arquivo. Tente de novo.");
  });

  it("JSON com `error` (o 500 da nota cancelada sem carimbo): a frase do servidor", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: FRASE_CANCELADA }))).toBe(FRASE_CANCELADA);
  });

  it("JSON com `message` (o 403 PAGE_FORBIDDEN): a frase do servidor", () => {
    expect(mensagemErroDownload(JSON.stringify({ message: FRASE_403, code: "PAGE_FORBIDDEN", pageId: "fiscal" }))).toBe(FRASE_403);
  });

  it("`error` manda mais que `message` (formato do error handler global)", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: "Erro interno do servidor", message: "detalhe", requestId: "r1" }))).toBe(
      "Erro interno do servidor",
    );
  });

  it("`error` vazio ou que não é texto cai para `message`", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: "   ", message: FRASE_403 }))).toBe(FRASE_403);
    expect(mensagemErroDownload(JSON.stringify({ error: { x: 1 }, message: FRASE_403 }))).toBe(FRASE_403);
  });

  it("JSON sem nenhuma das duas: frase padrão", () => {
    expect(mensagemErroDownload(JSON.stringify({ code: "X" }))).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload(JSON.stringify({ error: "", message: "" }))).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload(JSON.stringify({ error: 500, message: null }))).toBe(MENSAGEM_PADRAO_DOWNLOAD);
  });

  it("corpo que não é JSON (página de erro do proxy): frase padrão", () => {
    expect(mensagemErroDownload("<html><body>502 Bad Gateway</body></html>")).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload("{quebrado")).toBe(MENSAGEM_PADRAO_DOWNLOAD);
  });

  it("JSON que não é objeto: frase padrão", () => {
    expect(mensagemErroDownload(JSON.stringify("texto solto"))).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload(JSON.stringify([{ error: "x" }]))).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload("null")).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload("42")).toBe(MENSAGEM_PADRAO_DOWNLOAD);
  });

  it("corpo vazio ou ausente: frase padrão", () => {
    expect(mensagemErroDownload("")).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload("   ")).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload(null)).toBe(MENSAGEM_PADRAO_DOWNLOAD);
    expect(mensagemErroDownload(undefined)).toBe(MENSAGEM_PADRAO_DOWNLOAD);
  });
});

// O catch genérico das rotas de download responde `{ error: error.message }` cru:
// a mensagem do Prisma tem várias linhas, com o arquivo do servidor e o host do
// banco. Para a tela vai só a PRIMEIRA linha, sem espaços sobrando, até 200
// caracteres (a reticência conta). As frases curtas que o servidor escreve para
// o operador saem IDÊNTICAS.
describe("mensagemErroDownload — texto técnico cru não vai inteiro para a tela", () => {
  const PRISMA = [
    "",
    "Invalid `prisma.nfeEmitida.findFirst()` invocation in",
    "C:\\dexo\\app\\routes\\fiscal.routes.ts:1360:52",
    "",
    "  1357 const row = await (prisma as any).nfeEmitida.findFirst({",
    "Can't reach database server at `aws-0-sa-east-1.pooler.supabase.com:6543`",
  ].join("\n");

  it("frases conhecidas do servidor saem idênticas", () => {
    for (const frase of [
      FRASE_CANCELADA,
      FRASE_403,
      "DANFE nao disponivel",
      "XML nao disponivel",
      "NF-e nao encontrada",
      "Arquivo DANFE nao encontrado",
      "Arquivo XML nao encontrado",
      "Erro ao baixar DANFE",
      "Erro interno do servidor",
    ]) {
      expect(mensagemErroDownload(JSON.stringify({ error: frase }))).toBe(frase);
      expect(mensagemErroDownload(JSON.stringify({ message: frase }))).toBe(frase);
    }
    expect(mensagemErroDownload(JSON.stringify({ message: FRASE_403, code: "PAGE_FORBIDDEN", pageId: "fiscal", pageIds: ["fiscal", "pdv"] }))).toBe(FRASE_403);
  });

  it("várias linhas (mensagem do Prisma): só a primeira linha com texto", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: PRISMA }))).toBe(
      "Invalid `prisma.nfeEmitida.findFirst()` invocation in",
    );
    expect(mensagemErroDownload(JSON.stringify({ message: "Falhou\r\n    at readFile (node:fs:1)" }))).toBe("Falhou");
    expect(mensagemErroDownload(JSON.stringify({ error: "Falhou\r    em outra linha" }))).toBe("Falhou");
  });

  it("espaços sobrando (tab, espaço duplo, nas pontas) viram um espaço só", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: "  ENOENT:\tno such   file  " }))).toBe("ENOENT: no such file");
  });

  it("teto de 200 caracteres, reticência incluída; até 200 passa inteiro", () => {
    const d200 = "D".repeat(200);
    expect(mensagemErroDownload(JSON.stringify({ error: d200 }))).toBe(d200);
    const longa = mensagemErroDownload(JSON.stringify({ error: "E".repeat(201) }));
    expect(longa).toBe(`${"E".repeat(199)}…`);
    expect(Array.from(longa)).toHaveLength(200);
    const caminho = `ENOENT: no such file or directory, open '/var/app/uploads/${"x".repeat(400)}/danfe.pdf'`;
    const cortada = mensagemErroDownload(JSON.stringify({ error: caminho }));
    expect(Array.from(cortada).length).toBeLessThanOrEqual(200);
    expect(cortada.startsWith("ENOENT: no such file or directory, open '/var/app/uploads/xxx")).toBe(true);
    expect(cortada.endsWith("…")).toBe(true);
  });

  it("espaço bem na posição do corte não fica antes da reticência", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: `${"A".repeat(198)} ${"B".repeat(10)}` }))).toBe(`${"A".repeat(198)}…`);
  });

  it("o corte não parte um caractere fora do BMP ao meio", () => {
    const cortada = mensagemErroDownload(JSON.stringify({ error: "😀".repeat(250) }));
    expect(cortada).toBe(`${"😀".repeat(199)}…`);
  });

  it("`error` ainda manda mais que `message`, também quando o `error` é cru", () => {
    expect(mensagemErroDownload(JSON.stringify({ error: PRISMA, message: FRASE_403 }))).toBe(
      "Invalid `prisma.nfeEmitida.findFirst()` invocation in",
    );
  });

  it("pela resposta (lerMensagemErroDownload): o mesmo corte", async () => {
    await expect(lerMensagemErroDownload({ text: async () => JSON.stringify({ error: PRISMA }) })).resolves.toBe(
      "Invalid `prisma.nfeEmitida.findFirst()` invocation in",
    );
  });
});

describe("lerMensagemErroDownload", () => {
  it("lê o corpo da resposta e devolve a frase do servidor", async () => {
    await expect(lerMensagemErroDownload({ text: async () => JSON.stringify({ error: FRASE_CANCELADA }) })).resolves.toBe(FRASE_CANCELADA);
  });

  it("corpo ilegível (a leitura falha) não estoura: frase padrão", async () => {
    await expect(
      lerMensagemErroDownload({
        text: async () => {
          throw new Error("stream quebrado");
        },
      }),
    ).resolves.toBe(MENSAGEM_PADRAO_DOWNLOAD);
    await expect(lerMensagemErroDownload({} as { text(): Promise<string> })).resolves.toBe(MENSAGEM_PADRAO_DOWNLOAD);
  });
});

describe("nomeArquivoDownload", () => {
  it("nota autorizada: o nome de sempre, PDF e XML", () => {
    expect(nomeArquivoDownload("nfe-abc", "danfe", "AUTHORIZED")).toBe("nfe-abc.pdf");
    expect(nomeArquivoDownload("nfe-abc", "xml", "AUTHORIZED")).toBe("nfe-abc.xml");
    expect(nomeArquivoDownload("danfe-1-716", "danfe", "AUTHORIZED")).toBe("danfe-1-716.pdf");
  });

  it("nota cancelada: o PDF do DANFE ganha -CANCELADA antes da extensão", () => {
    expect(nomeArquivoDownload("nfe-abc", "danfe", "CANCELLED")).toBe("nfe-abc-CANCELADA.pdf");
    expect(nomeArquivoDownload("danfe-1-716", "danfe", "CANCELLED")).toBe("danfe-1-716-CANCELADA.pdf");
    expect(nomeArquivoDownload("cupom-4-2", "danfe", "CANCELLED")).toBe("cupom-4-2-CANCELADA.pdf");
  });

  it("XML da nota cancelada: SEM sufixo (o XML não é carimbado)", () => {
    expect(nomeArquivoDownload("nfe-abc", "xml", "CANCELLED")).toBe("nfe-abc.xml");
    expect(nomeArquivoDownload("nfe-1-716", "xml", "CANCELLED")).toBe("nfe-1-716.xml");
  });

  it("status ausente ou qualquer outro: o nome de sempre", () => {
    for (const status of [undefined, null, "", "REJECTED", "DRAFT", "INUTILIZED", "cancelled", "CANCELADA"]) {
      expect(nomeArquivoDownload("nfe-abc", "danfe", status)).toBe("nfe-abc.pdf");
    }
  });
});
