// Textos do aviso de conta de marketplace com problema.
//
// Puros de propósito (sem React, sem fetch): é o que o lojista LÊ, e cada frase
// foi aprovada pelo dono do produto em 17/09/2026. O teste trava o texto.

export type AccountHealthKind = "parada" | "desconectada";

export interface AccountHealthProblem {
  id: string;
  platform: string;
  accountName: string | null;
  tipo: AccountHealthKind;
  ultimoPedidoEm: string | null;
  anunciosAVenda: number;
  /**
   * Os anúncios estão de fato sem baixa automática. Falso quando a conta está
   * em ERROR mas o token ainda vale — a quantidade continua sendo enviada.
   * Ausente ⇒ tratado como verdadeiro (resposta de versão anterior da API).
   */
  semBaixa?: boolean;
}

export type AccountHealthAction =
  | { tipo: "link"; rotulo: string; href: string }
  | { tipo: "texto"; texto: string };

export interface AccountHealthMessage {
  titulo: string;
  detalhe: string | null;
  acao: AccountHealthAction | null;
}

const PLATAFORMA_LABEL: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
  OLX: "OLX",
  FACEBOOK: "Facebook",
};

const PLATAFORMA_ROTA: Record<string, string> = {
  MERCADO_LIVRE: "/integracoes/mercado-livre",
  SHOPEE: "/integracoes/shopee",
  MAGALU: "/integracoes/magalu",
  OLX: "/integracoes/olx",
  FACEBOOK: "/integracoes/facebook",
};

export function nomeDaPlataforma(platform: string): string {
  return PLATAFORMA_LABEL[platform] ?? platform;
}

export function rotaDaIntegracao(platform: string): string {
  return PLATAFORMA_ROTA[platform] ?? "/integracoes";
}

/**
 * A conta é da integração aberta na tela? Ali o bloco da própria aba já avisa,
 * então a faixa do topo não repete — mas continua avisando das OUTRAS
 * plataformas.
 */
export function ehDaPaginaAtual(
  platform: string,
  pathname: string | null | undefined,
): boolean {
  if (!pathname) return false;
  const rota = PLATAFORMA_ROTA[platform];
  if (!rota) return false;
  return pathname === rota || pathname.startsWith(`${rota}/`);
}

/** "02/09 às 10:03", no fuso de São Paulo. */
export function formatarDiaEHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const partes = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Sao_Paulo",
  }).formatToParts(d);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")} às ${get("hour")}:${get("minute")}`;
}

export function quantidade(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(n);
}

export interface MessageOptions {
  /** Colaborador não reconecta: o botão vira orientação. */
  colaborador: boolean;
  /**
   * Já está na página da integração: não há para onde levar, o botão de
   * conexão está logo abaixo.
   */
  naPaginaDaIntegracao?: boolean;
}

export function mensagemDaConta(
  conta: AccountHealthProblem,
  opts: MessageOptions,
): AccountHealthMessage {
  const plataforma = nomeDaPlataforma(conta.platform);
  const nome = conta.accountName?.trim() || "sem nome";
  const n = conta.anunciosAVenda;
  const semBaixa = conta.semBaixa !== false;

  let acao: AccountHealthAction | null;
  if (opts.colaborador) {
    acao = {
      tipo: "texto",
      texto: "Peça ao administrador da conta para reconectar.",
    };
  } else if (opts.naPaginaDaIntegracao) {
    acao = {
      tipo: "texto",
      texto: "Reconecte pelo botão de conexão desta página.",
    };
  } else {
    acao = {
      tipo: "link",
      rotulo: "Reconectar conta",
      href: rotaDaIntegracao(conta.platform),
    };
  }

  if (conta.tipo === "parada") {
    const partes: string[] = [];
    if (conta.ultimoPedidoEm) {
      const quando = formatarDiaEHora(conta.ultimoPedidoEm);
      if (quando) partes.push(`Último pedido importado em ${quando}.`);
    }
    if (n > 0 && semBaixa) {
      partes.push(
        n === 1
          ? "1 anúncio segue à venda sem baixa automática de estoque."
          : `${quantidade(n)} anúncios seguem à venda sem baixa automática de estoque.`,
      );
    }
    return {
      titulo: `${plataforma} · ${nome} parou de receber pedidos.`,
      detalhe: partes.length ? partes.join(" ") : null,
      acao,
    };
  }

  return {
    titulo:
      n === 1
        ? `${plataforma} · ${nome} está desconectada, mas 1 anúncio continua à venda sem baixa automática de estoque.`
        : `${plataforma} · ${nome} está desconectada, mas ${quantidade(n)} anúncios continuam à venda sem baixa automática de estoque.`,
    detalhe: `Reconecte a conta ou pause os anúncios no ${plataforma}.`,
    acao,
  };
}

/**
 * "Dispensar" de conta desconectada vale ATÉ A SITUAÇÃO PIORAR: o aviso volta
 * só se houver mais anúncios à venda do que quando foi dispensado. Desconexão
 * costuma ser decisão (ex.: contas do dono anterior de uma loja comprada, que
 * o lojista nem consegue reconectar) — reaparecer toda semana seria ruído.
 * A conta PARADA não se dispensa.
 */
export function dispensaCobre(
  anunciosQuandoDispensou: string | null | undefined,
  anunciosAgora: number,
): boolean {
  if (anunciosQuandoDispensou == null || anunciosQuandoDispensou === "") {
    return false;
  }
  const antes = Number(anunciosQuandoDispensou);
  if (!Number.isFinite(antes)) return false;
  return anunciosAgora <= antes;
}

/** Quantas desconectadas a faixa mostra antes de resumir em "e mais N". */
export const MAX_DESCONECTADAS_NA_FAIXA = 2;

export function resumoDasOcultas(n: number): string {
  return n === 1
    ? "E mais 1 conta desconectada com anúncio à venda."
    : `E mais ${n} contas desconectadas com anúncio à venda.`;
}
