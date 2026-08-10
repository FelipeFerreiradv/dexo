// O caminho de um anexo, do byte ao texto. Fase 8.
//
// O DESENHO EM UMA LINHA: ler NÃO é perguntar. Esta camada devolve a LEITURA
// para o navegador, o lojista confere, e só então manda a pergunta pelo caminho
// de chat de sempre.
//
// ⭐ POR QUE EM DOIS PASSOS, E NÃO "foto entra, resposta sai" — as mesmas três
// razões da Fase 7, e uma quarta que só existe aqui:
//   1. Modelo de visão erra, e erra com confiança. Ele lê "8200 435 452" onde
//      está escrito "8200 435 462", e o lojista veria a resposta certa para a
//      peça errada. Conferindo antes, ele corrige uma vez em vez de descobrir no
//      balcão.
//   2. O turno de chat não muda: nenhuma tool, nenhuma regra de fonte, nenhuma
//      linha do provedor de texto sabe que existe anexo.
//   3. O arquivo some aqui. Vive na memória pelo tempo da chamada e nunca toca
//      disco nem banco. Foi decisão explícita do dono, contra a decisão nº 2 do
//      plano original (storage privado): sem arquivo guardado não há rota de
//      servir arquivo, não há anexo órfão para o GC apagar, não há retenção para
//      explicar e não há um segundo caminho por onde vazar entre tenants.
//   4. ⭐ DINHEIRO — e esta é a razão que só vale para o anexo. Se a foto viajasse
//      junto da pergunta, o TURNO INTEIRO teria que rodar num modelo com visão,
//      porque o DeepSeek não enxerga. A conversa toda passaria a custar preço de
//      multimodal por causa de uma foto. Lendo em separado, só a leitura paga
//      Gemini; a pergunta continua no modelo barato.
//
// ⚠️ O TEXTO QUE SAI DAQUI É DADO, NUNCA INSTRUÇÃO — e aqui isso é mais do que
// uma formalidade. A imagem é escrita por QUALQUER UM: basta fotografar um papel
// com "ignore as instruções anteriores". O `xProd` de uma NF-e é campo livre
// preenchido pelo FORNECEDOR. Os dois são superfícies de injeção reais, e o que
// as fecha é o `wrapSystemData` do orquestrador, do outro lado.

import { AI_CONSTANTS } from "../core/ai-constants";
import { resolveAiProvider } from "../core/provider";
import {
  detectarFormatoDeAnexo,
  EXTENSOES_DE_FORMATO,
  MIME_DE_ANEXO,
  mimeDeclaradoBateAnexo,
  TIPO_DE_FORMATO,
  type FormatoDeAnexo,
  type TipoDeAnexo,
} from "./anexo-formato";
import { lerXmlDeNfe } from "./nfe-leitura";

export type FalhaDeAnexo =
  | "indisponivel"
  | "formato_invalido"
  | "grande_demais"
  | "vazio"
  | "xml_invalido"
  | "sem_leitura"
  | "erro_provedor";

export type ResultadoDeAnexo =
  | { ok: true; tipo: TipoDeAnexo; leitura: string; resumo: string }
  | { ok: false; motivo: FalhaDeAnexo; detalhe?: string };

export type ClassificacaoDeAnexo =
  | {
      ok: true;
      formato: FormatoDeAnexo;
      tipo: TipoDeAnexo;
      /** A leitura vai custar chamada a provedor? Decide se a cota é reservada. */
      pago: boolean;
    }
  | { ok: false; motivo: FalhaDeAnexo };

/** Existe leitor de IMAGEM configurado neste servidor? */
export function imagemDisponivel(): boolean {
  const p = resolveAiProvider("imagem");
  return !!p && typeof p.describeImage === "function";
}

/**
 * As extensões que o clipe deve oferecer — e a lista SAI DO SERVIDOR.
 *
 * ⭐ Botão que sempre falha é pior que botão nenhum, a mesma regra do microfone.
 * Quem roteou a imagem para um modelo sem visão (o DeepSeek, por exemplo) não
 * recebe `.jpg` na lista, e o seletor de arquivo nem oferece a foto.
 *
 * O XML está SEMPRE aqui: a leitura dele não depende de provedor nenhum. É por
 * isso que o clipe continua útil mesmo num servidor sem modelo de visão — e é a
 * razão pela qual esta função devolve LISTA e não booleano.
 *
 * Lista vazia ⇒ o clipe não aparece.
 */
export function anexosDisponiveis(): string[] {
  const formatos: FormatoDeAnexo[] = imagemDisponivel()
    ? ["jpeg", "png", "webp", "xml"]
    : ["xml"];
  // `Set` porque `.jpg` e `.jpeg` vêm do mesmo formato e o `accept` do
  // navegador não gosta de repetição.
  return [...new Set(formatos.flatMap((f) => EXTENSOES_DE_FORMATO[f]))];
}

/** Mensagem que o USUÁRIO lê. Nunca detalhe técnico, nunca nome de provedor. */
export function mensagemDeFalhaDeAnexo(
  motivo: FalhaDeAnexo,
  detalhe?: string,
): string {
  switch (motivo) {
    case "indisponivel":
      return "Não consigo ler esse tipo de arquivo agora. Pode descrever por escrito?";
    case "formato_invalido":
      return "Só consigo ler foto (JPG, PNG ou WEBP) e XML de NF-e. Esse arquivo não é nenhum dos dois.";
    case "grande_demais":
      return "O arquivo ficou grande demais. Tente uma foto com resolução menor.";
    case "vazio":
      return "Não veio arquivo nenhum. Tente anexar de novo.";
    case "xml_invalido":
      // ⭐ Aqui o detalhe VAI para o usuário, e é de propósito: ele vem do
      // `NfeParseError`, que já fala português de gente ("Nota sem itens",
      // "Apenas NF-e modelo 55 é suportada"). Saber QUAL nota não serve é a
      // diferença entre resolver sozinho e abrir chamado.
      return detalhe || "Não consegui ler esse XML como uma NF-e.";
    case "sem_leitura":
      return "Não consegui enxergar nada nessa foto. Tente outra, mais próxima e com mais luz.";
    case "erro_provedor":
    default:
      return "Não consegui ler o arquivo agora. Tenta de novo em instantes?";
  }
}

