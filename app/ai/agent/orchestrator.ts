// O loop de um turno do Bitz.
//
// Fase 2: SEM NENHUMA TOOL. O agente conversa, persiste e mede — nada mais.
// As tools de leitura entram na Fase 5 no ponto marcado abaixo, e a hierarquia
// de fontes na Fase 6. O desenho já reserva o lugar delas para aquelas fases
// não reescreverem este arquivo.
//
// INVARIANTE DESTE MÓDULO: `runTurn` nunca lança. Toda falha vira uma resposta
// degradada com `degraded: true`. Nenhum erro de IA pode derrubar uma
// requisição de negócio (REGRA 2 do plano).
//
// O `dataOwnerId` chega pelo `AiTurnInput`, montado pela rota a partir da
// sessão autenticada. Ele NUNCA vem do corpo da requisição e NUNCA é algo que
// o modelo possa produzir.

import prisma from "../../lib/prisma";
import {
  auditChatTurn,
  auditProviderError,
  auditQuotaExceeded,
} from "../audit/ai-audit";
import { resolveAiProvider, userFacingFailureMessage } from "../core/provider";
import { describeAiConfigProblem } from "../core/ai-constants";
import type { AiFailureReason, AiMessage, AiSource } from "../core/types";
import {
  formatKnowledgeForPrompt,
  retrieveKnowledge,
} from "../knowledge/retriever";
import {
  quotaMessage,
  refundAiTurn,
  reserveAiTurn,
  type AiQuotaDenial,
} from "../quota/ai-usage.service";
import type { AiScope } from "../core/scope";
import { getToolRegistry } from "../tools";
import { toToolDefinition, type AiTool } from "../tools/registry";
import { selectTools } from "../tools/select";
import { buildContextWindow, estimateTokens } from "./context-window";
import { classifyIntent } from "./intent";
import {
  REGRAS_DE_CONSULTA,
  REGRAS_DE_RECOMENDACAO,
  blocoDeHoje,
  buildSystemPrompt,
  wrapSystemData,
} from "./system-prompt";
import { runTool, type ToolRunResult } from "./tool-runner";

/** Teto de caracteres de UMA mensagem do usuário. */
export const MAX_USER_MESSAGE_CHARS = 4000;

/**
 * Rodadas de consulta por turno. Trava DURA.
 *
 * Sem ela, um modelo confuso pede a mesma tool indefinidamente e o turno custa
 * sem teto. Duas rodadas cobrem o padrão real ("busca a peça" → "busca o
 * anúncio dela"); a terceira quase sempre é o modelo se repetindo.
 */
export const MAX_TOOL_ROUNDS = 2;

/** Quantas mensagens da conversa são lidas do banco por turno. */
const HISTORY_FETCH_LIMIT = 40;

/**
 * Progresso de um turno, para quem está transmitindo (a rota NDJSON).
 *
 * ⭐ REGRA QUE ATRAVESSA TUDO: isto é PRÉVIA. O que vale é o retorno de
 * `runTurn` — é ele que é gravado no banco e é ele que o usuário lê no fim.
 * Nada aqui pode ser a única fonte de nada, e é essa assimetria que torna
 * impossível a resposta transmitida divergir da resposta final.
 *
 * Por isso também: nenhum evento carrega dado que já não vá no resultado.
 * `consultando` leva só o NOME da tool — nunca os argumentos, que carregam o
 * termo que o usuário digitou.
 */
export type AiTurnEvent =
  /** O id da conversa, assim que existe. Chega ANTES de qualquer texto: se o
   *  turno degradar no meio, o front já sabe em qual conversa continuar. */
  | { type: "conversa"; conversationId: string }
  /** O agente foi consultar o sistema. */
  | { type: "consultando"; tools: string[] }
  /** Pedaço de texto do modelo. */
  | { type: "texto"; delta: string }
  /** O texto transmitido até agora era preâmbulo de uma consulta: descarte. */
  | { type: "reinicio" };

export interface AiTurnInput {
  dataOwnerId: string;
  actorUserId: string;
  message: string;
  conversationId?: string;
  /**
   * Recebe o progresso do turno. Ausente ⇒ turno silencioso, byte a byte
   * idêntico ao de antes do streaming existir.
   *
   * Nunca deve lançar; se lançar, o turno não pode cair por causa disso.
   */
  onEvent?: (evento: AiTurnEvent) => void;
  /**
   * Escopo de execução das tools (tenant + permissões do ator).
   *
   * OPCIONAL, e ausente significa TURNO SEM TOOLS. É a trava de último recurso:
   * um chamador que não conseguiu montar o escopo a partir de uma sessão
   * autenticada não consulta dado nenhum — em vez de consultar com um tenant
   * adivinhado.
   */
  scope?: AiScope;
  /** Injetável para teste. */
  db?: any;
  now?: Date;
}

