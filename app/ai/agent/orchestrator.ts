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
import type { AiAcaoProposta } from "../acoes/acao.types";
import {
  auditChatTurn,
  auditProviderError,
  auditQuotaExceeded,
} from "../audit/ai-audit";
import { resolveAiProvider, userFacingFailureMessage } from "../core/provider";
import { AI_CONSTANTS, describeAiConfigProblem } from "../core/ai-constants";
import type { AiFailureReason, AiMessage, AiSource } from "../core/types";
import {
  formatKnowledgeForPrompt,
  retrieveKnowledge,
} from "../knowledge/retriever";
import { getAiDailyLimitFor } from "../entitlement/ai-entitlement.service";
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
  REGRAS_DE_ESCRITA,
  REGRAS_DE_RECOMENDACAO,
  blocoDeHoje,
  blocoDeMemoria,
  buildSystemPrompt,
  neutralizarEnvelope,
  wrapSystemData,
} from "./system-prompt";
import {
  formatarMemoriasParaPrompt,
  listarMemorias,
} from "../memoria/memoria.service";
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

/**
 * A LEITURA de um arquivo que o lojista anexou. Fase 8.
 *
 * ⭐ NÃO É O ARQUIVO. O arquivo já morreu em `POST /ai/anexo`: foi lido, virou
 * texto e nunca tocou disco nem banco. O que chega aqui é o texto que o LOJISTA
 * CONFERIU na tela antes de mandar — nenhum byte de imagem passa pelo turno, e
 * nenhum provedor de texto precisa saber que existiu uma foto.
 */
export interface AiTurnAnexo {
  /** Nome do arquivo, para o lojista se situar. Já saneado na rota. */
  nome: string;
  /** O que foi lido do arquivo. DADO — nunca instrução. */
  leitura: string;
}

/**
 * Teto de anexos por turno.
 *
 * A UI manda um. Isto é o cinto para o `curl`: sem teto, uma requisição com
 * cinquenta leituras de 4.000 caracteres entraria no prompt e no histórico, e a
 * conta seria paga em todo turno seguinte da conversa.
 */
export const MAX_ANEXOS_POR_TURNO = 3;

export interface AiTurnInput {
  dataOwnerId: string;
  actorUserId: string;
  message: string;
  conversationId?: string;
  /**
   * Leituras de anexo desta mensagem. Ausente ⇒ turno byte a byte idêntico ao
   * de antes da Fase 8 existir.
   */
  anexos?: AiTurnAnexo[];
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
  /**
   * Propostas de escrita criadas NESTE turno. Fase 9.
   *
   * ⭐ NADA FOI ESCRITO. Cada uma é uma linha `AiAction` com status "pendente";
   * a UI desenha um cartão e só o clique do lojista executa.
   *
   * Ausente quando não houve proposta — é o que mantém o contrato de um turno
   * de consulta byte a byte igual ao de antes desta fase.
   */
  acoes?: AiAcaoProposta[];
}

/**
 * ⭐ O CONTEÚDO GRAVADO DA MENSAGEM DO USUÁRIO — com as leituras de anexo
 * embrulhadas na frente do que ele digitou.
 *
 * TRÊS DECISÕES MORAM AQUI:
 *
 * 1. **Embrulhado em `<dados_do_sistema>`, sempre.** A leitura de uma foto é
 *    escrita por um modelo de visão olhando uma imagem que qualquer pessoa pode
 *    ter produzido, e o `xProd` de uma NF-e é campo livre do fornecedor. São
 *    superfícies de injeção de verdade, e o envelope é o que as fecha. Não é
 *    zelo excessivo: é a mesma regra que já vale para a base de conhecimento e
 *    para todo resultado de tool.
 *
 * 2. **Gravado JUNTO da mensagem, e não descartado depois do turno.** O
 *    histórico é relido do banco a cada turno (`historyRows`, mais abaixo), e é
 *    daí que sai o contexto. Se a leitura não ficasse gravada, a segunda
 *    pergunta sobre a mesma foto — "e serve em qual carro?" — chegaria ao modelo
 *    sem a foto e sem a leitura dela. O lojista veria o Bitz esquecer o que
 *    acabou de ler.
 *
 * 3. ⭐ **A PERGUNTA VEM PRIMEIRO, o envelope depois.** Isto parece detalhe de
 *    formatação e não é — a primeira versão fazia o contrário e a revisão
 *    adversarial mostrou o estrago.
 *
 *    `buildContextWindow` monta o resumo dos turnos antigos com
 *    `firstLine(m.content)` (context-window.ts:39-43). Com o envelope na frente,
 *    a primeira linha da mensagem é a MARCA DE ABERTURA do envelope e nada mais.
 *    Duas consequências, as duas ruins:
 *
 *      a) o resumo gravado vira `Usuário: <dados_do_sistema>` — a pergunta real
 *         do lojista SOME da memória da conversa;
 *      b) esse resumo volta CRU para o system prompt no turno seguinte (é o
 *         único bloco de contexto que não passa pelo envelope), plantando ali
 *         uma ABERTURA SEM FECHAMENTO. Tudo que vem depois — inclusive as
 *         regras anti-invenção — passa a estar, para o modelo, dentro de um
 *         bloco que a persona manda tratar como dado e nunca obedecer. E
 *         acumula: cada anexo que sai da janela acrescenta mais uma marca órfã.
 *
 *    Com a pergunta na frente, `firstLine` volta a pegar a pergunta e nada disso
 *    acontece. (O envelope do resumo também é neutralizado mais abaixo, como
 *    segunda camada — ver o `push` do RESUMO.)
 *
 * ⚠️ Sem anexo, devolve a mensagem INTOCADA — é o que garante que uma conversa
 * de hoje continue byte a byte idêntica.
 */
