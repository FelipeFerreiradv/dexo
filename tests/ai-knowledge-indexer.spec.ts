import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_CHUNK_CHARS,
  chunkChecksum,
  chunkDocument,
  chunkSearchText,
  planReindex,
  splitBody,
  splitSections,
  type KnowledgeChunk,
} from "../app/ai/knowledge/indexer";
import { KNOWLEDGE_DOCS } from "../app/ai/knowledge/docs";

// ===========================================================================
// Indexação da base de conhecimento.
//
// O que estes testes protegem: a reindexação é INCREMENTAL, e a única coisa
// que decide "isto mudou" é o checksum. Um chunking não determinístico faria
// todo `ai:index` regravar a base inteira sem ninguém notar — funcionaria, e
// estaria errado. Por isso o determinismo é testado explicitamente.
// ===========================================================================

const CONTENT_DIR = join(__dirname, "..", "app", "ai", "knowledge", "content");

describe("splitSections", () => {
  it("quebra por ## e descarta o # do título (ele já está no manifesto)", () => {
    const secoes = splitSections(
      "# Título do doc\n\nAbertura.\n\n## Primeira\n\ncorpo um\n\n## Segunda\n\ncorpo dois",
    );
    expect(secoes.map((s) => s.heading)).toEqual([null, "Primeira", "Segunda"]);
    expect(secoes[0].body).toBe("Abertura.");
    expect(secoes[1].body).toBe("corpo um");
  });

  it("### fica DENTRO da seção — não abre pedaço novo", () => {
    const secoes = splitSections("## Um\n\na\n\n### Sub\n\nb");
    expect(secoes).toHaveLength(1);
    expect(secoes[0].body).toContain("### Sub");
  });

  it("`## dentro de bloco de código` não é heading", () => {
    const secoes = splitSections(
      "## Real\n\n```sh\n## isto e um comentario\n```",
    );
    expect(secoes).toHaveLength(1);
    expect(secoes[0].heading).toBe("Real");
  });
});

describe("splitBody", () => {
  it("não quebra o que cabe", () => {
    expect(splitBody("curto", 100)).toEqual(["curto"]);
  });

  it("quebra entre parágrafos, nunca no meio de um", () => {
    const p = "x".repeat(60);
    const partes = splitBody([p, p, p].join("\n\n"), 130);
    expect(partes).toHaveLength(2);
    for (const parte of partes) {
      // Cada parte é composta de parágrafos inteiros.
      for (const bloco of parte.split("\n\n")) expect(bloco).toBe(p);
    }
  });

  it("parágrafo único maior que o teto vira um pedaço grande, e não meia frase", () => {
    const gigante = "y".repeat(500);
    expect(splitBody(gigante, 100)).toEqual([gigante]);
  });
});

