import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../app/lib/prisma", () => ({ default: {} }));

import {
  MAX_KNOWLEDGE_CHUNKS,
  formatKnowledgeForPrompt,
  retrieveKnowledge,
  stripQuestionWords,
  tokenizeKnowledgeQuery,
} from "../app/ai/knowledge/retriever";

// ===========================================================================
// Recuperação na base de conhecimento.
//
// ⭐ A invariante nº 1 deste arquivo: o retriever NÃO recebe e NÃO usa
// `dataOwnerId`. A base é global (fala do produto, não do cliente), então não
// há coluna de tenant para filtrar — e é justamente por não haver que não
// existe query aqui que possa esquecer um `where`.
// ===========================================================================

/** Captura o SQL montado, sem banco. */
function fakeDb(rows: any[] = []) {
  const chamadas: any[] = [];
  return {
    chamadas,
    db: {
      $queryRaw: async (q: any) => {
        chamadas.push(q);
        return rows;
      },
    },
  };
}

/** Texto do SQL, tolerante à forma que a versão do Prisma expõe. */
function textoDoSql(q: any): string {
  return String(q?.sql ?? q?.text ?? q?.strings?.join?.(" ") ?? "");
}

const linha = (over: Partial<any> = {}) => ({
  docId: "produtos",
  heading: "Cadastrar uma peça nova",
  content: "conteudo",
  hits: 2,
  ...over,
});

describe("⭐ isolamento: a base é global e o retriever não conhece tenant", () => {
  it("o SQL não menciona userId, dataOwnerId, tenant nem ownerId", async () => {
    const { db, chamadas } = fakeDb([linha()]);
    await retrieveKnowledge("como cadastrar uma peca", { db });
    const sql = textoDoSql(chamadas[0]);
    expect(sql).not.toMatch(/userId|dataOwnerId|tenant|ownerId/i);
  });

  it("o SQL lê SOMENTE a tabela AiKnowledgeChunk", async () => {
    const { db, chamadas } = fakeDb([linha()]);
    await retrieveKnowledge("como publicar anuncio", { db });
    const sql = textoDoSql(chamadas[0]);
    expect(sql).toContain('"AiKnowledgeChunk"');
    expect(sql).not.toMatch(/"Product"|"Order"|"Receivable"|"User"|"Customer"/);
  });

  it("o código-fonte do retriever não cita tenant em lugar nenhum", () => {
    const fonte = readFileSync(
      join(__dirname, "..", "app", "ai", "knowledge", "retriever.ts"),
      "utf8",
    );
    // Fora dos comentários, que explicam de propósito por que não há tenant.
    const codigo = fonte
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");
    expect(codigo).not.toMatch(/dataOwnerId|tenantId|ownerId/);
  });
});

describe("tokenização da pergunta", () => {
  it("descarta palavra de pergunta e de cortesia", () => {
    expect(stripQuestionWords("Como eu faço para emitir etiqueta?")).toBe(
      "para emitir etiqueta",
    );
  });

  it("preserva substantivo do domínio — é o que precisa casar", () => {
    const limpo = stripQuestionWords("Como emito uma nota fiscal da venda?");
    expect(limpo).toContain("nota");
    expect(limpo).toContain("fiscal");
    expect(limpo).toContain("venda");
  });

  it("herda o vocabulário de autopeças da busca de peças", () => {
    const grupos = tokenizeKnowledgeQuery("etiqueta da peca tras esq");
    const plano = grupos.flat();
    expect(plano).toContain("traseira");
    expect(plano).toContain("esquerda");
  });

  it("pergunta só de cortesia não gera termo e não consulta o banco", async () => {
    const { db, chamadas } = fakeDb();
    const hits = await retrieveKnowledge("obrigado!", { db });
    expect(hits).toEqual([]);
    expect(chamadas).toHaveLength(0);
  });
});

