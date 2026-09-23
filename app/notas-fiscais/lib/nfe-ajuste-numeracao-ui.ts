// Decisões de tela do ajuste manual do próximo número da série (POST
// /fiscal/nfe/proximo-numero/ajuste), em módulo puro para serem testadas em
// node — mesmo motivo do `nfe-numeracao-ui.ts` ao lado (o jsdom do projeto
// está quebrado).
//
// Regra de ouro: quem decide é o SERVIDOR. Aqui não se reimplementa "só
// avança" nem se adivinha o contador — o caso de uso relê a sequência, recusa
// `novo <= atual` e devolve o número real em `detalhes`. Este módulo só
// prepara o corpo, formata o que o operador lê e traduz a resposta em
// desfecho de tela.

export type AmbienteAjuste = "PRODUCAO" | "HOMOLOGACAO";
export type ModeloAjuste = "55" | "65";
export type CampoAjuste =
  | "ambiente"
  | "modelo"
  | "serie"
  | "proximoNumero"
  | "motivo";

/** Mesmos limites do `NfeSequenceAjusteUseCase` — a tela avisa antes do 400. */
export const MOTIVO_MIN = 15;
export const MOTIVO_MAX = 500;
export const SERIE_MAX = 999;
/** nNF tem 9 dígitos na chave de acesso. */
export const NUMERO_MAX = 999999999;

export const AMBIENTE_LABEL: Record<AmbienteAjuste, string> = {
  PRODUCAO: "Produção",
  HOMOLOGACAO: "Homologação (teste)",
};

export const MODELO_LABEL: Record<ModeloAjuste, string> = {
  "55": "NF-e (modelo 55)",
  "65": "NFC-e do PDV (modelo 65)",
};

/** Campos da tela — texto cru dos inputs, como no form de inutilização. */
export interface FormAjuste {
  ambiente: AmbienteAjuste;
  modelo: ModeloAjuste;
  serie: string;
  proximoNumero: string;
  motivo: string;
}

// ── Validação dos campos ──

