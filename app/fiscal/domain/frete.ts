/**
 * Frete da NF-e: rateio por item, composicao da base do ICMS e dimensoes.
 *
 * Tres regras de validacao da SEFAZ governam este modulo — nao sao preferencia
 * de implementacao, sao o que faz a nota ser aceita:
 *
 *  - Rejeicao 535: o somatorio de `vFrete` (I15) dos itens tem de ser IGUAL ao
 *    `vFrete` (W08) do grupo ICMSTot. Como a plataforma coleta UM valor de frete
 *    para a nota inteira, ele precisa ser RATEADO entre os itens de forma exata.
 *    Nao ha criterio imposto pela SEFAZ; aqui o rateio e proporcional ao valor
 *    do item (criterio mais comum).
 *  - Rejeicao 610 (regra W16): `vNF` tem de incluir `vFrete`. Quem faz essa soma
 *    e o FiscalCalculatorService; este modulo so entrega as parcelas.
 *  - O leiaute 4.00 NAO tem campo de dimensoes: o grupo `<vol>` aceita apenas
 *    qVol, esp, marca, nVol, pesoL e pesoB. Comprimento/largura/altura so
 *    trafegam como texto livre em `<infAdic><infCpl>` — dai o formatador aqui.
 *
 * Modulo PURO: sem banco, sem I/O, sem estado. Tudo aqui e testavel sozinho.
 */

import type { ModalidadeFrete } from "./nfe.types";

/**
 * Le a flag em TEMPO DE CHAMADA (nao no load do modulo) para que testes possam
 * usar vi.stubEnv e para refletir o valor real no runtime do Fastify.
 *
 * Flag unica para os dois lados: o front le via NEXT_PUBLIC (embutida no bundle
 * pelo build) e a API Fastify le a mesma chave do .env no boot.
 */
export function isNfeFreteMedidasEnabled(): boolean {
  return process.env.NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED === "true";
}

/**
 * O frete compoe a base de calculo do ICMS?
 *
 * Hoje: SOMENTE na modalidade CIF (modFrete 0), em que o frete e contratado por
 * conta do remetente e, portanto, integra o valor da operacao.
 *
 * NOTA FISCAL/CONTABIL: ha leitura de que PROPRIO_REMETENTE (modFrete 3) — que
 * tambem e frete por conta do emitente — deveria compor a base do mesmo jeito.
 * Ficou de fora por decisao de escopo; se o contador confirmar, basta incluir a
 * modalidade nesta funcao — nenhum outro ponto do codigo precisa mudar.
 */
export function freteCompoeBaseIcms(
  modalidade: ModalidadeFrete | string | null | undefined,
): boolean {
  return modalidade === "CIF";
}

/**
 * Rateia um valor de frete unico entre os itens da nota, proporcionalmente ao
 * valor de cada item.
 *
 * Usa o metodo do MAIOR RESTO sobre CENTAVOS (nao round2 item a item), por dois
 * motivos que a Rejeicao 535 torna obrigatorios:
 *  1. o somatorio das parcelas e EXATAMENTE igual ao frete informado — sem
 *     residuo de arredondamento;
 *  2. nenhuma parcela sai negativa. Arredondar cada parcela isoladamente pode
 *     estourar o total (ex.: R$ 0,05 entre 10 itens iguais viraria 9x R$ 0,01 =
 *     R$ 0,09) e jogar o resto do ultimo item para baixo de zero.
 *
 * Casos de borda: sem itens -> []; frete nulo/zero/negativo -> zeros; soma dos
 * valores dos itens <= 0 -> rateio em partes iguais (pesos uniformes).
 */