/**
 * Quantos registros a tool devolveu, para o bloco de Fontes.
 *
 * Convenção dos handlers: lista em `itens` e contagem em `total`. Quem não
 * segue (um detalhe único) conta como 1 — o usuário lê "1 registro", que é
 * verdade.
 */
function countOf(r: ToolRunResult): number {
  const parsed = parseResultado(r);
  if (Array.isArray(parsed)) return parsed.length;
  if (typeof parsed?.total === "number") return parsed.total;
  if (Array.isArray(parsed?.itens)) return parsed.itens.length;
  return parsed ? 1 : 0;
}

/** O JSON que o handler devolveu, ou `null` se truncou no meio. */
function parseResultado(r: ToolRunResult): any {
  try {
    return JSON.parse(r.content.split("\n\n[RESULTADO TRUNCADO")[0]);
  } catch {
    return null;
  }
}

/** Teto de fontes por chamada de tool. Card de fontes não é lista de compras. */
const MAX_FONTES_POR_TOOL = 8;

/**
 * ⭐ De onde veio o que esta tool respondeu.
 *
 * As tools consultivas montam o campo `fontes` elas mesmas, porque só elas
 * sabem qual degrau da cadeia respondeu — leitura tem uma fonte só, recomendação
 * tem seis possíveis. Uma tool que declara `fontes` manda: se vier `[]`, é
 * porque NÃO houve base, e inventar a genérica aqui seria exatamente a mentira
 * que o card de fontes existe para impedir.
 *
 * O conteúdo é reserializado a partir do JSON que o próprio servidor produziu —
 * o modelo não passa por aqui. Ainda assim cada entrada é validada campo a
 * campo: o dia em que uma tool nova devolver algo torto, a fonte é descartada,
 * e não desenhada torta na tela do cliente.
 */
function sourcesOf(r: ToolRunResult, tool: AiTool | undefined): AiSource[] {
  const parsed = parseResultado(r);

  if (parsed && Array.isArray(parsed.fontes)) {
    return parsed.fontes
      .map(sanitizarFonte)
      .filter((f: AiSource | null): f is AiSource => f !== null)
      .slice(0, MAX_FONTES_POR_TOOL);
  }

  if (!tool) return [];
  return [{ kind: "proprio", label: tool.sourceLabel, count: countOf(r) }];
}

const CONFIANCAS = new Set(["alta", "media", "baixa"]);

/** Corta string longa sem depender de nada: o card tem uma linha. */
const curto = (v: unknown, max: number): string =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function sanitizarFonte(raw: any): AiSource | null {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.kind) {
    case "conhecimento":
      return raw.docId && raw.docTitle
        ? {
            kind: "conhecimento",
            docId: curto(raw.docId, 60),
            docTitle: curto(raw.docTitle, 80),
            ...(raw.heading ? { heading: curto(raw.heading, 90) } : {}),
          }
        : null;
    case "proprio":
      return raw.label
        ? {
            kind: "proprio",
            label: curto(raw.label, 80),
            count: Number.isFinite(raw.count) ? Number(raw.count) : 0,
          }
        : null;
    case "plataforma":
      return Number.isFinite(raw.sampleSize) && CONFIANCAS.has(raw.confidence)
        ? {
            kind: "plataforma",
            sampleSize: Number(raw.sampleSize),
            confidence: raw.confidence,
            matchKey: curto(raw.matchKey, 80),
          }
        : null;
    case "regra":
      return raw.rule ? { kind: "regra", rule: curto(raw.rule, 140) } : null;
    case "externa":
      // Um provedor só, e literal. Fonte externa nova é decisão de produto.
      return raw.provider === "mercado-livre"
        ? {
            kind: "externa",
            provider: "mercado-livre",
            ...(raw.ref ? { ref: curto(raw.ref, 90) } : {}),
          }
        : null;
    case "estimativa":
      return raw.note
        ? { kind: "estimativa", note: curto(raw.note, 160) }
        : null;
    default:
      return null;
  }
}

