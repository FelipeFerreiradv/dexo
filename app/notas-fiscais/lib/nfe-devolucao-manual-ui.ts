// Decisões de tela do quadro "Devolução manual" (lista de Notas Emitidas), em
// módulo puro para serem testadas em node.
//
// O que a DLS AUTO PEÇAS encontrou (24/09/2026) e este módulo resolve:
//  - 4 × "Dados da requisição inválidos." seguidos: o servidor mandava o motivo
//    campo a campo em `erros[]` e a tela jogava fora ("XML vazio.", "Faltam 8
//    dígitos.", "Informe o valor unitário…"). Agora cada motivo vai para o
//    campo dele (`lerErrosDaResposta`).
//  - A chave colada do DANFE ("4226 0911 2223 …", 54 caracteres) era CORTADA em
//    44 pelo campo. A regra de chave (`validarChaveAcesso`) sempre aceitou espaço,
//    ponto e hífen; agora ela roda ao vivo, no navegador.
//  - "45," virava "NaN" e "45." perdia o ponto: não dava para DIGITAR centavos.
//    O texto fica como ela digita e só vira número no envio, no formato
//    brasileiro (`lerNumeroDigitado`).
//  - Na devolução de COMPRA o destinatário É o fornecedor que emitiu a nota:
//    CNPJ e UF saem da própria chave (`destinatarioPelaChave`).
//  - Pelo XML, a devolução nascia com TODAS as peças na quantidade cheia e ela
//    zerava uma a uma. Agora a prévia lista as peças e ela marca as que voltam
//    (`selecaoInicial`, `itensMarcados`).
//
// Módulo PURO: sem React, sem fetch, sem DOM.

import { parseChaveAcesso, validarChaveAcesso } from "@/app/fiscal/domain/chave-acesso-dv";
import type { TipoDevolucao } from "@/app/fiscal/devolucao/tipos";
import type { PreviaDevolucaoManual } from "@/app/usecases/nfe-devolucao.usecase";

// ─────────────────────────────── números digitados ───────────────────────────────

export type LeituraNumero = { ok: true; valor: number } | { ok: false; mensagem: string };

/**
 * Lê o número como a pessoa digita no Brasil.
 *
 *  - vírgula é o separador de centavos: "12,50" → 12.5; "1.234,56" → 1234.56
 *    (pontos antes da vírgula só como milhar: "1.23,4" é recusado);
 *  - ponto sozinho também serve de decimal ("12.50" → 12.5), como o servidor aceita;
 *  - vários pontos só como milhar: "1.234.567" → 1234567;
 *  - dinheiro com ponto e EXATAMENTE 3 casas ("1.234") é ambíguo — mil duzentos e
 *    trinta e quatro reais, ou um real e vinte e três? — e é recusado com o jeito
 *    certo de escrever. Aceitar calado dividiria o valor por mil;
 *  - no máximo `casas` casas decimais (quantidade: 4, como o servidor exige).
 */
export function lerNumeroDigitado(
  texto: string,
  opts: { casas: number; dinheiro?: boolean },
): LeituraNumero {
  const t = String(texto ?? "").trim().replace(/\s+/g, "").replace(/^R\$/i, "");
  if (t === "") return { ok: false, mensagem: "Preencha este campo." };
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) {
    return { ok: false, mensagem: "Use só números, com vírgula nos centavos (ex.: 45,90)." };
  }
  let inteiro: string;
  let decimal = "";
  if (t.includes(",")) {
    const partes = t.split(",");
    if (partes.length !== 2 || partes[1] === "" || !/^\d+$/.test(partes[1])) {
      return { ok: false, mensagem: "Use uma vírgula só, antes dos centavos (ex.: 1.234,56)." };
    }
    if (!/^\d+$/.test(partes[0]) && !/^\d{1,3}(\.\d{3})+$/.test(partes[0])) {
      return { ok: false, mensagem: "O ponto só separa milhar (ex.: 1.234,56)." };
    }
    inteiro = partes[0].replace(/\./g, "");
    decimal = partes[1];
  } else if ((t.match(/\./g) ?? []).length === 1) {
    const [a, b] = t.split(".");
    if (a === "" || b === "") return { ok: false, mensagem: "Número incompleto." };
    if (opts.dinheiro && b.length === 3) {
      return {
        ok: false,
        mensagem: `"${t}" ficou ambíguo. Para mil e poucos reais escreva ${a}${b} ou ${a}.${b},00; para centavos use vírgula (${a},${b.slice(0, 2)}).`,
      };
    }
    inteiro = a;
    decimal = b;
  } else if (t.includes(".")) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(t)) return { ok: false, mensagem: "O ponto só separa milhar (ex.: 1.234.567)." };
    inteiro = t.replace(/\./g, "");
  } else {
    inteiro = t;
  }
  if (decimal.length > opts.casas) {
    return {
      ok: false,
      mensagem: opts.casas === 0 ? "Use um número inteiro." : `Use no máximo ${opts.casas} casas depois da vírgula.`,
    };
  }
  const valor = Number(decimal ? `${inteiro}.${decimal}` : inteiro);
  if (!Number.isFinite(valor)) return { ok: false, mensagem: "Número inválido." };
  if (valor <= 0) return { ok: false, mensagem: "Precisa ser maior que zero." };
  return { ok: true, valor };
}

