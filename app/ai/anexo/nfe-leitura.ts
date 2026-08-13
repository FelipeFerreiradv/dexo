// A leitura de um XML de NF-e anexado ao chat. Fase 8.
//
// ⭐ ESTA LEITURA NÃO CUSTA NADA. Nenhum modelo é chamado: quem lê é o
// `parseNfeXml`, que já existe no repositório, é PURO e é XXE-safe em duas
// camadas (recusa DOCTYPE/ENTITY e roda com `processEntities: false`).
//
// É por isso que ela existe nesta fase. Um desmonte recebe nota de compra o dia
// inteiro, e "manda o XML e me diz o que veio" é a pergunta óbvia — mas
// entregá-la por modelo de visão seria pagar para um LLM ler um documento cuja
// estrutura já sabemos ler com exatidão. Aqui não há o que alucinar: os números
// saem do XML, não de uma inferência.
//
// Efeito colateral bem-vindo: o clipe continua útil para o cliente que roteou
// tudo para o DeepSeek, que não tem visão nenhuma.
//
// ⚠️ O TEXTO QUE SAI DAQUI É DADO, NUNCA INSTRUÇÃO. `xProd` é escrito pelo
// FORNECEDOR — é campo livre de terceiro, exatamente a superfície onde caberia
// "ignore as instruções anteriores". Quem embrulha é o orquestrador, com
// `wrapSystemData`; aqui a responsabilidade é só não inventar nada.

import {
  NfeParseError,
  parseNfeXml,
} from "../../fiscal/nfe-import/parse-nfe-xml";
import type { NfeParsedItem } from "../../fiscal/nfe-import/nfe-import.types";

/**
 * Quantos itens da nota entram na leitura.
 *
 * Nota de desmonte com 200 linhas existe, e despejar todas gastaria contexto (e
 * dinheiro) em cada turno seguinte, porque a leitura vai junto da mensagem e
 * fica no histórico. 40 cobre a esmagadora maioria; o que sobra vira uma linha
 * honesta de "e mais N itens", em vez de um corte silencioso.
 */
const MAX_ITENS_NA_LEITURA = 40;

const brl = (n: number): string =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * `AAAA-MM-DD` → `dd/mm/aaaa`, para o lojista CONFERIR contra o papel na mão.
 *
 * ⚠️ Sem `new Date()` no caminho: a data já vem como texto do XML, e passar por
 * `Date` a converteria para o fuso do servidor — `2026-07-15` viraria 14/07 num
 * fuso negativo. É corte de string, e é o certo aqui.
 */
const dataBR = (iso: string): string => {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
};

/** Quantidade sem casas inúteis: `3` e não `3,00`; `2,5` continua `2,5`. */
const qtd = (n: number): string =>
  Number.isInteger(n)
    ? String(n)
    : n.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

/**
 * ⚠️ A QUANTIDADE REAL DA LINHA — e ela NÃO é o campo `quantity`.
 *
 * `NfeParsedItem.quantity` é `Math.round(soma de qCom)`, e o arredondamento é
 * correto lá: aquele campo existe para virar `stock`, que é inteiro. Aqui não:
 * uma compra de **0,5 kg** de aditivo apareceria como "1 KG" — com o total certo
 * ao lado, o que faz o erro parecer arredondamento de centavo e não o dobro da
 * quantidade. Com `qCom = 0,4` sairia "0 KG" para uma compra que existiu.
 *
 * A quantidade original é recuperável sem tocar no parser fiscal, porque as
 * outras duas grandezas do grupo são exatas: `lineTotal` é a soma de `vProd` e
 * `costPrice` é `lineTotal / soma(qCom)`. Dividir um pelo outro devolve a soma
 * de `qCom`.
 *
 * Cai de volta no `quantity` quando o custo é zero (item de bonificação, brinde,
 * remessa) — ali a divisão não existe e o inteiro é o melhor que há.
 */
function quantidadeReal(item: NfeParsedItem): number {
  if (!(item.costPrice > 0) || !Number.isFinite(item.lineTotal)) {
    return item.quantity;
  }
  const derivada = item.lineTotal / item.costPrice;
  if (!Number.isFinite(derivada) || derivada <= 0) return item.quantity;
  // 3 casas: o leiaute da NF-e permite 4, mas a terceira já é resíduo do
  // arredondamento de `costPrice` a 2 casas. Arredondar aqui evita "2,9999997".
  return Math.round(derivada * 1000) / 1000;
}

export type ResultadoDeLeituraNfe =
  | { ok: true; leitura: string; resumo: string }
  | { ok: false; motivo: "xml_invalido"; detalhe: string };

