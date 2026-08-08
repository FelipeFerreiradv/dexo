// Peças de HTTP compartilhadas pelos provedores REST do Bitz.
//
// ⭐ POR QUE ESTE ARQUIVO EXISTE. Estas três funções nasceram dentro de
// `gemini.provider.ts` e valem para qualquer provedor falado por axios. Quando
// o DeepSeek entrou, a escolha era duplicá-las ou movê-las — e duplicar
// JUSTAMENTE ESTAS seria o pior lugar para ter duas cópias: são elas que
// decidem o que pode aparecer num log e num `detail` persistido. Cópia que
// deriva, aqui, deriva na direção de vazar chave ou prompt.
//
// `iterarSse` continua sendo reexportada por `gemini.provider.ts` porque
// `tests/ai-stream.spec.ts` a importa de lá, e teste existente não se mexe.
//
// ⚠️ O MOVIMENTO NÃO FOI 100% LITERAL, e vale dizer onde: três correções
// entraram junto, todas apontadas em auditoria e todas na direção de fechar —
// nenhuma alarga o que sai daqui:
//   1. `redigirSegredos` no que vai para o console (ver abaixo);
//   2. `StringDecoder` no leitor SSE, para acento não virar "�" quando o
//      caractere cai entre dois pacotes;
//   3. `json?.message` / `corpo?.message` como fonte de descrição, além de
//      `error.message` — o ramo anterior já despejava o corpo cru inteiro
//      quando não achava `error.message`, então isto ESTREITA o que é logado.

import { StringDecoder } from "node:string_decoder";

import type { AiFailureReason } from "./types";

/**
 * Redige credencial de dentro de um texto que veio do OUTRO LADO.
 *
 * ⭐ POR QUE ISTO EXISTE. O que este módulo escreve no log é a descrição do
 * erro devolvida pelo provedor — texto 100% controlado por terceiro. A API do
 * DeepSeek e a do Google mascaram a chave nos próprios erros, mas
 * `AI_DEEPSEEK_BASE_URL` é apontável para QUALQUER endpoint compatível com o
 * formato da OpenAI, e vários servidores auto-hospedados respondem
 * `Invalid API key: sk-...` com a chave inteira. Sem esta redação, ela cairia
 * no stdout do pm2 e ficaria retida no arquivo de log.
 *
 * ⚠️ É MITIGAÇÃO, NÃO GARANTIA. Cobre os formatos que existem hoje (`sk-`,
 * `AIza`, `Bearer …`); um gateway com formato próprio ainda passaria. A
 * alternativa exata — redigir a ocorrência literal da chave configurada —
 * exigiria passar o segredo para dentro do logger, e essa troca não foi feita
 * de propósito.
 */
const SEGREDOS =
  /\b(sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{10,}|Bearer\s+\S+)/g;

export function redigirSegredos(texto: string): string {
  return texto.replace(SEGREDOS, "[REDIGIDO]");
}

/**
 * Log de diagnóstico no SERVIDOR, com o motivo que o provedor devolveu.
 *
 * Sem isto, um turno degradado é indistinguível de outro: o usuário vê sempre
 * "Não consegui responder agora" e o `detail` guardado é só `HTTP 400`. Foi
 * exatamente o que aconteceu no primeiro teste com chave real — o motivo
 * verdadeiro ("este modelo não está mais disponível para novos usuários")
 * existia na resposta e não chegava a ninguém.
 *
 * O que entra no log é a descrição do problema devolvida pelo provedor. NÃO
 * entra a URL (carrega a chave em algumas formas de chamada), não entra o
 * corpo enviado (carrega o prompt, com dado do cliente), e nada disto vai para
 * o `detail` que o orquestrador persiste — `ai-secret-leak.spec.ts` continua
 * provando isso.
 */