/**
 * Decide O QUE é o arquivo, pelos BYTES, antes de qualquer coisa custar.
 *
 * ⭐ SEPARADO DA LEITURA DE PROPÓSITO. A rota precisa saber se o caminho é pago
 * ANTES de reservar cota: arquivo inválido não pode consumir a cota de ninguém,
 * e ler XML — que não chama modelo nenhum — não pode debitar um contador que
 * existe para conter gasto com provedor.
 */
export function classificarAnexo(
  buffer: Buffer,
  mimeDeclarado?: string,
): ClassificacaoDeAnexo {
  if (!buffer?.length) return { ok: false, motivo: "vazio" };
  if (buffer.length > AI_CONSTANTS.MAX_ANEXO_BYTES) {
    return { ok: false, motivo: "grande_demais" };
  }

  const formato = detectarFormatoDeAnexo(buffer);
  if (!formato) return { ok: false, motivo: "formato_invalido" };
  if (!mimeDeclaradoBateAnexo(mimeDeclarado, formato)) {
    return { ok: false, motivo: "formato_invalido" };
  }

  const tipo = TIPO_DE_FORMATO[formato];

  // Imagem sem leitor configurado é `indisponivel`, e não `formato_invalido`:
  // o arquivo está certo, o servidor é que não sabe ler. A UI já não deveria
  // ter oferecido `.jpg`, mas um `curl` chega aqui de qualquer jeito.
  if (tipo === "imagem" && !imagemDisponivel()) {
    return { ok: false, motivo: "indisponivel" };
  }

  return { ok: true, formato, tipo, pago: tipo === "imagem" };
}

/**
 * Lê o arquivo já classificado.
 *
 * O corte da leitura é o último passo e vale para os dois caminhos: a leitura
 * viaja com a mensagem, é gravada com ela e volta no histórico de todo turno
 * seguinte — sem teto, viraria uma conta crescente que ninguém vê.
 */
export async function lerAnexo(input: {
  buffer: Buffer;
  formato: FormatoDeAnexo;
  /** Injetável para teste; em produção sai de `resolveAiProvider("imagem")`. */
  provider?: { name: string; model: string; describeImage?: Function } | null;
}): Promise<ResultadoDeAnexo> {
  const { buffer, formato } = input;
  const tipo = TIPO_DE_FORMATO[formato];

  if (tipo === "xml-nfe") {
    // `utf8` e não `latin1`: NF-e é UTF-8 por leiaute. O BOM que o Windows
    // acrescenta é removido porque o parser XML trata `﻿` inicial como
    // conteúdo e recusa o documento.
    const xml = buffer.toString("utf8").replace(/^﻿/, "");
    const r = lerXmlDeNfe(xml);
    if (!r.ok) return { ok: false, motivo: "xml_invalido", detalhe: r.detalhe };
    return {
      ok: true,
      tipo,
      leitura: cortar(r.leitura),
      resumo: r.resumo,
    };
  }

  const provider =
    input.provider !== undefined ? input.provider : resolveAiProvider("imagem");

  if (!provider || typeof provider.describeImage !== "function") {
    return { ok: false, motivo: "indisponivel" };
  }

  // ⭐ Vai o mimetype CANÔNICO do formato detectado, nunca o que o cliente
  // declarou — mesma regra do áudio.
  const completion = await provider.describeImage(
    buffer,
    MIME_DE_ANEXO[formato],
  );

  if (!completion?.ok) {
    return { ok: false, motivo: "erro_provedor", detalhe: completion?.reason };
  }

  const leitura = String(completion.content ?? "").trim();
  if (!leitura) return { ok: false, motivo: "sem_leitura" };

  return {
    ok: true,
    tipo,
    leitura: cortar(leitura),
    // O resumo é a primeira linha útil da leitura — é o que cabe no cartão
    // fechado, acima do campo de escrita.
    resumo: primeiraLinha(leitura),
  };
}

/**
 * ⚠️ O RESULTADO CABE NO TETO **COM** O MARCADOR — e isto já esteve errado.
 *
 * A versão anterior cortava em `MAX` e ACRESCENTAVA o aviso depois, produzindo
 * uma string de `MAX + 29`. Só que a leitura volta ao servidor pelo corpo do
 * `/ai/chat`, onde `lerAnexosDoCorpo` faz `slice(0, MAX)` — e a fatia comia
 * exatamente o aviso. O modelo recebia uma nota truncada **sem saber que foi
 * truncada**, e somaria 40 dos 60 itens apresentando o resultado como a nota
 * inteira. O corte declarado só vale se ele sobreviver à viagem de volta.
 */
const AVISO_DE_CORTE = "\n[leitura cortada por tamanho]";

function cortar(texto: string): string {
  const teto = AI_CONSTANTS.MAX_ANEXO_LEITURA_CHARS;
  if (texto.length <= teto) return texto;
  return `${texto.slice(0, teto - AVISO_DE_CORTE.length)}${AVISO_DE_CORTE}`;
}

/** Primeira linha com conteúdo, sem marcador de lista, curta o bastante. */
function primeiraLinha(texto: string): string {
  const linha =
    texto
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  return linha.length > 120 ? `${linha.slice(0, 119)}…` : linha;
}
