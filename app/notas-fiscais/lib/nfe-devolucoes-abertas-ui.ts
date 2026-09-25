// "Devoluções em andamento" (lista de Notas Emitidas) e o DESCARTE de rascunho,
// em módulo puro para serem testados em node — mesmo motivo do
// `nfe-numeracao-ui.ts` ao lado.
//
// O caso real (DLS AUTO PEÇAS, 24/09/2026): 7 rascunhos de devolução abertos e
// invisíveis — a lista de notas esconde rascunho de propósito ("todo nº é
// real"). Cinco eram da MESMA nota da DISAUTO: cada volta a "Devolução manual"
// criava outro. Um sexto, feito à mão, segurava o nº 712 entre o 711 e o 713
// autorizados. E a tela do passo Impostos dizia que o rascunho "pode ser
// descartado", sem existir botão de descarte em lugar nenhum.
//
// Fonte: GET /fiscal/nfe/devolucao/abertas (`DevolucaoAbertaResumo`). Descartar
// é o DELETE /fiscal/nfe/draft/:id que já existe; com número fiscal preso em
// produção ele responde 409 NUMERACAO_CONFIRMAR_DESCARTE e só descarta com
// `?descartarNumero=true` — a tela explica isso em linguagem de galpão ANTES.
//
// Módulo PURO: sem React e sem DOM. O descarte recebe o `fetch` por parâmetro.

import type { DevolucaoAbertaResumo } from "@/app/usecases/nfe-devolucao.usecase";

export const TITULO_DEVOLUCOES_EM_ANDAMENTO = "Devoluções em andamento";
export const SUBTITULO_DEVOLUCOES_EM_ANDAMENTO =
  "Rascunhos de devolução que ainda não foram emitidos. Continue de onde parou ou descarte o que não vai usar.";
export const ROTULO_CONTINUAR = "Continuar";
export const ROTULO_DESCARTAR = "Descartar";
export const ROTULO_DESCARTAR_CONFIRMADO = "Descartar e soltar o número";
export const ROTULO_CANCELAR = "Cancelar";
export const LINK_INUTILIZAR = "/notas-fiscais/inutilizar-numero";

/** Fuso do desmanche: a data da tela não pode depender do relógio de quem roda o teste. */
const FORMATO_DATA = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

export function dataCurta(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : FORMATO_DATA.format(d).replace(",", "");
}

export interface LinhaDevolucaoAbertaView {
  draftId: string;
  titulo: string;
  /** "Para DISAUTO DISTRIBUIDORA" — quem recebe a devolução; null quando não se sabe. */
  para: string | null;
  /** "NF-e 1234 (série 1)" — a nota original; vazio no rascunho feito à mão. */
  notas: string;
  /** "2 peças". */
  itens: string;
  /** "Começada em 24/09 17:03 · mexida em 24/09 18:47". */
  quando: string;
  podeContinuar: boolean;
  continuarUrl: string | null;
  /** Aviso próprio desta linha (feita à mão, rejeitada). */
  aviso: string | null;
  /** "Há outras 4 devoluções em andamento desta mesma nota…" */
  repetida: string | null;
  /** "Segura o nº 712 (série 1)." */
  numero: string | null;
  /** Em produção, descartar solta o número e ele precisa ser inutilizado. */
  avisoNumero: string | null;
}

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

function tituloDa(a: Pick<DevolucaoAbertaResumo, "gerenciada" | "tipo">): string {
  if (!a.gerenciada) return "Rascunho de devolução feito à mão";
  if (a.tipo === "COMPRA_SAIDA") return "Devolução de compra (ao fornecedor)";
  if (a.tipo === "VENDA_ENTRADA") return "Devolução de venda (do cliente)";
  return "Devolução";
}

export const AVISO_FEITA_A_MAO =
  "Feita à mão: não está amarrada a nenhuma nota, então não emite. Descarte e comece pelo caminho certo (\"Devolução manual\" para compra, \"Devolver\" na nota de venda).";
export const AVISO_REJEITADA =
  "A SEFAZ recusou a última tentativa. Abra, corrija o que ela apontou e emita de novo.";

