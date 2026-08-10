// Validação do arquivo de áudio que chega do navegador.
//
// REGRA DA CASA: todo arquivo recebido é ENTRADA HOSTIL até prova em contrário.
// O `mimetype` do multipart é escrito pelo CLIENTE — um `curl` declara
// "audio/webm" e manda um executável. Por isso a decisão aqui é tomada pelos
// BYTES, e o mimetype declarado só é aceito quando concorda com eles.
//
// Mesmo padrão de `upload.routes.ts` (magic bytes de PNG/JPEG), pelo mesmo
// motivo: o que vai adiante não passa por nenhuma re-codificação que validaria
// o conteúdo de facto — vai direto para o provedor.

/** Formatos que o gravador do chat produz e que o provedor aceita inline. */
export type FormatoDeAudio = "webm" | "mp4" | "ogg" | "wav" | "mp3";

/** O mimetype canônico de cada formato — é o que vai para o provedor. */
export const MIME_DE_FORMATO: Record<FormatoDeAudio, string> = {
  // Chrome e Firefox gravam webm/opus; Safari grava mp4/aac.
  webm: "audio/webm",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/**
 * Descobre o formato pelos BYTES. Devolve `null` quando não reconhece — e
 * "não reconheço" é rejeição, nunca "deixa passar e o provedor que decida".
 */
export function detectarFormatoDeAudio(b: Buffer): FormatoDeAudio | null {
  if (b.length < 12) return null;

  const em = (offset: number, ascii: string) =>
    b.toString("ascii", offset, offset + ascii.length) === ascii;

  // EBML — contêiner Matroska/WebM.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return "webm";
  }
  // ISO-BMFF: o tamanho da caixa vem antes do `ftyp`, então o marcador está no
  // offset 4 e não no 0.
  if (em(4, "ftyp")) return "mp4";
  if (em(0, "OggS")) return "ogg";
  if (em(0, "RIFF") && em(8, "WAVE")) return "wav";
  if (em(0, "ID3")) return "mp3";
  // Quadro MPEG solto (mp3 sem tag ID3): 11 bits de sincronismo ligados.
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";

  return null;
}

/**
 * Confere que o mimetype DECLARADO pelo cliente bate com os bytes.
 *
 * Não é preciosismo: aceitar o declarado faria o provedor receber um arquivo
 * rotulado errado e falhar de um jeito que parece problema de rede. E aceitar
 * qualquer coisa que "pareça áudio" transformaria a rota num canal de upload
 * genérico atrás do gate do Bitz.
 */
export function mimeDeclaradoBate(
  declarado: string | undefined,
  formato: FormatoDeAudio,
): boolean {
  if (!declarado) return false;
  // O navegador manda parâmetros junto: `audio/webm;codecs=opus`.
  const base = declarado.split(";")[0].trim().toLowerCase();

  const equivalentes: Record<FormatoDeAudio, string[]> = {
    webm: ["audio/webm", "video/webm"],
    mp4: ["audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4"],
    ogg: ["audio/ogg", "audio/opus", "application/ogg"],
    wav: ["audio/wav", "audio/x-wav", "audio/wave"],
    mp3: ["audio/mpeg", "audio/mp3", "audio/mpga"],
  };

  return equivalentes[formato].includes(base);
}