/**
 * Transforma o XML da nota num texto que o modelo entende — e que o LOJISTA
 * consegue conferir antes de mandar, que é o ponto da fase inteira.
 */
export function lerXmlDeNfe(xml: string): ResultadoDeLeituraNfe {
  let parsed;
  try {
    parsed = parseNfeXml(xml);
  } catch (err) {
    // O `NfeParseError` já tem mensagem escrita para humano ("Nota sem itens",
    // "Apenas NF-e modelo 55 é suportada"). Ela é aproveitada porque é melhor
    // do que qualquer coisa genérica que eu escrevesse aqui — e não vaza
    // detalhe de implementação nenhum.
    return {
      ok: false,
      motivo: "xml_invalido",
      detalhe:
        err instanceof NfeParseError
          ? err.message
          : "Não consegui ler esse XML como uma NF-e.",
    };
  }

  const { items, meta } = parsed;
  const total = items.reduce((s, i) => s + i.lineTotal, 0);

  const cabecalho = [
    meta.numero ? `Nota número ${meta.numero}` : "Nota sem número declarado",
    meta.serie ? `Série: ${meta.serie}` : null,
    meta.emitName ? `Fornecedor: ${meta.emitName}` : null,
    meta.emitCnpj ? `CNPJ do fornecedor: ${meta.emitCnpj}` : null,
    // ⭐⭐ A CHAVE, EM LINHA PRÓPRIA E RÓTULO EXPLÍCITO.
    //
    // Ela existe aqui por um motivo específico: `completar_fiscal_da_sucata`
    // pede ao modelo para COPIAR os valores desta leitura, e até 13/08/2026 a
    // chave simplesmente não estava nela — o parser nunca a extraía. O lojista
    // anexava o XML, pedia para preencher o fiscal, e recebia um cartão com o
    // número da nota e mais nada; se o modelo tentasse a chave, ele a inventava.
    //
    // ⚠️ São 44 dígitos que um LLM vai TRANSCREVER, e essa continua sendo a
    // parte frágil — por isso ela sai limpa, sem pontuação e sem quebra de
    // linha, e por isso o dígito verificador é conferido do outro lado, na
    // ferramenta. A rede de segurança não mudou de lugar; o que mudou é que
    // agora existe algo verdadeiro para copiar.
    meta.accessKey ? `Chave de acesso: ${meta.accessKey}` : null,
    // ⚠️ OS DOIS FORMATOS NA MESMA LINHA, e não é redundância.
    //
    // Esta leitura tem DOIS leitores: o lojista, que confere contra a nota na
    // mão dele e lê `15/07/2026`; e o modelo, que precisa entregar
    // `2026-07-15` para a ferramenta. Publicar só o formato humano obrigaria o
    // modelo a converter — e converter data é exatamente onde se troca mês por
    // dia, num campo que ninguém reconfere depois de gravado. Publicar só o da
    // máquina tiraria do lojista a conferência que justifica o cartão existir.
    meta.issueDate
      ? `Data de emissão: ${dataBR(meta.issueDate)} (para a ferramenta: ${meta.issueDate})`
      : null,
    meta.operationNature ? `Natureza da operação: ${meta.operationNature}` : null,
    meta.icmsValue !== undefined ? `ICMS da nota: ${brl(meta.icmsValue)}` : null,
    `${meta.itemCount} linha(s) na nota, ${meta.groupedCount} produto(s) distinto(s)`,
    `Valor somado dos produtos: ${brl(total)}`,
  ].filter(Boolean) as string[];

  const mostrados = items.slice(0, MAX_ITENS_NA_LEITURA);
  const linhas = mostrados.map(
    (i, n) =>
      `${n + 1}. ${i.fullName} — ${qtd(quantidadeReal(i))} ${i.unit || "un"} · ` +
      `custo unitário ${brl(i.costPrice)} · total da linha ${brl(i.lineTotal)}`,
  );

  const sobra = items.length - mostrados.length;
  if (sobra > 0) {
    // Corte DECLARADO. Um corte silencioso faria o modelo somar 40 itens e
    // apresentar o resultado como se fosse a nota inteira.
    linhas.push(
      `… e mais ${sobra} produto(s) que não couberam nesta leitura. Se o lojista perguntar sobre eles, diga que a nota tem mais itens do que foi lido aqui.`,
    );
  }

  const leitura = [...cabecalho, "", "Itens:", ...linhas].join("\n");

  const resumo = meta.emitName
    ? `Nota ${meta.numero ?? "s/nº"} de ${meta.emitName} — ${meta.groupedCount} produto(s), ${brl(total)}`
    : `Nota ${meta.numero ?? "s/nº"} — ${meta.groupedCount} produto(s), ${brl(total)}`;

  return { ok: true, leitura, resumo };
}