export function logarFalhaDoProvedor(
  provedor: string,
  contexto: string,
  err: unknown,
): void {
  const e = err as any;
  const status = e?.response?.status;
  const corpo = e?.response?.data;

  const escrever = (motivo: unknown) =>
    console.error(
      `[bitz-${provedor}] ${contexto} falhou: HTTP ${status ?? "-"} ${e?.code ?? ""} — ${redigirSegredos(String(motivo)).slice(0, 400)}`,
    );

  // ⚠️ Em `responseType: "stream"`, o corpo do ERRO também vem como stream — e
  // não como JSON já parseado. Sem drenar, todo 400 do caminho de streaming
  // aparece como "Request failed with status code 400" e o motivo real (que o
  // provedor manda) some. Foi assim que uma falha de payload ficou opaca no
  // primeiro teste com chave real.
  if (corpo && typeof corpo.on === "function") {
    let texto = "";
    corpo.on("data", (c: unknown) => {
      texto += String(c);
    });
    corpo.on("end", () => {
      try {
        const json = JSON.parse(texto);
        escrever(json?.error?.message ?? json?.message ?? texto);
      } catch {
        escrever(texto);
      }
    });
    corpo.on("error", () => escrever(e?.message ?? "sem descrição"));
    return;
  }

  escrever(
    corpo?.error?.message ?? corpo?.message ?? e?.message ?? "sem descrição",
  );
}

/** Classifica a falha SEM vazar corpo de resposta nem a chave para o log. */
export function classifyAxiosError(err: unknown): {
  reason: AiFailureReason;
  detail: string;
} {
  const anyErr = err as any;
  const code = anyErr?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return { reason: "timeout", detail: `timeout (${code})` };
  }
  const status = anyErr?.response?.status;
  if (status === 429) {
    return { reason: "rate_limit_provedor", detail: "HTTP 429" };
  }
  if (typeof status === "number") {
    // Só o status. O corpo pode ecoar trecho do prompt — que carrega dado do
    // cliente — e a URL carrega a chave na query string.
    return { reason: "erro_provedor", detail: `HTTP ${status}` };
  }
  return {
    reason: "erro_provedor",
    detail: code ? String(code) : "erro de rede",
  };
}

/**
 * Lê um corpo SSE (`data: {json}` separados por linha em branco) e devolve
 * cada payload já parseado.
 *
 * Escrito à mão, e não com uma biblioteca de SSE, pelo mesmo motivo do
 * conversor de zod→JSON Schema: o caso geral do protocolo tem retry, `event:`,
 * `id:` e reconexão, e nada disso existe aqui — a resposta é uma sequência de
 * `data:` e acabou. Serve para o Gemini e para o DeepSeek sem uma linha de
 * diferença: os dois falam o mesmo envelope.
 *
 * ⚠️ O ponto que quebra implementação ingênua: um chunk de rede NÃO é uma
 * linha. Ele parte no meio de um JSON. O buffer existe para isso, e é por isso
 * que o `split` guarda sempre o último pedaço para o próximo chunk.
 *
 * ⚠️ E O CHUNK TAMBÉM PARTE NO MEIO DE UM CARACTERE. `String(buffer)` decodifica
 * cada pacote isoladamente: um "ç", "ã" ou "é" cujos dois bytes UTF-8 caiam em
 * pacotes TCP diferentes vira "��" no texto transmitido E no que é
 * gravado no banco. O `StringDecoder` existe exatamente para isso — ele segura
 * os bytes incompletos até o próximo chunk.
 *
 * Isto NÃO aparece em teste: nos specs os chunks são `string`, e string não
 * passa por decodificação. Só aparece em produção, e só em texto acentuado —
 * ou seja, em toda resposta em português.
 */
export async function* iterarSse(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  const decodificador = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? decodificador.write(chunk)
          : String(chunk);
    const linhas = buffer.split("\n");
    // A última pode estar cortada no meio: volta para o buffer.
    buffer = linhas.pop() ?? "";
    for (const linha of linhas) {
      const payload = extrairData(linha);
      if (payload !== null) yield payload;
    }
  }
  // `end()` devolve o que sobrou de um caractere multibyte incompleto.
  const resto = extrairData(buffer + decodificador.end());
  if (resto !== null) yield resto;
}

/** `data: {...}` -> objeto. Qualquer outra coisa (comentário, vazio) -> null. */
function extrairData(linha: string): unknown | null {
  const limpa = linha.trim();
  if (!limpa.startsWith("data:")) return null;
  const corpo = limpa.slice(5).trim();
  if (!corpo || corpo === "[DONE]") return null;
  try {
    return JSON.parse(corpo);
  } catch {
    return null;
  }
}