export function ratearFrete(
  valorFrete: number | null | undefined,
  valoresItens: number[],
): number[] {
  const n = valoresItens.length;
  if (n === 0) return [];

  const totalCents = Math.round(Math.max(0, Number(valorFrete) || 0) * 100);
  if (totalCents <= 0) return new Array(n).fill(0);

  // Peso negativo ou nao-finito nao participa do rateio.
  const pesos = valoresItens.map((v) => {
    const num = Number(v);
    return Number.isFinite(num) && num > 0 ? num : 0;
  });
  let somaPesos = pesos.reduce((acc, p) => acc + p, 0);
  if (somaPesos <= 0) {
    pesos.fill(1);
    somaPesos = n;
  }

  // Piso + resto fracionario de cada item.
  const centavos: number[] = new Array(n);
  const restos: { idx: number; resto: number }[] = new Array(n);
  let distribuido = 0;
  for (let i = 0; i < n; i++) {
    const exato = (totalCents * pesos[i]) / somaPesos;
    const piso = Math.floor(exato);
    centavos[i] = piso;
    restos[i] = { idx: i, resto: exato - piso };
    distribuido += piso;
  }

  // Sobra vai para os maiores restos; empate resolve pelo menor indice, para
  // que o resultado seja deterministico (o XML precisa ser reproduzivel).
  let sobra = totalCents - distribuido;
  if (sobra > 0) {
    restos.sort((a, b) => b.resto - a.resto || a.idx - b.idx);
    for (let k = 0; k < sobra && k < n; k++) {
      centavos[restos[k].idx] += 1;
    }
  }

  return centavos.map((c) => c / 100);
}

/** Uma dimensao valida e um inteiro positivo em centimetros. */
function dimensaoValida(v: unknown): number | null {
  const num = Number(v);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Monta o trecho de dimensoes que vai ao `<infAdic><infCpl>`.
 *
 * Sem acento de proposito: o mesmo texto e desenhado no DANFE por pdf-lib, cuja
 * fonte padrao e WinAnsi — manter ASCII evita depender do saneador do renderer.
 *
 * Volumes sem NENHUMA medida sao ignorados; volumes com medida parcial saem com
 * o que foi informado (C/L/A rotulados, nunca posicional, para nao induzir erro
 * de leitura). Nenhuma medida em nenhum volume -> string vazia, e ai o infCpl
 * fica byte-identico ao de hoje.
 */
/** Marcador de corte quando as medidas nao cabem no orcamento recebido. */
const TRUNCAMENTO = "; (...)";
const PREFIXO_DIMENSOES = "Dimensoes dos volumes: ";

/**
 * @param maxChars Orcamento de caracteres. Quem chama (composeInfCpl) desconta
 *  antes o espaco do "Pedido: N", para que a numeracao do pedido NUNCA seja
 *  perdida nem cortada ao meio por causa das medidas. O corte tambem nunca
 *  parte uma medida no meio: para no volume inteiro anterior e fecha com "(...)".
 */
export function formatDimensoesParaInfCpl(
  volumes: unknown,
  maxChars = 5000,
): string {
  if (!Array.isArray(volumes) || volumes.length === 0) return "";

  const partes: string[] = [];
  volumes.forEach((vol, idx) => {
    if (!isRecord(vol)) return;
    const c = dimensaoValida(vol.comprimentoCm);
    const l = dimensaoValida(vol.larguraCm);
    const a = dimensaoValida(vol.alturaCm);
    if (c === null && l === null && a === null) return;

    const medidas: string[] = [];
    if (c !== null) medidas.push(`C${c}`);
    if (l !== null) medidas.push(`L${l}`);
    if (a !== null) medidas.push(`A${a}`);
    partes.push(`${idx + 1}) ${medidas.join(" x ")} cm`);
  });

  if (partes.length === 0) return "";

  // Reserva o marcador de truncamento durante todo o preenchimento: custa 7
  // caracteres no pior caso e garante que o texto JAMAIS ultrapasse o teto.
  const limite = maxChars - TRUNCAMENTO.length;
  if (limite <= PREFIXO_DIMENSOES.length) return "";

  let texto = PREFIXO_DIMENSOES;
  let truncado = false;
  for (let i = 0; i < partes.length; i++) {
    const candidato = texto + (i === 0 ? "" : "; ") + partes[i];
    if (candidato.length > limite) {
      truncado = true;
      break;
    }
    texto = candidato;
  }
  if (texto === PREFIXO_DIMENSOES) return "";
  return truncado ? texto + TRUNCAMENTO : texto;
}