/** Linhas da tabela, da mexida mais recente para a mais antiga. */
export function viewDevolucoesAbertas(abertas: readonly DevolucaoAbertaResumo[]): LinhaDevolucaoAbertaView[] {
  const porChave = new Map<string, number>();
  for (const a of abertas) {
    const chave = a.originais[0]?.chaveAcesso;
    if (chave && a.gerenciada) porChave.set(`${a.tipo}#${chave}`, (porChave.get(`${a.tipo}#${chave}`) ?? 0) + 1);
  }
  return [...abertas]
    .sort((x, y) => new Date(y.atualizadaEm).getTime() - new Date(x.atualizadaEm).getTime())
    .map((a) => {
      const chave = a.originais[0]?.chaveAcesso;
      const iguais = chave && a.gerenciada ? (porChave.get(`${a.tipo}#${chave}`) ?? 1) - 1 : 0;
      const numero = a.numeracao ? `Segura o nº ${a.numeracao.numero} (série ${a.numeracao.serie}).` : null;
      const avisoNumero =
        a.numeracao && a.numeracao.ambiente === "PRODUCAO"
          ? `Se descartar, o nº ${a.numeracao.numero} fica sem uso e precisa ser inutilizado na SEFAZ até o dia 10 do mês seguinte (Notas Fiscais › Inutilizar número).`
          : null;
      return {
        draftId: a.draftId,
        titulo: tituloDa(a),
        para: a.destinatarioNome ? `Para ${a.destinatarioNome}` : null,
        notas: a.originais.map((o) => `NF-e ${o.numero} (série ${o.serie})`).join(", "),
        itens: plural(a.quantidadeItens, "peça", "peças"),
        quando: `Começada em ${dataCurta(a.criadaEm)} · mexida em ${dataCurta(a.atualizadaEm)}`,
        podeContinuar: a.gerenciada,
        continuarUrl: a.gerenciada ? `/notas-fiscais/nfe?draft=${encodeURIComponent(a.draftId)}` : null,
        aviso: !a.gerenciada ? AVISO_FEITA_A_MAO : a.status === "REJECTED" ? AVISO_REJEITADA : null,
        repetida:
          iguais > 0
            ? `Há ${iguais === 1 ? "outra devolução" : `outras ${iguais} devoluções`} em andamento desta mesma nota. Normalmente só uma é necessária: continue uma e descarte as outras.`
            : null,
        numero,
        avisoNumero,
      };
    });
}

/** Lê o corpo do GET /abertas com defesa: formato inesperado = lista vazia. */
export function lerAbertas(corpo: unknown): DevolucaoAbertaResumo[] {
  const lista = corpo && typeof corpo === "object" ? (corpo as { abertas?: unknown }).abertas : null;
  return Array.isArray(lista)
    ? (lista.filter((a) => a && typeof a === "object" && typeof (a as { draftId?: unknown }).draftId === "string") as DevolucaoAbertaResumo[])
    : [];
}

// ─────────────────────────────── descarte ───────────────────────────────

export type ResultadoDescarte =
  | { ok: true }
  /** 409 NUMERACAO_CONFIRMAR_DESCARTE: pedir a confirmação e repetir com `descartarNumero`. */
  | { ok: false; confirmar: true; mensagem: string }
  | { ok: false; confirmar: false; mensagem: string };

export const DESCARTE_FALHOU = "Não foi possível descartar o rascunho. Tente de novo em instantes.";

/**
 * A frase da confirmação: o que o servidor disse (qual número) + o que isso
 * significa para ela, quando o número vai precisar ser inutilizado.
 */
export function textoConfirmacaoDescarte(mensagemServidor: string | null | undefined): string {
  const base = (mensagemServidor ?? "").trim() || "Este rascunho segura um número fiscal.";
  const inutilizar = /inutilizad/i.test(base)
    ? " A inutilização se pede em Notas Fiscais › Inutilizar número, até o dia 10 do mês seguinte."
    : "";
  return `${base.replace(/\.?$/, ".")}${inutilizar} Descartar mesmo assim?`;
}

/**
 * DELETE /fiscal/nfe/draft/:id. Resultado DISTINGUÍVEL — o `deleteDraft` do hook
 * devolvia `undefined` no sucesso e `false` tanto no erro quanto quando ela
 * cancelava a confirmação.
 */
export async function descartarRascunho(p: {
  base: string;
  email: string;
  draftId: string;
  descartarNumero?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ResultadoDescarte> {
  const f = p.fetchImpl ?? fetch;
  try {
    const res = await f(
      `${p.base}/fiscal/nfe/draft/${encodeURIComponent(p.draftId)}${p.descartarNumero ? "?descartarNumero=true" : ""}`,
      { method: "DELETE", headers: { email: p.email } },
    );
    if (res.ok) return { ok: true };
    const corpo = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const mensagem = typeof corpo.error === "string" && corpo.error.trim() !== "" ? corpo.error : DESCARTE_FALHOU;
    if (res.status === 409 && corpo.code === "NUMERACAO_CONFIRMAR_DESCARTE" && !p.descartarNumero) {
      return { ok: false, confirmar: true, mensagem: textoConfirmacaoDescarte(mensagem) };
    }
    return { ok: false, confirmar: false, mensagem };
  } catch {
    return { ok: false, confirmar: false, mensagem: DESCARTE_FALHOU };
  }
}