describe("chunkDocument", () => {
  const md =
    "# T\n\n## A\n\n" +
    "a".repeat(600) +
    "\n\n## B\n\n" +
    "b".repeat(600) +
    "\n\n## C\n\n" +
    "c".repeat(600);

  it("é DETERMINÍSTICO: mesmo markdown, mesmos pedaços e mesmos checksums", () => {
    const um = chunkDocument("doc", md);
    const dois = chunkDocument("doc", md);
    expect(dois).toEqual(um);
  });

  it("numera `ord` a partir de 0, sem buraco", () => {
    const chunks = chunkDocument("doc", md);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it("preserva o heading da seção em cada pedaço", () => {
    const chunks = chunkDocument("doc", md);
    expect(chunks.map((c) => c.heading)).toEqual(["A", "B", "C"]);
  });

  it("cola seção curta na seguinte, mantendo o heading da primeira", () => {
    const chunks = chunkDocument(
      "doc",
      "## Curta\n\noi\n\n## Longa\n\n" + "z".repeat(600),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("Curta");
    expect(chunks[0].content).toContain("### Longa");
  });

  it("mudar UMA letra muda o checksum daquele pedaço", () => {
    const antes = chunkDocument("doc", md);
    const depois = chunkDocument("doc", md.replace("## B", "## B2"));
    expect(depois[0].checksum).toBe(antes[0].checksum);
    expect(depois[1].checksum).not.toBe(antes[1].checksum);
  });

  it("o mesmo texto sob headings diferentes NÃO colide", () => {
    expect(chunkChecksum("A", "igual")).not.toBe(chunkChecksum("B", "igual"));
  });
});

describe("chunkSearchText", () => {
  it("tira acento, baixa a caixa e junta heading com corpo", () => {
    const s = chunkSearchText("Localização", "A Peça está na Prateleira");
    expect(s).toBe("localizacao a peca esta na prateleira");
  });

  it("colapsa espaço e quebra de linha (o LIKE não vê layout)", () => {
    expect(chunkSearchText(null, "a\n\n  b\tc")).toBe("a b c");
  });
});

describe("planReindex", () => {
  const chunk = (docId: string, ord: number, checksum: string) =>
    ({
      docId,
      ord,
      heading: null,
      content: "x",
      search: "x",
      checksum,
    }) as KnowledgeChunk;

  it("pedaço inalterado NÃO é regravado", () => {
    const plano = planReindex(
      [chunk("a", 0, "h1")],
      [{ docId: "a", ord: 0, checksum: "h1" }],
    );
    expect(plano.upserts).toHaveLength(0);
    expect(plano.unchanged).toBe(1);
  });

  it("pedaço alterado entra em upsert", () => {
    const plano = planReindex(
      [chunk("a", 0, "NOVO")],
      [{ docId: "a", ord: 0, checksum: "velho" }],
    );
    expect(plano.upserts.map((c) => c.checksum)).toEqual(["NOVO"]);
    expect(plano.unchanged).toBe(0);
  });

  it("pedaço novo (base vazia) entra em upsert", () => {
    const plano = planReindex([chunk("a", 0, "h")], []);
    expect(plano.upserts).toHaveLength(1);
    expect(plano.deletes).toHaveLength(0);
  });

  it("documento encurtado apaga só as posições que sobraram", () => {
    const plano = planReindex(
      [chunk("a", 0, "h1")],
      [
        { docId: "a", ord: 0, checksum: "h1" },
        { docId: "a", ord: 1, checksum: "h2" },
        { docId: "a", ord: 2, checksum: "h3" },
      ],
    );
    expect(plano.deletes).toEqual([
      { docId: "a", ord: 1 },
      { docId: "a", ord: 2 },
    ]);
    expect(plano.staleDocIds).toEqual([]);
  });

  it("documento fora do manifesto é podado inteiro", () => {
    const plano = planReindex(
      [chunk("a", 0, "h1")],
      [
        { docId: "a", ord: 0, checksum: "h1" },
        { docId: "removido", ord: 0, checksum: "x" },
        { docId: "removido", ord: 1, checksum: "y" },
      ],
    );
    expect(plano.staleDocIds).toEqual(["removido"]);
    // Poda por documento, não por posição: nada de deletes redundantes.
    expect(plano.deletes).toEqual([]);
  });

  it("rodar duas vezes seguidas não escreve nada na segunda", () => {
    const desejados = [chunk("a", 0, "h1"), chunk("a", 1, "h2")];
    const primeira = planReindex(desejados, []);
    const armazenados = primeira.upserts.map((c) => ({
      docId: c.docId,
      ord: c.ord,
      checksum: c.checksum,
    }));
    const segunda = planReindex(desejados, armazenados);
    expect(segunda.upserts).toHaveLength(0);
    expect(segunda.deletes).toHaveLength(0);
    expect(segunda.staleDocIds).toHaveLength(0);
  });
});

describe("os 13 documentos reais", () => {
  it("todo documento do manifesto existe no disco", () => {
    for (const doc of KNOWLEDGE_DOCS) {
      const conteudo = readFileSync(join(CONTENT_DIR, `${doc.id}.md`), "utf8");
      expect(conteudo.length).toBeGreaterThan(500);
    }
  });

  it("ids são únicos", () => {
    const ids = KNOWLEDGE_DOCS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("todo documento gera pedaços e nenhum passa muito do teto", () => {
    for (const doc of KNOWLEDGE_DOCS) {
      const md = readFileSync(join(CONTENT_DIR, `${doc.id}.md`), "utf8");
      const chunks = chunkDocument(doc.id, md);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        // Um parágrafo indivisível pode estourar; muito além do teto é sinal de
        // documento sem heading nenhum, e aí a recuperação fica ruim.
        expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS * 1.5);
      }
    }
  });

  it("⭐ nenhum documento carrega dado de cliente — a base é sobre o produto", () => {
    // A base é GLOBAL. Um CPF, CNPJ, e-mail ou telefone real aqui vazaria para
    // todos os tenants de uma vez. Os exemplos usados nos textos são de peça e
    // de prateleira, nunca de pessoa.
    const cpf = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
    const cnpj = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;
    const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const telefone = /\(\d{2}\)\s?9?\d{4}-\d{4}/;

    for (const doc of KNOWLEDGE_DOCS) {
      const md = readFileSync(join(CONTENT_DIR, `${doc.id}.md`), "utf8");
      expect(md, `${doc.id} tem CPF`).not.toMatch(cpf);
      expect(md, `${doc.id} tem CNPJ`).not.toMatch(cnpj);
      expect(md, `${doc.id} tem e-mail`).not.toMatch(email);
      expect(md, `${doc.id} tem telefone`).not.toMatch(telefone);
    }
  });

  it("⭐ a base não promete o que o Bitz não faz nesta entrega", () => {
    // Fases 1-6 são SOMENTE LEITURA. Um documento que ensine "peça ao Bitz
    // para cadastrar" viraria uma promessa que o agente não consegue cumprir —
    // e o modelo repetiria a promessa com toda a confiança do mundo.
    for (const doc of KNOWLEDGE_DOCS) {
      const md = readFileSync(join(CONTENT_DIR, `${doc.id}.md`), "utf8");
      expect(md, `${doc.id} promete escrita pelo Bitz`).not.toMatch(
        /(pe(ç|c)a|pedir|mande?|manda)\s+(ao|pro|para o)\s+Bitz/i,
      );
    }
  });
});