/** Chave estável de uma fonte, para não repetir a mesma linha no card. */
function chaveDaFonte(f: AiSource): string {
  switch (f.kind) {
    case "conhecimento":
      return `conhecimento:${f.docTitle}`;
    case "proprio":
      return `proprio:${f.label}`;
    case "plataforma":
      return `plataforma:${f.matchKey}`;
    case "regra":
      return `regra:${f.rule}`;
    case "externa":
      return `externa:${f.provider}:${f.ref ?? ""}`;
    case "estimativa":
      return "estimativa";
  }
}

function dedupSources(fontes: AiSource[]): AiSource[] {
  const vistos = new Set<string>();
  const saida: AiSource[] = [];
  for (const f of fontes) {
    const chave = chaveDaFonte(f);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(f);
  }
  return saida;
}

export interface AiTurnResult {
  conversationId: string;
  content: string;
  sources: AiSource[];
  /** true quando a resposta NÃO veio do modelo (indisponível, quota, erro). */
  degraded: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/** Título derivado da primeira pergunta — dá nome à conversa na listagem. */
function deriveTitle(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || "Conversa";
}

export async function runTurn(input: AiTurnInput): Promise<AiTurnResult> {
  const db = input.db ?? (prisma as any);
  const { dataOwnerId, actorUserId, scope } = input;

  const message = input.message.slice(0, MAX_USER_MESSAGE_CHARS).trim();

  /**
   * Avisa o progresso, engolindo qualquer erro do ouvinte.
   *
   * O ouvinte escreve num socket, e socket que o navegador fechou LANÇA. Sem
   * este try/catch, fechar o painel no meio de uma resposta derrubaria o turno
   * — e com ele a gravação da conversa, que já custou a chamada ao modelo.
   */
  const avisar = (evento: AiTurnEvent) => {
    if (!input.onEvent) return;
    try {
      input.onEvent(evento);
    } catch {
      // Ninguém do outro lado. O turno segue e termina de gravar.
    }
  };

  // -------------------------------------------------------------------------
  // 1. Conversa: carrega a existente (provando a posse) ou cria uma nova.
  //    O `where` inclui actorUserId — um id de conversa de outro usuário não
  //    resolve, ele simplesmente não encontra e abre conversa nova.
  // -------------------------------------------------------------------------
  let conversation = input.conversationId
    ? await db.aiConversation.findFirst({
        where: { id: input.conversationId, actorUserId, dataOwnerId },
        select: { id: true, summary: true },
      })
    : null;

  if (!conversation) {
    conversation = await db.aiConversation.create({
      data: {
        dataOwnerId,
        actorUserId,
        title: deriveTitle(message),
      },
      select: { id: true, summary: true },
    });
  }

  const conversationId: string = conversation.id;

  // Primeiro evento do stream. Vai ANTES de tudo de propósito: mesmo que o
  // provedor esteja fora e o turno degrade, o front já guardou em qual conversa
  // a próxima mensagem continua.
  avisar({ type: "conversa", conversationId });

  // Persiste a pergunta ANTES de chamar o provedor: se o modelo falhar, a
  // conversa continua coerente e o usuário não perde o que digitou.
  await db.aiMessage.create({
    data: { conversationId, role: "user", content: message },
  });

  const degrade = async (
    content: string,
    errorCode: string,
  ): Promise<AiTurnResult> => {
    await db.aiMessage.create({
      data: { conversationId, role: "assistant", content, errorCode },
    });
    await db.aiConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return {
      conversationId,
      content,
      sources: [],
      degraded: true,
      usage: { inputTokens: null, outputTokens: null },
    };
  };

  // -------------------------------------------------------------------------
  // 2. Provedor. Resolvido antes da quota: sem provedor não faz sentido gastar
  //    cota do cliente.
  // -------------------------------------------------------------------------
  const provider = resolveAiProvider();
  if (!provider) {
    const reason = (describeAiConfigProblem() ??
      "provedor_desconhecido") as AiFailureReason;
    auditProviderError({
      dataOwnerId,
      actorUserId,
      conversationId,
      provider: "",
      model: "",
      reason,
      latencyMs: 0,
    });
    return degrade(userFacingFailureMessage(reason), reason);
  }

  // -------------------------------------------------------------------------
  // 3. Quota diária (tenant + global), reserva pessimista.
  // -------------------------------------------------------------------------
  const quota = await reserveAiTurn({ dataOwnerId, db, now: input.now });
  if (!quota.ok) {
    const denied: AiQuotaDenial = quota.denied ?? "tenant";
    auditQuotaExceeded({ dataOwnerId, actorUserId, conversationId, denied });
    return degrade(quotaMessage(denied), `quota_${denied}`);
  }

  // -------------------------------------------------------------------------
  // 4. Contexto: system prompt + resumo + base de conhecimento + cardápio de
  //    tools + janela do histórico.
  // -------------------------------------------------------------------------
  const historyRows = await db.aiMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_FETCH_LIMIT,
    select: { role: true, content: true },
  });
  const history: AiMessage[] = historyRows.reverse().map((r: any) => ({
    role: r.role as AiMessage["role"],
    content: r.content,
  }));

  // A data vem PRIMEIRO e SEMPRE: sem ela o modelo resolve "julho" e "ontem"
  // pelo que sobrou do treinamento, e responde com confiança sobre o ano errado.
  const extraSystem: string[] = [blocoDeHoje(input.now)];
  if (conversation.summary) {
    extraSystem.push(
      `RESUMO DO QUE JÁ FOI CONVERSADO (turnos antigos, fora da janela):\n${conversation.summary}`,
    );
  }

  // Base de conhecimento sobre o Dexo — só quando a intenção é dúvida.
  // Pergunta de relatório não paga RAG.
  //
  // `retrieveKnowledge` NÃO recebe dataOwnerId: a base é global, fala do
  // produto e não do cliente (ver o cabeçalho do retriever).
  //
  // O conteúdo entra pelo `wrapSystemData` — é DADO, nunca instrução. Um
  // documento não pode reprogramar o agente, e nenhum deles tenta; o envelope
  // existe para que continue verdade quando alguém editar um .md.
  const sources: AiSource[] = [];
  const intent = classifyIntent(message);
  if (intent.needsRag) {
    const hits = await retrieveKnowledge(message, { db });
    if (hits.length > 0) {
      extraSystem.push(
        wrapSystemData(
          "base de conhecimento do Dexo",
          formatKnowledgeForPrompt(hits),
        ),
      );
      for (const h of hits) {
        sources.push({
          kind: "conhecimento",
          docId: h.docId,
          docTitle: h.docTitle,
          ...(h.heading ? { heading: h.heading } : {}),
        });
      }
    }
  }

  // Subconjunto de tools do turno. Decidido ANTES do system prompt porque as
  // regras de consulta só entram quando há consulta a fazer.
  const registry = getToolRegistry();
  const selecionadas =
    intent.needsTools && scope ? selectTools(message, registry) : [];
  const ferramentas = selecionadas.length
    ? selecionadas.map(toToolDefinition)
    : undefined;

  if (ferramentas?.length) {
    extraSystem.push(REGRAS_DE_CONSULTA);
    // As regras de recomendação só entram quando há tool consultiva no
    // cardápio. Num "quanto vendi ontem?" elas seriam ~250 tokens de entrada
    // explicando como apresentar uma sugestão que ninguém vai pedir.
    if (selecionadas.some((t) => t.kind === "advisory")) {
      extraSystem.push(REGRAS_DE_RECOMENDACAO);
    }
  }

  const systemPrompt = buildSystemPrompt(extraSystem);

  const windowed = buildContextWindow({
    history,
    previousSummary: conversation.summary,
    fixedCost: estimateTokens(systemPrompt),
  });

  const messages: AiMessage[] = [
    { role: "system", content: systemPrompt },
    ...windowed.messages,
  ];

  // -------------------------------------------------------------------------
  // 5. Chamadas ao modelo, com até MAX_TOOL_ROUNDS rodadas de consulta.
  //
  //    `chat` nunca lança; o try/catch é cinto e suspensório para o caso de um
  //    provedor futuro quebrar o contrato.
  // -------------------------------------------------------------------------
  const chamar = async (tools?: typeof ferramentas) => {
    try {
      // Sem ouvinte, ou provedor sem streaming: o caminho de sempre. Não é
      // fallback de emergência — é o modo normal de quem não pediu progresso.
      if (!input.onEvent || typeof provider.chatStream !== "function") {
        return await provider.chat({ messages, tools });
      }

      let transmitiu = false;
      const completion = await provider.chatStream(
        { messages, tools },
        (delta) => {
          if (!delta) return;
          transmitiu = true;
          avisar({ type: "texto", delta });
        },
      );

      // O modelo às vezes narra antes de consultar ("Deixa eu verificar o
      // estoque..."). Esse texto NÃO é a resposta: a resposta vem depois da
      // consulta. Mandar apagar é o que impede o preâmbulo de ficar grudado na
      // frente do número que o usuário pediu.
      if (transmitiu && completion.ok && completion.toolCalls.length > 0) {
        avisar({ type: "reinicio" });
      }
      return completion;
    } catch (err) {
      return {
        ok: false as const,
        reason: "erro_provedor" as AiFailureReason,
        detail: err instanceof Error ? err.message.slice(0, 120) : "erro",
        provider: provider.name,
        model: provider.model,
        latencyMs: 0,
      };
    }
  };

  let completion = await chamar(ferramentas);

  // Trilha das consultas do turno. Vai para `AiMessage.toolCalls` (auditoria) e
  // para a contagem do log — SEM os argumentos, que carregam dado do cliente.
  const trilha: Array<{ name: string; ok: boolean; ms: number }> = [];
  let rodadas = 0;

  while (
    completion.ok &&
    completion.toolCalls.length > 0 &&
    scope &&
    rodadas < MAX_TOOL_ROUNDS
  ) {
    rodadas++;

    // O turno do modelo volta ao histórico COM o pedido de tool: o provedor
    // casa cada resposta com a chamada correspondente, e um turno de texto
    // vazio no lugar deixaria a conversa sem par.
    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    // Só o NOME. Os argumentos carregam o termo que o usuário digitou e não
    // acrescentam nada a um indicador de progresso.
    avisar({
      type: "consultando",
      tools: completion.toolCalls.map((c) => c.name),
    });

    // Em paralelo: as tools de leitura são independentes entre si, e o modelo
    // costuma pedir duas de uma vez ("o produto E o anúncio dele").
    const resultados = await Promise.all(
      completion.toolCalls.map((call) =>
        runTool(call, { registry, scope, conversationId }),
      ),
    );

    for (const r of resultados) {
      trilha.push({ name: r.name, ok: r.ok, ms: r.ms });
      messages.push({ role: "tool", content: r.content, toolName: r.name });
      if (r.ok) sources.push(...sourcesOf(r, registry.get(r.name)));
    }

    completion = await chamar(ferramentas);
  }

  // Estourou o teto de rodadas e o modelo ainda quer consultar. Uma última
  // chamada SEM tools: sem cardápio ele é obrigado a responder em texto com o
  // que já tem, em vez de devolver mais um pedido que ninguém vai executar.
  if (completion.ok && completion.toolCalls.length > 0) {
    messages.push({
      role: "system",
      content: `Você atingiu o limite de ${MAX_TOOL_ROUNDS} rodadas de consulta neste turno. Responda agora com o que já obteve. Se faltou informação, diga o que faltou e proponha uma pergunta mais específica. NÃO invente número nenhum.`,
    });
    completion = await chamar(undefined);
  }

  if (!completion.ok) {
    // O turno não virou chamada útil: devolve a cota.
    await refundAiTurn({ dataOwnerId, db, now: input.now });
    auditProviderError({
      dataOwnerId,
      actorUserId,
      conversationId,
      provider: completion.provider,
      model: completion.model,
      reason: completion.reason,
      detail: completion.detail,
      latencyMs: completion.latencyMs,
    });
    return degrade(
      userFacingFailureMessage(completion.reason),
      completion.reason,
    );
  }

  // -------------------------------------------------------------------------
  // 6. Persiste a resposta com tokens/latência — é o que permite medir custo.
  // -------------------------------------------------------------------------
  // Duas tools consultivas no mesmo turno repetem as regras do canal; o card
  // mostraria a mesma linha duas vezes. A dedupe é aqui, e não na UI, para o
  // que fica gravado ser o que se vê ao reabrir a conversa.
  const fontes = dedupSources(sources);

  await db.aiMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content: completion.content,
      // Guardado junto da resposta: reabrir a conversa mostra as mesmas fontes
      // de antes, sem refazer a busca. Vazio vira null para não gravar `[]`
      // em toda mensagem que não consultou nada.
      sources: fontes.length > 0 ? fontes : null,
      // Só nome, resultado e duração. Os ARGUMENTOS ficam de fora: carregam o
      // termo que o usuário digitou, que já vive na própria conversa.
      toolCalls: trilha.length > 0 ? trilha : null,
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      latencyMs: completion.latencyMs,
    },
  });

  await db.aiConversation.update({
    where: { id: conversationId },
    data: {
      updatedAt: new Date(),
      ...(windowed.summary !== conversation.summary
        ? { summary: windowed.summary }
        : {}),
    },
  });

  auditChatTurn({
    dataOwnerId,
    actorUserId,
    conversationId,
    provider: completion.provider,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    latencyMs: completion.latencyMs,
    toolCalls: trilha.length,
    degraded: false,
  });

  return {
    conversationId,
    content: completion.content,
    sources: fontes,
    degraded: false,
    usage: completion.usage,
  };
}
