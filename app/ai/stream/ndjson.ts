// Transmissão de um turno em NDJSON (um JSON por linha).
//
// POR QUE NDJSON E NÃO SSE:
//
//  - O corpo é lido com `fetch` + `res.body.getReader()`, que é o que o front
//    já faz para tudo. `EventSource` não manda header de autorização e não faz
//    POST — não serve para uma rota autenticada por Bearer.
//  - O quadro é uma linha de JSON. Sem `event:`, sem `id:`, sem retry, sem
//    reconexão automática. O protocolo cabe em duas funções e não precisa de
//    dependência nenhuma nos dois lados.
//  - `JSON.stringify` NUNCA emite um `\n` cru dentro de string (escapa como
//    `\\n`). É isso que torna "uma linha = um objeto" seguro, e não uma
//    convenção que quebra no primeiro texto com quebra de linha — que, num
//    agente que responde em markdown, seria a primeira resposta.
//
// ⚠️ COMPRESSÃO. `@fastify/compress` está `{global:true}` (api.ts:92) e
// bufferizaria o corpo inteiro antes de mandar, o que anula o streaming. A
// saída daqui NÃO passa por ele porque a rota usa `reply.hijack()` e escreve em
// `reply.raw` — o hook `onSend` do compress nunca roda. É por isso que a rota
// não precisa de `config.compress:false`, e é por isso que o caminho JSON
// continua comprimido exatamente como antes.

import type { OutgoingHttpHeaders } from "node:http";

import type { FastifyReply } from "fastify";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** O cliente pediu streaming? */
export function querNdjson(accept: unknown): boolean {
  return String(accept ?? "")
    .toLowerCase()
    .includes(NDJSON_CONTENT_TYPE);
}

/** Uma linha do protocolo: JSON compacto + `\n`. */
export function linhaNdjson(objeto: unknown): string {
  return `${JSON.stringify(objeto)}\n`;
}

export interface EscritorNdjson {
  /** Escreve um quadro. Vira no-op depois que a conexão fecha. */
  escrever: (objeto: unknown) => void;
  /** Fecha o corpo. Idempotente. */
  encerrar: () => void;
  /** A conexão ainda está de pé? */
  vivo: () => boolean;
}

/**
 * Abre a resposta em NDJSON e devolve o escritor.
 *
 * ⚠️ OS CABEÇALHOS JÁ MONTADOS PELO FASTIFY SÃO PRESERVADOS, e isso não é
 * detalhe: o CORS é aplicado por um hook que chama `reply.header(...)`, e esses
 * cabeçalhos só chegam ao socket quando `reply.send()` roda. Como aqui a
 * resposta é escrita à mão, um `writeHead` que ignorasse `reply.getHeaders()`
 * mandaria a resposta SEM `access-control-allow-origin` — e o navegador
 * bloquearia o chat inteiro, num erro que não aparece em teste de `inject`
 * (que não faz CORS) e só se manifesta no browser do cliente.
 */
export function abrirNdjson(reply: FastifyReply): EscritorNdjson {
  const raw = reply.raw;

  // A partir daqui a resposta é nossa; o Fastify não deve mandar mais nada.
  reply.hijack();

  const cabecalhos: OutgoingHttpHeaders = {};
  for (const [nome, valor] of Object.entries(reply.getHeaders())) {
    // `undefined` em writeHead lança; cabeçalho não definido simplesmente não vai.
    if (valor !== undefined) cabecalhos[nome] = valor as never;
  }
  cabecalhos["content-type"] = `${NDJSON_CONTENT_TYPE}; charset=utf-8`;
  // `no-transform` é o que impede um proxy intermediário de re-comprimir e
  // bufferizar; `x-accel-buffering` é o mesmo pedido, no dialeto do nginx.
  cabecalhos["cache-control"] = "no-cache, no-transform";
  cabecalhos["x-accel-buffering"] = "no";
  // Um `content-length` herdado do Fastify mataria o stream na primeira linha.
  delete cabecalhos["content-length"];

  raw.writeHead(200, cabecalhos);

  let fechado = false;
  const fechar = () => {
    fechado = true;
  };
  raw.on("close", fechar);
  raw.on("error", fechar);

  return {
    vivo: () => !fechado && !raw.writableEnded,
    escrever: (objeto: unknown) => {
      if (fechado || raw.writableEnded) return;
      try {
        raw.write(linhaNdjson(objeto));
      } catch {
        // Socket morto entre a checagem e a escrita. Marca e segue: o turno
        // termina de gravar no banco de qualquer jeito.
        fechado = true;
      }
    },
    encerrar: () => {
      if (raw.writableEnded) return;
      try {
        raw.end();
      } catch {
        // idem.
      }
    },
  };
}