/** Número do item na nota original: inteiro de 1 a 990 (o servidor recusa texto e decimal). */
export function lerNItemDigitado(texto: string): LeituraNumero {
  const t = String(texto ?? "").trim();
  if (t === "") return { ok: false, mensagem: "Informe o número do item na nota original." };
  if (!/^\d+$/.test(t)) return { ok: false, mensagem: "Só o número do item, sem letras nem vírgula (ex.: 3)." };
  const n = Number(t);
  if (n < 1 || n > 990) return { ok: false, mensagem: "O item da nota original vai de 1 a 990." };
  return { ok: true, valor: n };
}

/** Número → texto para o campo, com vírgula (prefill a partir da nota do Dexo). */
export function numeroParaCampo(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return String(n).replace(".", ",");
}

// ─────────────────────────────── chave de acesso ───────────────────────────────

export interface ChaveDigitadaView {
  vazia: boolean;
  ok: boolean;
  /** "Faltam 8 dígitos.", "Chave de NF-e nº 1234, série 1, emitida em SC." … */
  mensagem: string;
  /** 44 dígitos, quando ok. */
  chave: string | null;
}

/** Conferência AO VIVO da chave digitada ou colada (com espaços, pontos, hífens). */
export function conferirChaveDigitada(texto: string): ChaveDigitadaView {
  if (String(texto ?? "").trim() === "") return { vazia: true, ok: false, mensagem: "", chave: null };
  const r = validarChaveAcesso(texto);
  if (!r.ok) return { vazia: false, ok: false, mensagem: r.mensagem, chave: null };
  const p = r.partes;
  return {
    vazia: false,
    ok: true,
    mensagem: `Chave conferida: ${p.modelo === "65" ? "NFC-e" : "NF-e"} nº ${p.numero}, série ${p.serie}${p.uf ? `, emitida em ${p.uf}` : ""}.`,
    chave: r.chave,
  };
}

function formatarDoc(doc: string): string {
  if (doc.length === 11) return `${doc.slice(0, 3)}.${doc.slice(3, 6)}.${doc.slice(6, 9)}-${doc.slice(9)}`;
  if (doc.length === 14) return `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5, 8)}/${doc.slice(8, 12)}-${doc.slice(12)}`;
  return doc;
}

export interface DestinatarioDaChave {
  tipoPessoa: "PF" | "PJ";
  /** Formatado para a tela; o servidor compara só os dígitos. */
  cpfCnpj: string;
  uf: string | null;
}

function dvModulo11(base: string, pesos: number[]): number {
  const soma = base.split("").reduce((s, d, i) => s + Number(d) * pesos[i], 0);
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

function cnpjValido(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, ...p1];
  return dvModulo11(d.slice(0, 12), p1) === Number(d[12]) && dvModulo11(d.slice(0, 13), p2) === Number(d[13]);
}

function cpfValido(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const p1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [11, ...p1];
  return dvModulo11(d.slice(0, 9), p1) === Number(d[9]) && dvModulo11(d.slice(0, 10), p2) === Number(d[10]);
}

/**
 * Na devolução de COMPRA, o destinatário é o fornecedor que EMITIU a nota: o
 * CNPJ (ou "000"+CPF, para emitente pessoa física) e a UF estão dentro da
 * chave. "000" no começo não basta para dizer CPF — há CNPJ que começa assim
 * (00.000.000/0001-91) —, então decide pelo dígito verificador, e no empate
 * fica com CNPJ (fornecedor de peça é quase sempre empresa). Chave inválida ⇒ null.
 */
