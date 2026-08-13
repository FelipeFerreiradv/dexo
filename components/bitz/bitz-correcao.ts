"use client";

/**
 * A frase que o botão "Corrigir" deixa começada no campo de escrita (P3.1).
 *
 * ⭐ "REFAZ", E NÃO "CORRIGE". O que vem a seguir é uma proposta NOVA — a antiga
 * já foi cancelada pelo cartão. "Refaz" é o que faz o modelo reaproveitar da
 * conversa os campos que estavam certos e trocar só o que o lojista disser; é
 * exatamente isso que poupa reditar marca, modelo, ano e placa por causa da cor.
 *
 * ⚠️ TERMINA COM ESPAÇO, de propósito: o cursor para logo depois dele e o
 * lojista continua a frase sem ter de abrir espaço na mão. Comer esse espaço
 * produziria "…, masa cor é prata".
 *
 * Pura e exportada para poder ser testada de verdade — a suíte roda em
 * `environment: "node"` e não renderiza React, então a alternativa seria só ler
 * o fonte e conferir que a linha existe, o que não prova o que ela escreve.
 *
 * ⚠️⚠️ POR QUE ESTA FUNÇÃO TEM ARQUIVO PRÓPRIO, E NÃO MORA EM
 * `bitz-constants.ts`. Ela nasceu lá, e a auditoria de 13/08/2026 mediu o
 * estrago no build de produção: `bitz-constants.ts` é importado por
 * `bitz-root.tsx`, que é o ÚNICO arquivo do módulo carregado estaticamente no
 * shell de TODAS as páginas do ERP — é ele que decide se o mascote sequer é
 * montado. Tudo o mais entra por `dynamic()`, depois do primeiro clique.
 *
 * Ou seja: uma função que só o painel do chat usa estava sendo baixada por todo
 * lojista, em toda página, inclusive por quem nunca contratou o módulo. Bytes
 * poucos, fronteira errada — e a fronteira é a promessa do módulo inteiro
 * ("flag desligada ⇒ nenhum byte a mais"). Este arquivo é importado só por
 * `bitz-panel.tsx`, que vive dentro do chunk dinâmico.
 */
export function fraseDeCorrecao(titulo: string): string {
  return `Refaz "${String(titulo ?? "")
    .trim()
    .toLowerCase()}", mas `;
}
