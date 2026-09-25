// Download do XML e do DANFE (GET /fiscal/nfe/:id/xml | /danfe) nas telas da
// nota: lista de Notas Emitidas, ficha da nota e "Enviar XML".
//
// Erro: as três telas faziam `if (!res.ok) return;` (a ficha, só um
// `console.error`) — o clique não fazia nada e o operador não sabia por quê.
// Desde o #376 o servidor explica: o DANFE de nota CANCELADA que não pôde ser
// marcado responde 500 com a frase que manda usar o XML; o colaborador sem a
// permissão fiscal recebe 403 PAGE_FORBIDDEN com `message`. O error handler
// global responde `{ error, message }`. A regra aqui é `error`, senão `message`,
// senão uma frase padrão — corpo que não é JSON (página de erro do proxy) ou sem
// texto também cai na padrão.
//
// Nome: o PDF do DANFE de nota cancelada sai carimbado "CANCELADA" (#376), mas
// com o mesmo nome do DANFE válido — na pasta de downloads um sobrescrevia ou se
// confundia com o outro. Ganha o sufixo `-CANCELADA`. O XML não é carimbado e
// segue com o nome de sempre, assim como as notas não canceladas.
//
// Módulo PURO: sem React, sem fetch, sem DOM.

export const MENSAGEM_PADRAO_DOWNLOAD =
  "Não foi possível baixar o arquivo. Tente de novo.";

/** Teto do texto mostrado, em caracteres — a reticência do corte conta. */
export const TETO_MENSAGEM_DOWNLOAD = 200;

/**
 * O catch genérico das rotas de download responde `{ error: error.message }`
 * cru: a mensagem do Prisma tem várias linhas, com arquivo do servidor e host do
 * banco. Para a tela vai só a PRIMEIRA linha, com os espaços colapsados, até
 * `TETO_MENSAGEM_DOWNLOAD` caracteres. As frases curtas que o servidor escreve
 * para o operador (403, DANFE da cancelada, "DANFE nao disponivel") passam
 * idênticas. Conta por ponto de código (`Array.from`): o corte não parte um par
 * substituto (emoji simples); grafema composto (ZWJ, bandeira) ainda pode ser partido.
 */
function textoParaTela(texto: string): string {
  const linha = texto.trim().split(/\r\n|\r|\n/)[0].replace(/\s+/g, " ").trim();
  const chars = Array.from(linha);
  if (chars.length <= TETO_MENSAGEM_DOWNLOAD) return linha;
  return `${chars.slice(0, TETO_MENSAGEM_DOWNLOAD - 1).join("").trimEnd()}…`;
}

/** A frase para o operador a partir do corpo (texto) de uma resposta não-ok. */
export function mensagemErroDownload(corpo: string | null | undefined): string {
  if (!corpo || !corpo.trim()) return MENSAGEM_PADRAO_DOWNLOAD;
  let dados: unknown;
  try {
    dados = JSON.parse(corpo);
  } catch {
    return MENSAGEM_PADRAO_DOWNLOAD;
  }
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
    return MENSAGEM_PADRAO_DOWNLOAD;
  }
  const d = dados as Record<string, unknown>;
  for (const chave of ["error", "message"]) {
    const valor = d[chave];
    if (typeof valor === "string" && valor.trim()) return textoParaTela(valor);
  }
  return MENSAGEM_PADRAO_DOWNLOAD;
}

/**
 * Lê o corpo da resposta e devolve a frase. Nunca lança: corpo ilegível (a
 * leitura falhou, já foi consumido) vira a frase padrão — o erro do download
 * não pode virar outro erro calado.
 */
export async function lerMensagemErroDownload(res: {
  text(): Promise<string>;
}): Promise<string> {
  let corpo = "";
  try {
    corpo = await res.text();
  } catch {
    // corpo ilegível: frase padrão
  }
  return mensagemErroDownload(corpo);
}

/**
 * Nome do arquivo baixado a partir da base de cada tela (sem extensão). Só o PDF
 * do DANFE de nota `CANCELLED` muda: `<base>-CANCELADA.pdf`.
 */
export function nomeArquivoDownload(
  base: string,
  tipo: "xml" | "danfe",
  status?: string | null,
): string {
  if (tipo === "xml") return `${base}.xml`;
  return status === "CANCELLED" ? `${base}-CANCELADA.pdf` : `${base}.pdf`;
}
