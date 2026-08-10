/**
 * Leitura de um corpo NDJSON no navegador.
 *
 * Puro e sem React de propósito: a suíte roda em `environment: "node"`, e o
 * pedaço que de fato quebra é este — o resto do hook é `setState`.
 *
 * ⚠️ O DEFEITO QUE ESTE MÓDULO EXISTE PARA IMPEDIR: um chunk de rede NÃO é uma
 * linha. `fetch` entrega o que chegou no socket, e isso parte no meio de um
 * JSON com frequência — mais ainda quando o texto é longo, que é justamente o
 * caso de uma resposta boa. Quem faz `chunk.split("\n").map(JSON.parse)` passa
 * em todo teste com resposta curta e falha em produção com resposta longa.
 *
 * A regra é uma só: a última fatia do split volta para o buffer, sempre.
 */

/** O que o front manda em `Accept` para pedir streaming. */
export const NDJSON_ACCEPT = "application/x-ndjson";

export interface LeitorNdjson {
  /** Consome um pedaço de texto e devolve os objetos COMPLETOS que apareceram. */
  push(pedaco: string): unknown[];
  /** Fim do corpo: devolve o que sobrou no buffer, se for um objeto válido. */
  fim(): unknown[];
}

export function criarLeitorNdjson(): LeitorNdjson {
  let buffer = "";

  const interpretar = (linha: string): unknown[] => {
    const limpa = linha.trim();
    if (!limpa) return [];
    try {
      return [JSON.parse(limpa)];
    } catch {
      // Linha corrompida é descartada em silêncio. Derrubar o stream inteiro
      // por causa de um quadro ilegível seria trocar uma resposta parcial por
      // resposta nenhuma.
      return [];
    }
  };

  return {
    push(pedaco: string): unknown[] {
      buffer += pedaco;
      const partes = buffer.split("\n");
      buffer = partes.pop() ?? "";
      return partes.flatMap(interpretar);
    },
    fim(): unknown[] {
      const resto = buffer;
      buffer = "";
      return interpretar(resto);
    },
  };
}

/** Os quadros que a rota `/ai/chat` emite em NDJSON. */
export type BitzStreamEvent =
  | { type: "inicio" }
  | { type: "conversa"; conversationId: string }
  | { type: "consultando"; tools: string[] }
  | { type: "texto"; delta: string }
  | { type: "reinicio" }
  | {
      type: "fim";
      conversationId: string | null;
      message: { content: string; sources?: unknown[] };
      degraded?: boolean;
      usage?: { inputTokens: number | null; outputTokens: number | null };
      /**
       * Propostas de escrita criadas neste turno (Fase 9).
       *
       * ⭐ NADA FOI ESCRITO. Cada uma vira um cartão com Confirmar/Cancelar, e
       * só o clique executa. Ausente quando não houve — o quadro `fim` de um
       * turno de consulta continua idêntico ao de antes.
       */
      acoes?: unknown[];
    };

/**
 * Lê o corpo inteiro chamando `aoEvento` a cada quadro.
 *
 * Não valida o `type`: quem consome decide o que fazer com um quadro
 * desconhecido. Servidor novo com front antigo tem de continuar funcionando, e
 * a regra que garante isso é o quadro `fim` — enquanto ele existir, tudo que o
 * front não entender é ignorável.
 */
export async function lerNdjson(
  body: ReadableStream<Uint8Array>,
  aoEvento: (evento: BitzStreamEvent) => void,
): Promise<void> {
  const leitor = criarLeitorNdjson();
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` é o que preserva um caractere multibyte partido entre
      // dois chunks — sem isso, um "ç" no meio da resposta vira "�".
      for (const e of leitor.push(decoder.decode(value, { stream: true }))) {
        aoEvento(e as BitzStreamEvent);
      }
    }
    for (const e of leitor.push(decoder.decode())) {
      aoEvento(e as BitzStreamEvent);
    }
    for (const e of leitor.fim()) aoEvento(e as BitzStreamEvent);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // nada a fazer se o reader já morreu com a conexão.
    }
  }
}
