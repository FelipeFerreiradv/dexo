// A devolução do Dexo está ligada para esta conta? E em quais empresas (CNPJ)?
// Módulo puro (o `fetch` vem por parâmetro), testado em node — mesmo desenho do
// `nfe-devolucoes-abertas-ui.ts` ao lado.
//
// Fonte: GET /fiscal/nfe/devolucao/disponibilidade (`DisponibilidadeDevolucaoResposta`).
//  - 404 = nenhuma empresa da conta tem a devolução ligada: a lista de Notas
//    Emitidas fica exatamente como era (nem "Devolução manual", nem
//    "Devoluções em andamento").
//  - `empresas` (novo): as empresas com a devolução ligada, a padrão primeiro —
//    é dela que sai o seletor de CNPJ da devolução manual. Servidor antigo não
//    manda: vale só o `companyFiscalConfigId`, como antes.
//  - `companyFiscalConfigId` null com mais de uma ligada = a tela PERGUNTA qual
//    empresa emite; o Dexo não escolhe por ela.
//
// Por que existe: "Devoluções em andamento" chamava GET /abertas em TODA carga
// da lista, de TODO cliente — 404 e uma consulta ao banco para quem nem tem a
// devolução. Agora pergunta antes se está ligada; e as duas caixas da lista
// (manual e em andamento) dividem UMA pergunta quando montam juntas.

import type { DisponibilidadeDevolucaoResposta, EmpresaComDevolucao } from "@/app/fiscal/devolucao/contrato";

export interface DisponibilidadeLida {
  /** A devolução está ligada em pelo menos uma empresa da conta. */
  ligada: boolean;
  /**
   * A empresa que a tela usa sem perguntar: a padrão (se ligada) ou a única
   * ligada. null = há mais de uma ligada e a padrão não está entre elas — ela escolhe.
   */
  companyFiscalConfigId: string | null;
  /** As empresas ligadas, a padrão primeiro. Servidor antigo: vazia. */
  empresas: EmpresaComDevolucao[];
}

export const DEVOLUCAO_DESLIGADA: DisponibilidadeLida = Object.freeze({
  ligada: false,
  companyFiscalConfigId: null,
  empresas: [],
}) as DisponibilidadeLida;

function empresaValida(e: unknown): e is EmpresaComDevolucao {
  const x = e as Partial<EmpresaComDevolucao> | null;
  return !!x && typeof x.companyFiscalConfigId === "string" && x.companyFiscalConfigId !== "" && typeof x.cnpj === "string";
}

/** Lê a resposta com defesa: qualquer coisa fora do formato = desligada. */
export function lerDisponibilidade(status: number, corpo: unknown): DisponibilidadeLida {
  if (status < 200 || status >= 300 || !corpo || typeof corpo !== "object") return DEVOLUCAO_DESLIGADA;
  const c = corpo as Partial<DisponibilidadeDevolucaoResposta>;
  const empresas = Array.isArray(c.empresas) ? c.empresas.filter(empresaValida) : [];
  const informado = typeof c.companyFiscalConfigId === "string" && c.companyFiscalConfigId !== "" ? c.companyFiscalConfigId : null;
  // Uma empresa ligada só: é ela (defesa — o servidor já manda assim). Sem isso
  // a tela pediria para escolher sem ter o que escolher.
  const id = informado ?? (empresas.length === 1 ? empresas[0].companyFiscalConfigId : null);
  if (id === null && empresas.length === 0) return DEVOLUCAO_DESLIGADA;
  return { ligada: true, companyFiscalConfigId: id, empresas };
}

// Pergunta EM ANDAMENTO por conta: a lista monta "Devolução manual" e
// "Devoluções em andamento" no mesmo instante, e as duas querem saber a mesma
// coisa. Só a pergunta em voo é compartilhada — depois de respondida, a próxima
// carga pergunta de novo (a devolução pode ter sido ligada ou desligada).
const emVoo = new Map<string, { f: typeof fetch; p: Promise<DisponibilidadeLida> }>();

export function consultarDisponibilidade(p: {
  base: string;
  email: string;
  fetchImpl?: typeof fetch;
}): Promise<DisponibilidadeLida> {
  const f = p.fetchImpl ?? fetch;
  const chave = `${p.base}|${p.email}`;
  const atual = emVoo.get(chave);
  if (atual && atual.f === f) return atual.p;
  let promessa: Promise<DisponibilidadeLida> | null = null;
  promessa = (async () => {
    try {
      const r = await f(`${p.base}/fiscal/nfe/devolucao/disponibilidade`, { headers: { email: p.email } });
      return lerDisponibilidade(r.status, await r.json().catch(() => null));
    } catch {
      // Rede caída: não afirma que está ligada — a lista fica como era.
      return DEVOLUCAO_DESLIGADA;
    } finally {
      if (emVoo.get(chave)?.p === promessa) emVoo.delete(chave);
    }
  })();
  emVoo.set(chave, { f, p: promessa });
  return promessa;
}

// ───────────────────────── seletor de empresa (devolução manual) ─────────────────────────

export const ROTULO_EMPRESA = "Empresa que emite a devolução";
export const ESCOLHA_A_EMPRESA = "Escolha a empresa (CNPJ) que vai emitir esta devolução.";

function formatarCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : cnpj;
}

/** "DLS AUTO PEÇAS — CNPJ 57.502.966/0001-44 (SC)" — o nome que ela conhece primeiro. */
export function rotuloEmpresa(e: EmpresaComDevolucao): string {
  const nome = (e.nomeFantasia ?? "").trim() || e.razaoSocial.trim() || "Empresa";
  const uf = typeof e.uf === "string" && e.uf.trim() !== "" ? ` (${e.uf.trim().toUpperCase()})` : "";
  const homologacao = e.ambiente === "HOMOLOGACAO" ? " — em homologação (teste, sem valor fiscal)" : "";
  return `${nome} — CNPJ ${formatarCnpj(e.cnpj)}${uf}${homologacao}`;
}

/** O seletor só aparece com duas ou mais empresas ligadas: com uma só, nada muda na tela. */
export function precisaEscolherEmpresa(d: DisponibilidadeLida): boolean {
  return d.empresas.length > 1;
}