function montarConteudoDoUsuario(
  message: string,
  anexos: AiTurnAnexo[] | undefined,
): string {
  if (!anexos?.length) return message;

  const blocos = anexos
    .slice(0, MAX_ANEXOS_POR_TURNO)
    .filter((a) => a && typeof a.leitura === "string" && a.leitura.trim())
    .map((a) =>
      wrapSystemData(
        `anexo enviado pelo lojista: ${String(a.nome || "arquivo").slice(0, 80)}`,
        a.leitura.slice(0, AI_CONSTANTS.MAX_ANEXO_LEITURA_CHARS),
      ),
    );

  if (!blocos.length) return message;
  return [message, ...blocos].join("\n\n");
}

/** Título derivado da primeira pergunta — dá nome à conversa na listagem. */
function deriveTitle(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || "Conversa";
}

export async function runTurn(input: AiTurnInput): Promise<AiTurnResult> {
  const db = input.db ?? (prisma as any);
  const { dataOwnerId, actorUserId, scope } = input;

  /**
   * ⭐ O INSTANTE DO TURNO, CAPTURADO UMA VEZ SÓ.
   *
   * A reserva e a devolução de cota gravam num contador por DIA UTC. Produção
   * nunca passa `input.now` (`ai.routes.ts` monta o input sem ele), então antes
   * cada uma resolvia `new Date()` por conta própria, em momentos diferentes.
   *
   * Um turno que começa às 23:59:50 UTC (20:59 em São Paulo) e falha 20 s
   * depois reservava no dia velho e devolvia no dia NOVO — decrementando um
   * contador em que nunca reservou nada e liberando um slot do dia seguinte de
   * graça. A janela é pequena (a duração de um turno, uma vez por dia), mas o
   * erro é silencioso e permanente enquanto existir.
   *
   * Dentro do mesmo dia o comportamento é byte-idêntico.
   */
  const agora = input.now ?? new Date();

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
  //
  // ⭐ `message` continua sendo O QUE ELE DIGITOU, e é ele — não o conteúdo
  // gravado — que decide intenção, cardápio de tools, RAG e título da conversa.
  // Misturar a leitura do anexo ali faria as palavras da leitura ("Mercado
  // Livre", "nota fiscal", "estoque") acionarem busca e ferramenta que ninguém
  // pediu, encarecendo o turno e trocando o assunto.
  await db.aiMessage.create({
    data: {
      conversationId,
      role: "user",
      content: montarConteudoDoUsuario(message, input.anexos),
    },
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
  // ⭐ "texto" é a CAPACIDADE deste turno, e é o que decide qual modelo atende.
  // Um turno de chat é texto mesmo quando consulta o sistema — imagem e áudio
  // entram com as Fases 8 e 7, cada uma declarando a sua. Ver `getAiRoute`.
  const provider = resolveAiProvider("texto");
  if (!provider) {
    const reason = (describeAiConfigProblem("texto") ??
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
  // ⭐ O teto do tenant vem do PRÓPRIO cliente quando ele tem um
  // (`User.aiDailyLimit`, configurado pelo Superadmin); `null` cai no padrão
  // global. É isto que separa a prévia gratuita (5/dia) de quem assinou o plano
  // maior, sem precisar de env por cliente.
  const limiteDoTenant = await getAiDailyLimitFor(dataOwnerId);
  const quota = await reserveAiTurn({
    dataOwnerId,
    db,
    // `agora`, não `input.now`: a devolução lá embaixo usa o MESMO instante, e
    // é isso que impede reserva e refund de caírem em dias UTC diferentes.
    now: agora,
    ...(limiteDoTenant !== null ? { maxPerTenant: limiteDoTenant } : {}),
  });
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
    // ⚠️ NEUTRALIZADO, e este é o ÚNICO bloco de contexto que entra no system
    // prompt sem envelope — por desenho, porque ele é memória nossa e não dado
    // de terceiro.
    //
    // Só que ele é EXTRAÍDO das mensagens (`firstLine` em context-window.ts), e
    // mensagem é texto que o usuário escreve. Bastava alguém começar uma
    // pergunta com `<dados_do_sistema>` para plantar uma abertura sem
    // fechamento aqui dentro, e daí para baixo as regras do próprio prompt
    // passariam a estar num bloco que a persona manda ignorar. O buraco é
    // ANTERIOR aos anexos; a Fase 8 só o tornou fácil de acontecer sem
    // intenção nenhuma.
    //
    // Neutralizar mantém o formato byte a byte para todo resumo que não contém
    // as marcas — que é o caso de todos os resumos que existem hoje.
    extraSystem.push(
      `RESUMO DO QUE JÁ FOI CONVERSADO (turnos antigos, fora da janela):\n${neutralizarEnvelope(conversation.summary)}`,
    );
  }

  // ⭐ A MEMÓRIA DA LOJA (Fase 11) — o que o administrador ensinou.
  //
  // ⚠️ ENTRA EM TODO TURNO, e não só quando alguma palavra casa. Uma regra que
  // só vale quando o texto do lojista a menciona é uma regra que falha
  // exatamente quando importa: "eu anuncio tudo como usado" precisa valer na
  // pergunta em que ele NÃO repetiu isso. O preço dessa escolha está medido em
  // `MAX_MEMORIAS_POR_TENANT` — 25 linhas curtas, ~1.250 tokens no pior caso.
  //
  // ⚠️ A LEITURA É BEST-EFFORT, de propósito. O invariante do módulo é que
  // `runTurn` nunca lança; uma tabela ausente (código no ar antes do DDL) ou um
  // pool estourado não podem derrubar a conversa por causa de um bloco que é
  // enriquecimento. Sem memória, o Bitz é o de antes desta fase.
  //
  // A moldura vem de `blocoDeMemoria`: texto NOSSO fora do envelope, conteúdo do
  // lojista dentro dele, neutralizado. Ver o comentário longo em system-prompt.
  // ⚠️ O `db?.aiMemory` é conferido ANTES de chamar, e a distinção importa:
  // cliente Prisma sem o model (deploy sem `prisma generate`, dublê de teste
  // antigo) é "esta fase não existe aqui" e sai em silêncio; um ERRO de verdade
  // (tabela ausente no banco, pool estourado) é anotado no log, porque aí há o
  // que consertar. Engolir os dois igual esconderia o segundo.
  if (db?.aiMemory) {
    try {
      const memorias = await listarMemorias({ dataOwnerId, db });
      if (memorias.length > 0) {
        extraSystem.push(blocoDeMemoria(formatarMemoriasParaPrompt(memorias)));
      }
    } catch (err) {
      console.error("[bitz] não consegui ler a memória da loja:", err);
    }
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
    // ⭐ As regras de ESCRITA entram só quando há como escrever — e aí entram
    // SEMPRE. A mais importante delas é "não diga que fez": o modelo chama a
    // ferramenta, lê "proposta criada" e a tentação de escrever "pronto,
    // cadastrei!" é enorme. O lojista fecharia o chat achando que a peça está
    // no catálogo, e ela não está.
    if (selecionadas.some((t) => t.kind === "write")) {
      extraSystem.push(REGRAS_DE_ESCRITA);
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

  /**
   * ⭐ TOKENS DO TURNO INTEIRO, somados chamada a chamada.
   *
   * `completion` é REATRIBUÍDO a cada rodada de tool, então `completion.usage`
   * é o consumo da ÚLTIMA chamada, não do turno. Um turno com duas rodadas faz
   * três ou quatro requisições ao provedor — e todas são cobradas.
   *
   * ⚠️ ISTO JÁ ESTEVE ERRADO, E O ERRO ERA CARO: o que ia para `AiMessage` era
   * só a última chamada, e é dessa tabela que sai o relatório de custo. O custo
   * medido virava um PISO, não o valor real, e a conta de "quanto custa liberar
   * para todos" saía subestimada — exatamente a conta que decide se a prévia
   * gratuita é viável.
   *
   * Somar é o único jeito honesto: não existe outro registro por chamada.
   */
  const uso = { inputTokens: 0, outputTokens: 0, houve: false };
  const somarUso = (u: {
    inputTokens: number | null;
    outputTokens: number | null;
  }) => {
    if (typeof u.inputTokens === "number") {
      uso.inputTokens += u.inputTokens;
      uso.houve = true;
    }
    if (typeof u.outputTokens === "number") {
      uso.outputTokens += u.outputTokens;
      uso.houve = true;
    }
  };
  /** `null` quando o provedor não reporta uso — nunca zero, que seria mentira. */
  const usoDoTurno = () => ({
    inputTokens: uso.houve ? uso.inputTokens : null,
    outputTokens: uso.houve ? uso.outputTokens : null,
  });

  let completion = await chamar(ferramentas);
  if (completion.ok) somarUso(completion.usage);

  // Trilha das consultas do turno. Vai para `AiMessage.toolCalls` (auditoria) e
  // para a contagem do log — SEM os argumentos, que carregam dado do cliente.
  const trilha: Array<{ name: string; ok: boolean; ms: number }> = [];
  /** Propostas de escrita deste turno. NADA foi escrito — ver `AiTurnResult`. */
  const acoes: AiAcaoProposta[] = [];
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

    for (const [i, r] of resultados.entries()) {
      trilha.push({ name: r.name, ok: r.ok, ms: r.ms });
      // ⭐ A proposta de escrita sobe por FORA do conteúdo da tool: ela vai para
      // a tela desenhar o cartão de confirmação, e não para o contexto do
      // modelo. Ver `ToolRunResult.acao`.
      if (r.acao) acoes.push(r.acao);
      messages.push({
        role: "tool",
        content: r.content,
        toolName: r.name,
        // ⭐ O ID DO PEDIDO VOLTA JUNTO DA RESPOSTA, e o índice é confiável:
        // `resultados` é o `Promise.all` sobre `completion.toolCalls`, na mesma
        // ordem, uma posição para cada.
        //
        // O Gemini casa pedido e resposta pelo NOME e ignora este campo. As
        // APIs no formato da OpenAI — DeepSeek inclusive — casam pelo ID e
        // recusam (HTTP 400) um `role:"tool"` sem ele. Como o histórico é
        // montado uma vez e servido a qualquer provedor, o id precisa estar
        // aqui. Campo aditivo: nada no caminho do Gemini muda.
        toolCallId: completion.toolCalls[i]?.id,
      });
      if (r.ok) sources.push(...sourcesOf(r, registry.get(r.name)));
    }

    completion = await chamar(ferramentas);
    if (completion.ok) somarUso(completion.usage);
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
    if (completion.ok) somarUso(completion.usage);
  }

  if (!completion.ok) {
    // ⭐ SÓ DEVOLVE A COTA SE NADA FOI COBRADO.
    //
    // ⚠️ Antes devolvia sempre, e isso vazava dinheiro: um turno com duas
    // rodadas de tool faz três ou quatro requisições, e se a ÚLTIMA falha o
    // Google já cobrou as anteriores. Devolver o slot ali fazia o contador
    // voltar enquanto a fatura seguia subindo — e como o usuário reenvia a
    // mesma pergunta, o ciclo se repete sem nunca consumir cota.
    //
    // `uso.houve` é o sinal exato: verdadeiro assim que qualquer chamada
    // reportou tokens. Falso ⇒ nenhuma chamada útil aconteceu (config errada,
    // rede caída, timeout no primeiro contato) ⇒ devolver é justo.
    // `agora` é o mesmo instante da reserva — devolver com um `new Date()`
    // novo decrementaria o contador do dia seguinte na virada.
    if (!uso.houve) {
      await refundAiTurn({ dataOwnerId, db, now: agora });
    }
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
      // ⭐ O turno INTEIRO, não a última chamada. É desta coluna que sai o
      // relatório de custo.
      inputTokens: usoDoTurno().inputTokens,
      outputTokens: usoDoTurno().outputTokens,
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
    inputTokens: usoDoTurno().inputTokens,
    outputTokens: usoDoTurno().outputTokens,
    latencyMs: completion.latencyMs,
    toolCalls: trilha.length,
    degraded: false,
  });

  return {
    conversationId,
    content: completion.content,
    sources: fontes,
    degraded: false,
    usage: usoDoTurno(),
    // Ausente quando não houve proposta: um turno de consulta continua
    // devolvendo exatamente o objeto de antes da Fase 9.
    ...(acoes.length ? { acoes } : {}),
  };
}