export function destinatarioPelaChave(texto: string): DestinatarioDaChave | null {
  const r = validarChaveAcesso(texto);
  if (!r.ok) return null;
  const p = parseChaveAcesso(r.chave);
  if (!p) return null;
  const ehCpf = p.cnpjCpf.startsWith("000") && cpfValido(p.cnpjCpf.slice(3)) && !cnpjValido(p.cnpjCpf);
  const doc = ehCpf ? p.cnpjCpf.slice(3) : p.cnpjCpf;
  return { tipoPessoa: ehCpf ? "PF" : "PJ", cpfCnpj: formatarDoc(doc), uf: p.uf };
}

export const DESTINATARIO_TRAVADO_PELA_CHAVE =
  "Na devolução de compra, quem recebe a nota é o fornecedor que a emitiu: o CNPJ e a UF vêm da própria chave.";

// ─────────────────────────────── erros do servidor ───────────────────────────────

export interface ErroCampoTela {
  campo: string;
  mensagem: string;
  nItem?: number;
}

export interface ErrosDaResposta {
  /** Frase do topo: a do servidor, ou "Confira os campos marcados." quando há `erros`. */
  geral: string;
  campos: ErroCampoTela[];
}

export const CONFIRA_OS_CAMPOS = "Confira os campos marcados abaixo.";

/**
 * O envelope de erro da devolução: `{ error, code, erros?: [{campo, mensagem, nItem?}] }`.
 * `erros` é o que diz O QUE está errado — e era descartado.
 */
export function lerErrosDaResposta(corpo: unknown, fallback = "Não foi possível criar a devolução."): ErrosDaResposta {
  const o = corpo && typeof corpo === "object" ? (corpo as { error?: unknown; erros?: unknown }) : {};
  const campos: ErroCampoTela[] = Array.isArray(o.erros)
    ? o.erros
        .filter((e): e is { campo?: unknown; mensagem: string; nItem?: unknown } =>
          !!e && typeof e === "object" && typeof (e as { mensagem?: unknown }).mensagem === "string")
        .map((e) => ({
          campo: typeof e.campo === "string" ? e.campo : "",
          mensagem: e.mensagem,
          ...(typeof e.nItem === "number" ? { nItem: e.nItem } : {}),
        }))
    : [];
  const servidor = typeof o.error === "string" && o.error.trim() !== "" ? o.error.trim() : null;
  return { geral: campos.length ? CONFIRA_OS_CAMPOS : servidor ?? fallback, campos };
}

/** As mensagens de um campo ("chaveAcesso", "destinatario.uf", "itens[2].ncm"). */
export function errosDoCampo(erros: readonly ErroCampoTela[], campo: string): string[] {
  return erros.filter((e) => e.campo === campo).map((e) => e.mensagem);
}

/** Erros de um item da seleção pelo XML: pelo `nItem` do envelope, ou pelo índice enviado. */
export function errosDoItemXml(erros: readonly ErroCampoTela[], nItem: number, indiceEnviado: number): string[] {
  return erros
    .filter((e) => e.nItem === nItem || (e.nItem === undefined && new RegExp(`^itens\\[${indiceEnviado}\\]`).test(e.campo)))
    .map((e) => e.mensagem);
}

/** Campos que a tela mostra junto de um campo: o que sobra vai na lista geral, nada se perde. */
export function errosSemCampoNaTela(erros: readonly ErroCampoTela[], camposNaTela: (campo: string) => boolean): string[] {
  return erros.filter((e) => !camposNaTela(e.campo)).map((e) => e.mensagem);
}

// ─────────────────────────────── seleção pelo XML (prévia) ───────────────────────────────

export type ItemPrevia = PreviaDevolucaoManual["itens"][number];

export interface SelecaoItem {
  marcado: boolean;
  /** Texto do campo; nasce com o que ainda pode ser devolvido. */
  quantidade: string;
}

/** Nada marcado de saída: ela escolhe as peças que voltam — o Dexo não escolhe por ela. */
export function selecaoInicial(previa: Pick<PreviaDevolucaoManual, "itens">): Record<number, SelecaoItem> {
  const s: Record<number, SelecaoItem> = {};
  for (const i of previa.itens) s[i.nItem] = { marcado: false, quantidade: numeroParaCampo(i.disponivel ?? i.quantidadeOriginal) };
  return s;
}

