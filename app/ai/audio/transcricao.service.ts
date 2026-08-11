// O caminho de um áudio, do byte ao texto. Fase 7.
//
// O DESENHO EM UMA LINHA: transcrever NÃO é perguntar. Esta camada devolve o
// texto para o navegador, o lojista lê, corrige se precisar, e só então manda
// pelo caminho de chat de sempre.
//
// ⭐ POR QUE EM DOIS PASSOS, E NÃO "áudio entra, resposta sai":
//   1. Transcrição erra — nome de peça, placa, número. Mandar direto faria o
//      Bitz responder a uma pergunta que o lojista não fez, gastando uma
//      mensagem da cota dele.
//   2. O turno de chat não muda NADA. Nenhuma linha do orquestrador sabe que
//      existe áudio, então o caminho que já está em produção segue intacto.
//   3. O áudio some aqui. Ele vive na memória pelo tempo da chamada e nunca
//      toca disco nem banco — voz é dado sensível, e o melhor lugar para ela é
//      lugar nenhum. Fica salva só a transcrição, como mensagem do usuário.
//
// ⚠️ O TEXTO QUE SAI DAQUI É DADO, NUNCA INSTRUÇÃO. Ele vira a mensagem do
// usuário e segue o mesmo caminho de qualquer coisa que ele digitaria — não há
// superfície nova de injeção, porque o usuário sempre pôde digitar o que
// quisesse. O prompt do transcritor reforça isso do outro lado (ver
// `GeminiProvider.transcribe`).

import { AI_CONSTANTS } from "../core/ai-constants";
import { resolveAiProvider } from "../core/provider";
import {
  detectarFormatoDeAudio,
  MIME_DE_FORMATO,
  mimeDeclaradoBate,
} from "./audio-formato";

export type FalhaDeTranscricao =
  | "indisponivel"
  | "formato_invalido"
  | "grande_demais"
  | "vazio"
  | "sem_fala"
  | "erro_provedor";

export type ResultadoDeTranscricao =
  | { ok: true; texto: string; provider: string; model: string }
  | { ok: false; motivo: FalhaDeTranscricao; detalhe?: string };

/**
 * O microfone deve APARECER para este cliente?
 *
 * ⭐ Um botão que sempre falha é pior que botão nenhum: o lojista grava, espera
 * e leva um erro. Quem configurou só o modelo de texto — e o DeepSeek não tem
 * áudio em forma nenhuma — recebe `false`, e o chat segue inteiro sem o
 * microfone.
 *
 * Devolve BOOLEANO, nunca o nome do provedor: o front não sabe (nem precisa
 * saber) qual modelo está por trás.
 */
export function audioDisponivel(): boolean {
  const p = resolveAiProvider("audio");
  return !!p && typeof p.transcribe === "function";
}

/** Mensagem que o USUÁRIO lê. Nunca detalhe técnico, nunca nome de provedor. */
export function mensagemDeFalha(motivo: FalhaDeTranscricao): string {
  switch (motivo) {
    case "indisponivel":
      return "O áudio não está disponível agora. Pode escrever a pergunta.";
    case "formato_invalido":
      return "Não consegui ler esse arquivo de áudio. Tente gravar de novo.";
    case "grande_demais":
      return "O áudio ficou longo demais. Grave um trecho mais curto.";
    case "vazio":
      return "Não veio áudio nenhum. Tente gravar de novo.";
    case "sem_fala":
      return "Não consegui entender o que foi dito. Tente falar mais perto do microfone.";
    case "erro_provedor":
    default:
      return "Não consegui transcrever agora. Tenta de novo em instantes?";
  }
}

/**
 * Valida os bytes e transcreve.
 *
 * A validação é por BYTES e vem antes de qualquer chamada externa: um arquivo
 * que não é áudio não deve nem sair da nossa rede, e não deve custar nada.
 */
export async function transcreverAudio(input: {
  buffer: Buffer;
  mimeDeclarado?: string;
  /** Injetável para teste; em produção sai de `resolveAiProvider("audio")`. */
  provider?: { name: string; model: string; transcribe?: Function } | null;
}): Promise<ResultadoDeTranscricao> {
  const { buffer, mimeDeclarado } = input;

  if (!buffer?.length) return { ok: false, motivo: "vazio" };

  // O teto de bytes é o único verificável do lado de cá: a duração é limitada
  // no navegador, e o navegador é o cliente — um `curl` manda o que quiser.
  if (buffer.length > AI_CONSTANTS.MAX_AUDIO_BYTES) {
    return { ok: false, motivo: "grande_demais" };
  }

  const formato = detectarFormatoDeAudio(buffer);
  if (!formato) return { ok: false, motivo: "formato_invalido" };

  // O mimetype do multipart é escrito pelo cliente. Só é aceito quando
  // concorda com os bytes — senão o provedor receberia um arquivo rotulado
  // errado e falharia de um jeito que parece problema de rede.
  if (!mimeDeclaradoBate(mimeDeclarado, formato)) {
    return { ok: false, motivo: "formato_invalido" };
  }

  const provider =
    input.provider !== undefined ? input.provider : resolveAiProvider("audio");

  // Sem provedor de áudio configurado (ou provedor sem `transcribe`, como o
  // DeepSeek, que não tem áudio nenhum) o recurso simplesmente não existe —
  // e a UI já não deveria ter oferecido o microfone.
  if (!provider || typeof provider.transcribe !== "function") {
    return { ok: false, motivo: "indisponivel" };
  }

  // ⭐ Vai o mimetype CANÔNICO do formato detectado, não o que o cliente
  // declarou: `audio/webm;codecs=opus` com parâmetros já causou recusa em API
  // que valida a string inteira.
  const completion = await provider.transcribe(
    buffer,
    MIME_DE_FORMATO[formato],
  );

  if (!completion?.ok) {
    return {
      ok: false,
      motivo: "erro_provedor",
      detalhe: completion?.reason,
    };
  }

  const texto = String(completion.content ?? "").trim();
  if (!texto) return { ok: false, motivo: "sem_fala" };

  return {
    ok: true,
    texto,
    provider: completion.provider,
    model: completion.model,
  };
}
