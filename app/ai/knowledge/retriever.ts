// Recuperação lexical na base de conhecimento (o "R" do RAG).
//
// ⭐ ESTA FUNÇÃO NÃO RECEBE `dataOwnerId`, E ISSO É DE PROPÓSITO.
// AiKnowledgeChunk é uma tabela GLOBAL: fala do produto Dexo, não do cliente.
// Não existe coluna de tenant para filtrar, então também não existe assinatura
// por onde um tenant chegue aqui. `tests/ai-retriever.spec.ts` prova que nem a
// função nem o SQL mencionam tenant.
//
// Busca LEXICAL, sem embedding: pgvector não está instalado (Apêndice A 6) e a
// decisão aprovada foi não instalar extensão nova. O ranking é por quantos
// GRUPOS de termos o pedaço casa; `similarity()` do pg_trgm — que já está em
// produção — entra só como desempate.
//
// Falha é SEMPRE silenciosa e devolve lista vazia: tabela ainda não criada,
// pg_trgm ausente, banco lento. Sem base de conhecimento o Bitz responde pior,
// e é só isso que pode acontecer — nunca um erro na cara do usuário.

import { Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import {
  normalizeTerm,
  tokenizeSearch,
} from "../../repositories/product-search-terms";
import { estimateTokens } from "../agent/context-window";
import { knowledgeDocTitle } from "./docs";

/** Quantos pedaços no máximo entram no contexto. */
export const MAX_KNOWLEDGE_CHUNKS = 5;

/** Teto de tokens que a base de conhecimento pode ocupar num turno. */
export const MAX_KNOWLEDGE_TOKENS = 3000;

/**
 * Palavras de pergunta e de cortesia.
 *
 * O STOPWORDS da busca de peças (product-search-terms.ts) é curto e
 * conservador de propósito: lá qualquer palavra pode ser parte do nome de uma
 * peça. Aqui a entrada é uma FRASE INTERROGATIVA, e "como", "faço", "consigo"
 * aparecem em quase todo documento — mantê-las faria todo pedaço empatar em
 * pontuação e o ranking viraria sorteio.
 *
 * Deliberadamente NÃO inclui substantivo de domínio nenhum: "nota", "peça",
 * "conta" e "anúncio" são exatamente o que precisa casar.
 */
export const KNOWLEDGE_STOPWORDS = new Set<string>([
  "como",
  "onde",
  "quando",
  "qual",
  "quais",
  "quanto",
  "quantos",
  "quantas",
  "quem",
  "porque",
  "por",
  "que",
  "eu",
  "voce",
  "vc",
  "meu",
  "minha",
  "meus",
  "minhas",
  "seu",
  "sua",
  "isso",
  "isto",
  "esse",
  "essa",
  "este",
  "esta",
  "aqui",
  "ali",
  "la",
  "faco",
  "fazer",
  "faz",
  "fazendo",
  "consigo",
  "conseguir",
  "posso",
  "poder",
  "pode",
  "quero",
  "queria",
  "gostaria",
  "preciso",
  "precisa",
  "tem",
  "ter",
  "tenho",
  "sao",
  "eh",
  "esta",
  "estao",
  "ser",
  "sobre",
  "ajuda",
  "ajudar",
  "explica",
  "explicar",
  "me",
  "mim",
  "nao",
  "sim",
  "ok",
  "por favor",
  "favor",
  "obrigado",
  "obrigada",
  "oi",
  "ola",
  "bom",
  "boa",
  "dia",
  "tarde",
  "noite",
  "dexo",
  "sistema",
  "plataforma",
]);

export interface KnowledgeHit {
  docId: string;
  docTitle: string;
  heading: string | null;
  content: string;
  /** Quantos grupos de termos da pergunta o pedaço casou. */
  hits: number;
}

/**
 * Remove palavras de pergunta ANTES de tokenizar.
 *
 * A ordem importa: `tokenizeSearch` corta em MAX_TOKEN_GROUPS (10), então se as
 * palavras de cortesia chegassem lá elas consumiriam vagas e um termo
 * discriminante do fim da frase seria descartado. Filtrando antes, as 10 vagas
 * ficam para o que importa.
 */
export function stripQuestionWords(query: string): string {
  return normalizeTerm(query ?? "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !KNOWLEDGE_STOPWORDS.has(t))
    .join(" ");
}

/**
 * Grupos de variantes da pergunta (AND entre grupos no ranking, OR dentro).
 *
 * Reusa `tokenizeSearch`, então o vocabulário de autopeças vem de graça: quem
 * perguntar "etiqueta da peça diant esq" casa com "dianteira esquerda" escrito
 * por extenso nos documentos.
 */
export function tokenizeKnowledgeQuery(query: string): string[][] {
  return tokenizeSearch(stripQuestionWords(query));
}

interface RawRow {
  docId: string;
  heading: string | null;
  content: string;
  hits: number | bigint;
}

/**
 * Top-N pedaços para uma pergunta. Lista vazia quando não há termo útil, quando
 * nada casa, ou quando a consulta falha.
 *
 * `db` é injetável só para teste — em produção é sempre o prisma do módulo.
 */
export async function retrieveKnowledge(
  query: string,
  opts?: {
    limit?: number;
    maxTokens?: number;
    db?: { $queryRaw: (...args: any[]) => Promise<any> };
  },
): Promise<KnowledgeHit[]> {
  const grupos = tokenizeKnowledgeQuery(query);
  if (grupos.length === 0) return [];

  const limit = Math.max(1, opts?.limit ?? MAX_KNOWLEDGE_CHUNKS);
  const maxTokens = Math.max(1, opts?.maxTokens ?? MAX_KNOWLEDGE_TOKENS);
  const db = opts?.db ?? (prisma as any);

  // Cliente sem SQL cru (dublê de teste de outro caminho, mock parcial). É
  // ausência de capacidade, não erro: sai quieto, sem poluir o log com um
  // stack trace que não representa problema nenhum.
  if (typeof db?.$queryRaw !== "function") return [];

  // Cada grupo vira `("search" LIKE %v1% OR "search" LIKE %v2% ...)`.
  // Os termos saem de `tokenizeSearch`, que quebra em [^a-z0-9]+ — não há como
  // um `%` ou `_` sobreviver até aqui e virar curinga.
  const condicoes = grupos.map(
    (variantes) =>
      Prisma.sql`(${Prisma.join(
        variantes.map((v) => Prisma.sql`"search" LIKE ${`%${v}%`}`),
        " OR ",
      )})`,
  );

  const pontuacao = Prisma.join(
    condicoes.map((c) => Prisma.sql`(CASE WHEN ${c} THEN 1 ELSE 0 END)`),
    " + ",
  );

  // Desempate por `similarity` (pg_trgm, já instalado em produção). Vem depois
  // da contagem de grupos, que é o sinal forte; serve para separar dois pedaços
  // que casaram os mesmos termos. `docId`/`ord` fecham a ordenação para o
  // resultado ser determinístico — teste flaky por ORDER BY ambíguo é o tipo de
  // coisa que só aparece em produção.
  const alvo = normalizeTerm(query ?? "");

  let rows: RawRow[];
  try {
    // Sem argumento de tipo na chamada: `db` é injetável e sua assinatura é
    // deliberadamente frouxa, então o genérico do Prisma não existe aqui.
    rows = (await db.$queryRaw(Prisma.sql`
      SELECT "docId", "heading", "content", (${pontuacao}) AS hits
      FROM "AiKnowledgeChunk"
      WHERE ${Prisma.join(condicoes, " OR ")}
      ORDER BY hits DESC, similarity("search", ${alvo}) DESC, "docId" ASC, "ord" ASC
      LIMIT ${limit}
    `)) as RawRow[];
  } catch (err) {
    // Tabela ausente (DDL ainda não aplicado), pg_trgm ausente, banco fora.
    // Degrada para "sem base de conhecimento" — nunca para erro no chat.
    console.error("[bitz-knowledge] busca falhou; seguindo sem base.", err);
    return [];
  }

  const resultado: KnowledgeHit[] = [];
  let tokens = 0;
  for (const row of rows ?? []) {
    const custo = estimateTokens(row.content);
    // O primeiro pedaço entra mesmo estourando o teto: voltar de mãos vazias
    // por causa de um documento longo seria pior que passar um pouco do
    // orçamento uma vez.
    if (resultado.length > 0 && tokens + custo > maxTokens) break;
    tokens += custo;
    resultado.push({
      docId: row.docId,
      docTitle: knowledgeDocTitle(row.docId),
      heading: row.heading,
      content: row.content,
      hits: Number(row.hits),
    });
  }

  return resultado;
}

/**
 * Formata os pedaços para entrar no system prompt.
 *
 * Quem chama DEVE embrulhar com `wrapSystemData` — isto é dado, não instrução.
 */
export function formatKnowledgeForPrompt(hits: KnowledgeHit[]): string {
  return hits
    .map(
      (h) =>
        `[${h.docTitle}${h.heading ? ` > ${h.heading}` : ""}]\n${h.content}`,
    )
    .join("\n\n");
}