/** Peça que não tem mais saldo para devolver (já devolvida, ou em outra devolução em envio). */
export function semSaldo(i: Pick<ItemPrevia, "disponivel">): boolean {
  return i.disponivel !== null && i.disponivel <= 0;
}

export function descricaoSaldo(i: ItemPrevia): string {
  const partes: string[] = [];
  if (i.quantidadeOriginal !== null) partes.push(`Na nota: ${numeroParaCampo(i.quantidadeOriginal)} ${i.unidade}`);
  if (i.devolvidaAutorizada > 0) partes.push(`já devolvida: ${numeroParaCampo(i.devolvidaAutorizada)}`);
  if (i.emProcessamento > 0) partes.push(`em envio: ${numeroParaCampo(i.emProcessamento)}`);
  if (i.disponivel !== null) partes.push(`pode devolver: ${numeroParaCampo(i.disponivel)}`);
  if (i.emRascunho > 0) partes.push(`em outro rascunho: ${numeroParaCampo(i.emRascunho)}`);
  return partes.join(" · ");
}

/** Aviso do CFOP: sem sugestão, a escolha fica para o passo Produtos. */
export function avisoCfop(i: Pick<ItemPrevia, "cfopSugerido" | "cfopOriginal" | "cfopOpcoes">): string | null {
  if (i.cfopSugerido) return null;
  if (i.cfopOpcoes.length > 1) return `CFOP de devolução: escolha entre ${i.cfopOpcoes.join(", ")} no passo Produtos.`;
  return `O Dexo não achou um CFOP de devolução para o CFOP ${i.cfopOriginal ?? "desta peça"}: você escolhe no passo Produtos.`;
}

export type LeituraSelecao =
  | { ok: true; itens: Array<{ nItem: number; quantidade: number }> }
  | { ok: false; nenhum: true; mensagem: string }
  | { ok: false; nenhum: false; porItem: Record<number, string> };

export const ESCOLHA_UMA_PECA = "Marque pelo menos uma peça que está voltando.";

/** As peças marcadas, com a quantidade lida e conferida contra o que ainda pode ser devolvido. */
export function itensMarcados(previa: Pick<PreviaDevolucaoManual, "itens">, selecao: Record<number, SelecaoItem>): LeituraSelecao {
  const porItem: Record<number, string> = {};
  const itens: Array<{ nItem: number; quantidade: number }> = [];
  for (const i of previa.itens) {
    const s = selecao[i.nItem];
    if (!s?.marcado) continue;
    const q = lerNumeroDigitado(s.quantidade, { casas: 4 });
    if (!q.ok) {
      porItem[i.nItem] = q.mensagem;
      continue;
    }
    if (i.disponivel !== null && q.valor > i.disponivel) {
      porItem[i.nItem] = `Só dá para devolver ${numeroParaCampo(i.disponivel)} desta peça.`;
      continue;
    }
    itens.push({ nItem: i.nItem, quantidade: q.valor });
  }
  if (Object.keys(porItem).length) return { ok: false, nenhum: false, porItem };
  if (!itens.length) return { ok: false, nenhum: true, mensagem: ESCOLHA_UMA_PECA };
  return { ok: true, itens };
}

/** Texto do rascunho já aberto desta nota (a criação vai reabrir ele). */
export function avisoRascunhoAberto(tipo: TipoDevolucao): string {
  return `Você já tem uma devolução ${tipo === "COMPRA_SAIDA" ? "de compra" : "de venda"} desta nota em andamento. Criar de novo abre ela, com as peças que já estão lá — para escolher outras peças, ajuste no passo Produtos ou descarte a antiga em "Devoluções em andamento".`;
}

// ─────────────────────────────── itens digitados (pela chave) ───────────────────────────────

export interface LinhaItemDigitado {
  nItem: string;
  codigo: string;
  descricao: string;
  ncm: string;
  unidade: string;
  cfopOriginal: string;
  valorUnitario: string;
  quantidade: string;
}

export const LINHA_VAZIA: LinhaItemDigitado = {
  nItem: "1",
  codigo: "",
  descricao: "",
  ncm: "",
  unidade: "UN",
  cfopOriginal: "",
  valorUnitario: "",
  quantidade: "1",
};

export type ItemDigitadoLido = {
  nItem: number;
  codigo: string;
  descricao: string;
  ncm: string;
  unidade: string;
  cfopOriginal: string | null;
  valorUnitario: number;
  quantidade: number;
};