/** Inteiro do input de texto; qualquer sujeira (vazio, "1.5", "abc") vira null. */
export function inteiroDoCampo(valor: string): number | null {
  const texto = (valor ?? "").trim();
  if (!/^\d+$/.test(texto)) return null;
  const n = Number(texto);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Erros por campo, com as MESMAS réguas do servidor. Não substitui a validação
 * de lá (que é a que vale): serve para o operador não gastar uma ida ao
 * servidor por causa de um motivo curto demais.
 */
export function errosDoForm(f: FormAjuste): Partial<Record<CampoAjuste, string>> {
  const erros: Partial<Record<CampoAjuste, string>> = {};

  const serie = inteiroDoCampo(f.serie);
  if (serie === null || serie > SERIE_MAX) {
    erros.serie = `Informe a série (número inteiro de 0 a ${SERIE_MAX}).`;
  }

  const numero = inteiroDoCampo(f.proximoNumero);
  if (numero === null || numero < 1 || numero > NUMERO_MAX) {
    erros.proximoNumero = "Informe o próximo número que esta série deve usar.";
  }

  const motivo = (f.motivo ?? "").trim();
  if (motivo.length < MOTIVO_MIN) {
    erros.motivo = `Escreva o motivo com pelo menos ${MOTIVO_MIN} caracteres — ele fica registrado em nome de quem fez o ajuste.`;
  } else if (motivo.length > MOTIVO_MAX) {
    erros.motivo = `Motivo muito longo (máximo ${MOTIVO_MAX} caracteres).`;
  }

  return erros;
}

export function podeRevisar(f: FormAjuste): boolean {
  return Object.keys(errosDoForm(f)).length === 0;
}

/**
 * Quantos números ficam sem uso. `null` quando não dá para afirmar: contador
 * atual desconhecido, campo inválido, ou número que não avança (aí o servidor
 * recusa com SEQUENCIA_NAO_RETROCEDE e não existe "pulo" a mostrar).
 */
export function numerosPulados(
  atual: number | null | undefined,
  novo: number | null | undefined,
): number | null {
  if (!Number.isInteger(atual) || !Number.isInteger(novo)) return null;
  const a = atual as number;
  const n = novo as number;
  if (n <= a) return null;
  return n - a;
}

// ── Leitura do contador atual ──

/** Corpo de GET /fiscal/nfe/proximo-numero. */
export interface RespostaPreview {
  serie?: number;
  ambiente?: string;
  proximoNumero?: number;
}

/**
 * O preview é do modelo 55 e do ambiente SALVO na configuração — ele não
 * recebe `modelo` nem `ambiente` (fiscal.routes.ts: `ambiente` sai de
 * `config.ambiente` e o modelo é fixo "55"). Então ele só serve como "número
 * atual" quando o que está na tela bate com o que a resposta devolveu.
 *
 * Fora disso o número atual fica desconhecido até a revisão, e é isso que a
 * tela tem de dizer: mostrar o contador de produção enquanto o operador mira
 * homologação seria a mesma classe de erro que mover o contador do CNPJ
 * errado.
 */
export function numeroAtualDoPreview(
  resposta: RespostaPreview | null | undefined,
  alvo: Pick<FormAjuste, "ambiente" | "modelo" | "serie">,
): number | null {
  if (!resposta || !Number.isInteger(resposta.proximoNumero)) return null;
  if (alvo.modelo !== "55") return null;
  if (resposta.ambiente !== alvo.ambiente) return null;
  if (resposta.serie !== inteiroDoCampo(alvo.serie)) return null;
  return resposta.proximoNumero as number;
}

// ── Corpo da requisição ──

export interface CorpoAjuste {
  companyFiscalConfigId: string | null;
  ambiente: AmbienteAjuste;
  modelo: ModeloAjuste;
  serie: number;
  proximoNumero: number;
  motivo: string;
  confirmar: boolean;
}

/**
 * Primeiro passo: sem `confirmar`. `companyFiscalConfigId` vem do formulário
 * que está aberto (null = CNPJ padrão do tenant), nunca de um seletor próprio
 * — o escopo do ajuste é o mesmo emitente que o operador está editando.
 */
export function corpoAjuste(
  f: FormAjuste,
  companyFiscalConfigId: string | null,
): CorpoAjuste {
  return {
    companyFiscalConfigId,
    ambiente: f.ambiente,
    modelo: f.modelo,
    serie: inteiroDoCampo(f.serie) ?? -1,
    proximoNumero: inteiroDoCampo(f.proximoNumero) ?? -1,
    motivo: (f.motivo ?? "").trim(),
    confirmar: false,
  };
}

/**
 * Segundo passo: o MESMO corpo revisado, com `confirmar: true`. O corpo é
 * congelado no 409 justamente para que editar o formulário por trás do
 * diálogo não troque o que será aplicado.
 */
export function corpoConfirmacao(corpo: CorpoAjuste): CorpoAjuste {
  return { ...corpo, confirmar: true };
}

// ── Desfecho da resposta ──

export interface DetalhesConfirmacao {
  companyFiscalConfigId?: string;
  emitenteDocumento?: string | null;
  ambiente?: string;
  modelo?: string;
  serie?: number;
  proximoNumeroAtual?: number;
  proximoNumeroSolicitado?: number;
  numerosPulados?: number;
  requerInutilizacao?: boolean;
  /** AJUSTE_ENTRADA_INVALIDA: qual campo o servidor recusou. */
  campo?: CampoAjuste;
}

export interface AjusteAplicado {
  companyFiscalConfigId: string;
  emitenteDocumento: string | null;
  ambiente: string;
  modelo: string;
  serie: number;
  proximoNumeroAnterior: number;
  proximoNumero: number;
  numerosPulados: number;
  motivo: string;
  ajustadoEm: string;
}

export interface RespostaAjuste {
  success?: boolean;
  ajuste?: AjusteAplicado;
  error?: string;
  code?: string;
  detalhes?: DetalhesConfirmacao;
}

export type TipoToast = "success" | "error" | "warning" | "info";

export interface DesfechoAjuste {
  /** 409 NUMERACAO_CONFIRMAR_AJUSTE: abre o diálogo. NADA foi escrito ainda. */
  confirmacao: { mensagem: string; detalhes: DetalhesConfirmacao } | null;
  toast: { msg: string; type: TipoToast } | null;
  /** 200: o contador MOVEU — recarregar o preview e limpar o formulário. */
  aplicado: AjusteAplicado | null;
  /** Número atual que a resposta revelou (409s trazem `proximoNumeroAtual`). */
  numeroAtual: number | null;
  /** 400 AJUSTE_ENTRADA_INVALIDA: campo a destacar no formulário. */
  campoInvalido: CampoAjuste | null;
}

const SEM_DESFECHO: DesfechoAjuste = {
  confirmacao: null,
  toast: null,
  aplicado: null,
  numeroAtual: null,
  campoInvalido: null,
};

function numeroAtualDosDetalhes(d?: DetalhesConfirmacao): number | null {
  return Number.isInteger(d?.proximoNumeroAtual)
    ? (d!.proximoNumeroAtual as number)
    : null;
}

/**
 * O que a tela faz com a resposta do POST.
 *
 * Erro SEMPRE com a mensagem do servidor: ela foi escrita para o operador ler
 * (diz o número atual, quantos números pulam e o que fazer), e trocá-la por
 * "Erro ao ajustar" jogaria fora a única instrução útil. O texto genérico só
 * entra quando o corpo não trouxe mensagem nenhuma.
 */
export function desfechoAjuste(
  ok: boolean,
  d: RespostaAjuste | null | undefined,
): DesfechoAjuste {
  const corpo = d ?? {};

  if (ok && corpo.success && corpo.ajuste) {
    const a = corpo.ajuste;
    return {
      ...SEM_DESFECHO,
      aplicado: a,
      numeroAtual: a.proximoNumero,
      toast: {
        msg: `Pronto: a série ${a.serie} vai emitir a partir do nº ${a.proximoNumero}. ${a.numerosPulados} número(s) ficaram sem uso.`,
        type: "success",
      },
    };
  }

  if (corpo.code === "NUMERACAO_CONFIRMAR_AJUSTE") {
    return {
      ...SEM_DESFECHO,
      confirmacao: {
        mensagem: corpo.error ?? "",
        detalhes: corpo.detalhes ?? {},
      },
      numeroAtual: numeroAtualDosDetalhes(corpo.detalhes),
    };
  }

  return {
    ...SEM_DESFECHO,
    toast: {
      msg: corpo.error || "Não foi possível ajustar o próximo número.",
      type: "error",
    },
    numeroAtual: numeroAtualDosDetalhes(corpo.detalhes),
    campoInvalido:
      corpo.code === "AJUSTE_ENTRADA_INVALIDA"
        ? (corpo.detalhes?.campo ?? null)
        : null,
  };
}

// ── Texto da confirmação (dono de desmanche, não contador) ──

export interface LinhaConfirmacao {
  rotulo: string;
  valor: string;
}

const rotuloAmbiente = (a?: string) =>
  AMBIENTE_LABEL[a as AmbienteAjuste] ?? a ?? "—";
const rotuloModelo = (m?: string) => MODELO_LABEL[m as ModeloAjuste] ?? m ?? "—";

function formatarCnpj(cnpj?: string | null): string {
  const d = (cnpj ?? "").replace(/\D/g, "");
  if (d.length !== 14) return cnpj || "—";
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** O "de → para" do diálogo, com o escopo inteiro visível (o CNPJ inclusive). */
export function linhasDaConfirmacao(
  d: DetalhesConfirmacao,
): LinhaConfirmacao[] {
  const pulados = Number.isInteger(d.numerosPulados)
    ? (d.numerosPulados as number)
    : numerosPulados(d.proximoNumeroAtual, d.proximoNumeroSolicitado);
  return [
    { rotulo: "CNPJ que emite", valor: formatarCnpj(d.emitenteDocumento) },
    { rotulo: "Ambiente", valor: rotuloAmbiente(d.ambiente) },
    { rotulo: "Tipo de nota", valor: rotuloModelo(d.modelo) },
    { rotulo: "Série", valor: d.serie === undefined ? "—" : String(d.serie) },
    {
      rotulo: "Próximo número hoje",
      valor: d.proximoNumeroAtual === undefined ? "—" : String(d.proximoNumeroAtual),
    },
    {
      rotulo: "Passa a ser",
      valor:
        d.proximoNumeroSolicitado === undefined
          ? "—"
          : String(d.proximoNumeroSolicitado),
    },
    {
      rotulo: "Números que ficam sem uso",
      valor: pulados === null ? "—" : String(pulados),
    },
  ];
}

/**
 * O aviso da lacuna, em português de galpão. `requerInutilizacao` é o campo
 * que o servidor mandou justamente para a tela escolher o tom: em homologação
 * a lacuna não vira obrigação nenhuma.
 */
export function avisoInutilizacao(d: DetalhesConfirmacao): string {
  const pulados = Number.isInteger(d.numerosPulados)
    ? (d.numerosPulados as number)
    : numerosPulados(d.proximoNumeroAtual, d.proximoNumeroSolicitado);
  const quantos = pulados === null ? "Os números" : `Os ${pulados} números`;
  if (d.requerInutilizacao === false) {
    return `${quantos} que ficam para trás não serão usados. Como isto é o ambiente de teste, nada precisa ser feito com eles.`;
  }
  return `${quantos} que ficam para trás nunca mais serão usados por esta série. Esse buraco na numeração pode ter de ser inutilizado junto à SEFAZ — combine com o seu contador antes de confirmar.`;
}
