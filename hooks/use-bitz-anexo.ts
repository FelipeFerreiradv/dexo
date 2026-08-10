"use client";

import * as React from "react";

import { getApiBaseUrl } from "@/lib/api";

/**
 * Anexo do Bitz (Fase 8) — o lojista escolhe um arquivo, isto devolve a LEITURA.
 *
 * ⭐ O ARQUIVO NÃO ENTRA NA CONVERSA; a leitura dele entra. O que vai para o
 * servidor é lido, vira texto e o arquivo some — nada em disco, nada em banco.
 * O que fica na tela é um cartão com o que o Bitz entendeu, para o lojista
 * conferir ANTES de perguntar.
 *
 * ⚠️ UM ANEXO POR VEZ, de propósito. Escolher outro substitui o atual. Não é
 * limitação técnica: é que a pergunta seguinte é sobre UMA peça ou UMA nota, e
 * uma pilha de anexos vira contexto caro que ninguém releu.
 */
export type EstadoDoAnexo = "parado" | "lendo" | "erro";

export interface AnexoLido {
  nome: string;
  tipo: "imagem" | "xml-nfe";
  /** O texto completo que vai junto da pergunta. */
  leitura: string;
  /** Uma linha, para o cartão fechado. */
  resumo: string;
}

/**
 * Maior lado da foto depois da redução. Espelha `AI_CONSTANTS.MAX_ANEXO_IMAGEM_PX`.
 *
 * Foto de celular chega com 4000 px e 5 MB. O modelo de visão trabalha em
 * mosaicos de resolução fixa, então esses megapixels a mais não melhoram a
 * leitura em nada — só fazem o lojista esperar o upload no 4G da loja.
 */
const MAX_PX = 1600;

/** Qualidade do JPEG de saída. 0,85 é o joelho da curva: some peso, não detalhe. */
const QUALIDADE = 0.85;

/**
 * Reduz a foto no NAVEGADOR, antes de subir.
 *
 * ⚠️ `imageOrientation: "from-image"` NÃO É OPCIONAL. Foto de celular guarda a
 * rotação em EXIF, e o `<canvas>` desenha os pixels crus — sem essa opção, a
 * peça fotografada em pé chega DEITADA no modelo, que então lê o código ao
 * contrário ou não lê. É o tipo de bug que ninguém liga à "otimização de
 * upload" que o causou.
 *
 * FALHA É SILENCIOSA E VOLTA AO ORIGINAL: navegador antigo, imagem corrompida,
 * canvas bloqueado por política — em qualquer um desses casos sobe o arquivo
 * como veio. O teto de 8 MB do servidor é quem decide no fim.
 */
async function reduzirImagem(file: File): Promise<Blob> {
  try {
    if (typeof createImageBitmap !== "function") return file;

    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });

    const maior = Math.max(bitmap.width, bitmap.height);
    if (!maior) return file;
    // Já é pequena: reencodar só perderia qualidade de graça.
    if (maior <= MAX_PX) {
      bitmap.close?.();
      return file;
    }

    const escala = MAX_PX / maior;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * escala);
    canvas.height = Math.round(bitmap.height * escala);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALIDADE),
    );
    // Reduzir e ficar MAIOR acontece (PNG de tela com poucas cores). Nesse caso
    // o original vence.
    return blob && blob.size > 0 && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

const ehImagem = (file: File) => /^image\//i.test(file.type);

export function useBitzAnexo() {
  const [estado, setEstado] = React.useState<EstadoDoAnexo>("parado");
  const [erro, setErro] = React.useState<string | null>(null);
  const [anexo, setAnexo] = React.useState<AnexoLido | null>(null);

  /**
   * Guarda de corrida: escolher um arquivo e, antes de a leitura voltar,
   * escolher outro. Sem isto, a resposta da PRIMEIRA leitura chegaria depois e
   * sobrescreveria a segunda — o lojista veria o cartão da foto que ele
   * descartou.
   */
  const pedidoRef = React.useRef(0);

  const escolher = React.useCallback(async (file: File) => {
    if (!file) return;
    const meu = ++pedidoRef.current;

    setErro(null);
    // ⭐⭐ O ANEXO ANTERIOR MORRE AQUI, no instante da escolha — não quando a
    // leitura nova voltar.
    //
    // ⚠️ ISTO JÁ ESTAVA ERRADO e é o pior defeito que a revisão encontrou. O
    // lojista anexava a foto A, percebia que era a peça errada, escolhia a foto
    // B — e enquanto B carregava (ou DEPOIS de B falhar por cota ou por foto
    // ilegível) o estado ainda continha A. O cartão mostrava "Lendo o
    // arquivo…", ele digitava "qual o código dessa peça?" e enviava: a pergunta
    // viajava com a leitura da peça ERRADA, e nada na tela dizia isso. Errar
    // assim é pior que não ter o recurso.
    setAnexo(null);
    setEstado("lendo");

    try {
      const corpo = ehImagem(file) ? await reduzirImagem(file) : file;

      const form = new FormData();
      // O nome viaja porque é o que o lojista vê no cartão. O servidor o saneia
      // antes de qualquer uso — ele vem do disco de quem enviou.
      form.append("arquivo", corpo, file.name || "arquivo");

      const res = await fetch(`${getApiBaseUrl()}/ai/anexo`, {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => null);

      // Chegou tarde: outro arquivo já tomou o lugar deste.
      if (meu !== pedidoRef.current) return;

      if (!res.ok || !data?.ok) {
        // A rota devolve 200 com `{ok:false, error}` quando é estado de negócio
        // (teto de cota, foto ilegível, XML que não é NF-e). O texto já vem
        // pronto para ler.
        setErro(
          typeof data?.error === "string"
            ? data.error
            : "Não consegui ler esse arquivo. Tenta de novo?",
        );
        setEstado("erro");
        return;
      }

      setAnexo({
        nome: String(data.anexo?.nome ?? "arquivo"),
        tipo: data.anexo?.tipo === "xml-nfe" ? "xml-nfe" : "imagem",
        leitura: String(data.anexo?.leitura ?? ""),
        resumo: String(data.anexo?.resumo ?? ""),
      });
      setEstado("parado");
    } catch {
      if (meu !== pedidoRef.current) return;
      setErro("Sem conexão para enviar o arquivo. Pode escrever a pergunta.");
      setEstado("erro");
    }
  }, []);

  const remover = React.useCallback(() => {
    // Invalida qualquer leitura em voo: remover tem que remover de verdade,
    // inclusive a que ainda não chegou.
    pedidoRef.current++;
    setAnexo(null);
    setErro(null);
    setEstado("parado");
  }, []);

  const limparErro = React.useCallback(() => {
    setErro(null);
    setEstado("parado");
  }, []);

  return { estado, erro, anexo, escolher, remover, limparErro };
}