/**
 * Converte as linhas digitadas no corpo do POST. Erro de digitação fica NO
 * CAMPO, com a mesma chave que o servidor usaria ("itens[0].valorUnitario"),
 * e nada é enviado — o servidor recusaria com a frase genérica.
 */
export function lerItensDigitados(linhas: readonly LinhaItemDigitado[]): { itens: ItemDigitadoLido[]; erros: ErroCampoTela[] } {
  const erros: ErroCampoTela[] = [];
  const itens: ItemDigitadoLido[] = [];
  linhas.forEach((l, i) => {
    const p = `itens[${i}].`;
    const nItem = lerNItemDigitado(l.nItem);
    if (!nItem.ok) erros.push({ campo: `${p}nItem`, mensagem: nItem.mensagem });
    const valor = lerNumeroDigitado(l.valorUnitario, { casas: 10, dinheiro: true });
    if (!valor.ok) erros.push({ campo: `${p}valorUnitario`, mensagem: valor.mensagem });
    const qtd = lerNumeroDigitado(l.quantidade, { casas: 4 });
    if (!qtd.ok) erros.push({ campo: `${p}quantidade`, mensagem: qtd.mensagem });
    const ncm = l.ncm.replace(/\D/g, "");
    if (ncm.length !== 8) erros.push({ campo: `${p}ncm`, mensagem: "NCM com 8 dígitos." });
    const cfop = l.cfopOriginal.replace(/\D/g, "");
    if (cfop !== "" && cfop.length !== 4) erros.push({ campo: `${p}cfopOriginal`, mensagem: "CFOP com 4 dígitos." });
    if (l.codigo.trim() === "") erros.push({ campo: `${p}codigo`, mensagem: "Informe o código da peça na nota." });
    if (l.descricao.trim() === "") erros.push({ campo: `${p}descricao`, mensagem: "Informe a descrição da peça na nota." });
    if (l.unidade.trim() === "") erros.push({ campo: `${p}unidade`, mensagem: "Informe a unidade (UN, PC…)." });
    if (nItem.ok && valor.ok && qtd.ok) {
      itens.push({
        nItem: nItem.valor,
        codigo: l.codigo.trim(),
        descricao: l.descricao.trim(),
        ncm,
        unidade: l.unidade.trim().toUpperCase(),
        cfopOriginal: cfop === "" ? null : cfop,
        valorUnitario: valor.valor,
        quantidade: qtd.valor,
      });
    }
  });
  return { itens, erros };
}

/**
 * Linhas a partir de uma nota do Dexo (botão "Devolver pela chave" numa venda
 * sem XML guardado): nItem = número do item, CFOP da venda, valores com vírgula.
 */
export function linhasDaNota(itens: ReadonlyArray<{
  numero: number;
  codigo?: string | null;
  descricao?: string | null;
  ncm?: string | null;
  unidade?: string | null;
  cfop?: string | null;
  valorUnitario?: number | string | null;
  quantidade?: number | string | null;
}>): LinhaItemDigitado[] {
  return itens.map((i) => ({
    nItem: String(i.numero),
    codigo: i.codigo ?? "",
    descricao: i.descricao ?? "",
    ncm: i.ncm ?? "",
    unidade: i.unidade ?? "UN",
    cfopOriginal: i.cfop ?? "",
    valorUnitario: numeroParaCampo(i.valorUnitario === null || i.valorUnitario === undefined ? null : Number(i.valorUnitario)),
    quantidade: numeroParaCampo(i.quantidade === null || i.quantidade === undefined ? null : Number(i.quantidade)),
  }));
}

/** Param da lista que abre o quadro já preenchido com uma nota do Dexo. */
export const PARAM_DEVOLVER_PELA_CHAVE = "devolverPelaChave";

export function urlDevolverPelaChave(nfeId: string): string {
  return `/notas-fiscais/emitidas?${PARAM_DEVOLVER_PELA_CHAVE}=${encodeURIComponent(nfeId)}`;
}

export function notaParaDevolverPelaChave(search: string): string | null {
  const id = new URLSearchParams(search).get(PARAM_DEVOLVER_PELA_CHAVE);
  return id && id.trim() !== "" ? id : null;
}

export const AVISO_PELA_CHAVE_PREENCHIDA =
  "Preenchido com a sua nota de venda. Deixe só as peças que estão voltando (\"Tirar esta peça\") e ajuste a quantidade de cada uma.";