describe("consulta", () => {
  it("pontua por quantos grupos casaram e ordena de forma determinística", async () => {
    const { db, chamadas } = fakeDb([linha()]);
    await retrieveKnowledge("estoque localizacao prateleira", { db });
    const sql = textoDoSql(chamadas[0]);
    expect(sql).toContain("CASE WHEN");
    expect(sql).toMatch(/ORDER BY[\s\S]*hits DESC/);
    // Empate resolvido por docId/ord: sem isso o resultado varia entre execuções.
    expect(sql).toMatch(/"docId" ASC/);
    expect(sql).toMatch(/"ord" ASC/);
  });

  it("os termos vão como PARÂMETRO, nunca concatenados no SQL", async () => {
    const { db, chamadas } = fakeDb([linha()]);
    await retrieveKnowledge("fechadura palio", { db });
    const valores = (chamadas[0] as any).values as unknown[];
    expect(valores).toContain("%fechadura%");
    expect(valores).toContain("%palio%");
    expect(textoDoSql(chamadas[0])).not.toContain("fechadura");
  });

  it("limita a 5 pedaços por padrão", async () => {
    const { db, chamadas } = fakeDb([linha()]);
    await retrieveKnowledge("anuncio pausado mercado livre", { db });
    expect((chamadas[0] as any).values).toContain(MAX_KNOWLEDGE_CHUNKS);
  });

  it("respeita o teto de tokens, cortando os pedaços que não cabem", async () => {
    const grande = "z".repeat(4000); // ~1000 tokens
    const { db } = fakeDb([
      linha({ content: grande }),
      linha({ content: grande }),
      linha({ content: grande }),
      linha({ content: grande }),
    ]);
    const hits = await retrieveKnowledge("estoque peca prateleira", {
      db,
      maxTokens: 2500,
    });
    expect(hits).toHaveLength(2);
  });

  it("o PRIMEIRO pedaço entra mesmo estourando o teto — nunca volta vazio", async () => {
    const { db } = fakeDb([linha({ content: "z".repeat(40_000) })]);
    const hits = await retrieveKnowledge("estoque prateleira", {
      db,
      maxTokens: 10,
    });
    expect(hits).toHaveLength(1);
  });

  it("resolve o título do documento a partir do manifesto", async () => {
    const { db } = fakeDb([linha({ docId: "pdv-balcao" })]);
    const hits = await retrieveKnowledge("venda balcao", { db });
    expect(hits[0].docTitle).toBe("PDV Balcão");
  });

  it("docId desconhecido no banco não quebra — cai no próprio id", async () => {
    const { db } = fakeDb([linha({ docId: "documento-que-sumiu" })]);
    const hits = await retrieveKnowledge("venda balcao", { db });
    expect(hits[0].docTitle).toBe("documento-que-sumiu");
  });
});

describe("degradação", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("banco fora / tabela ausente devolve lista vazia, nunca lança", async () => {
    const db = {
      $queryRaw: async () => {
        throw new Error('relation "AiKnowledgeChunk" does not exist');
      },
    };
    await expect(
      retrieveKnowledge("como emitir nota", { db }),
    ).resolves.toEqual([]);
  });
});

describe("formatação para o prompt", () => {
  it("identifica documento e seção em cada pedaço", () => {
    const texto = formatKnowledgeForPrompt([
      {
        docId: "produtos",
        docTitle: "Produtos e cadastro de peças",
        heading: "SKU: como o número é escolhido",
        content: "corpo",
        hits: 1,
      },
    ]);
    expect(texto).toContain("[Produtos e cadastro de peças > SKU");
    expect(texto).toContain("corpo");
  });

  it("pedaço sem heading não vira ' > undefined'", () => {
    const texto = formatKnowledgeForPrompt([
      {
        docId: "produtos",
        docTitle: "Produtos e cadastro de peças",
        heading: null,
        content: "corpo",
        hits: 1,
      },
    ]);
    expect(texto).not.toContain("undefined");
    expect(texto).not.toContain(">");
  });
});
