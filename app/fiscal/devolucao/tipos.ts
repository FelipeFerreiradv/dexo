/**
 * NF-e de DEVOLUÇÃO (finNFe=4) — tipos do domínio puro.
 *
 * Compartilhados por: validação/saldo/tributação/montagem (este diretório),
 * repositório e use case de devolução (backend) e o wizard (front).
 * Contrato HTTP (corpos, respostas, códigos de erro) fica em `contrato.ts`.
 *
 * Arquivo SÓ de tipos (sem runtime). Ver docs/fiscal-devolucao.md.
 */

import type { NfeStatus } from "../domain/nfe.types";
import type {
  MapeamentoCfopDevolucao,
  StatusMapeamentoCfop,
} from "../domain/devolucao-cfop";

export type { MapeamentoCfopDevolucao, StatusMapeamentoCfop };

/** VENDA_ENTRADA: o vendedor recebe de volta (tpNF=0). COMPRA_SAIDA: devolve ao fornecedor (tpNF=1). */
export type TipoDevolucao = "VENDA_ENTRADA" | "COMPRA_SAIDA";
export type FonteDevolucao = "DEXO" | "XML_IMPORTADO" | "MANUAL";
export type EscopoDevolucao = "TOTAL" | "PARCIAL";
/** ITEM = det/DFeReferenciado; NOTA = ide/NFref/refNFe. Nunca os dois (rejeição 1010). */
export type ModoReferenciaDevolucao = "ITEM" | "NOTA";
export type IdDest = 1 | 2 | 3;
/** 1=Simples; 2=Simples excesso de sublimite (usa CST); 3=Normal; 4=MEI (usa CSOSN). */
export type CrtEmitente = "1" | "2" | "3" | "4";
export type IndFinalDevolucao = "0" | "1";

// ─────────────────────────────── Issues ───────────────────────────────

export type SeveridadeIssue = "ERRO" | "AVISO";

export type DevolucaoIssueCode =
  // cabeçalho
  | "NAO_GERENCIADA"
  | "ESCOLHA_PENDENTE"
  | "RECUSA_NAO_E_DEVOLUCAO"
  | "FINALIDADE_NAO_DEVOLUCAO"
  | "MODELO_NAO_PERMITIDO"
  | "TIPO_OPERACAO_INCOERENTE"
  | "NFREF_PROIBIDA"
  | "PAGAMENTO_SERA_90"
  | "COBRANCA_NAO_ENVIADA"
  | "SEM_ITENS"
  | "ITENS_DESALINHADOS"
  | "IDDEST_DIVERGENTE_ORIGINAL"
  /** ERRO: regime da empresa não cadastrado — o CRT sairia chutado (Rejeição 590/591). */
  | "REGIME_NAO_CADASTRADO"
  /** AVISO: devolução de venda a cliente com IE — normalmente é ele quem emite a devolução. */
  | "DESTINATARIO_CONTRIBUINTE"
  /** ERRO: devolução de compra com a UF do destinatário diferente da UF da chave do fornecedor. */
  | "DESTINATARIO_UF_DIVERGENTE_CHAVE"
  // referência por item
  | "REFERENCIA_AUSENTE"
  | "CHAVE_INVALIDA"
  | "MODELO_ORIGINAL_NAO_SUPORTADO"
  | "NITEM_INVALIDO"
  | "REFERENCIA_DUPLICADA"
  | "EMITENTES_DIVERSOS"
  | "EMITENTE_ORIGINAL_DIVERGENTE"
  | "DESTINATARIO_NAO_E_EMITENTE_ORIGINAL"
  // CFOP
  | "CFOP_ESCOLHA_PENDENTE"
  | "CFOP_NAO_DEVOLUCAO"
  | "CFOP_SENTIDO_INVALIDO"
  | "CFOP_IDDEST_DIVERGENTE"
  | "CFOP_MEI_NAO_PERMITIDO"
  // quantidade / saldo / original
  | "QUANTIDADE_INVALIDA"
  | "SALDO_EXCEDIDO"
  | "SALDO_NAO_VERIFICAVEL"
  /**
   * AVISO: OUTRA devolução do mesmo item da nota original está em envio à SEFAZ
   * (VALIDATING/SIGNING/SENDING). A quantidade dela já saiu do disponível; se
   * ela for recusada, a quantidade volta. Não impede a emissão.
   */
  | "OUTRA_DEVOLUCAO_EM_ENVIO"
  | "ORIGINAL_CANCELADA"
  | "ORIGINAL_NAO_AUTORIZADA"
  | "AMBIENTE_DIVERGENTE"
  // tributação
  | "TRIBUTACAO_AUSENTE"
  | "TRIBUTACAO_REVISAO_PENDENTE"
  | "TRIBUTACAO_NAO_SUPORTADA"
  | "TRIBUTACAO_REGIME_INCOMPATIVEL"
  | "IPI_DEVOL_INVALIDO"
  | "PIS_CST_SAIDA_EM_ENTRADA"
  | "IBS_CBS_NAO_ENVIADO"
  /** ERRO: PIS/COFINS sem CST, ou com CST que o Dexo não emite (03/05, base por quantidade). */
  | "PIS_COFINS_NAO_SUPORTADO"
  /**
   * ERRO: numa empresa do Simples (CRT 1/2/4), CST que só o regime normal usa —
   * 01/02 (alíquota do regime normal) e os de CRÉDITO (50–56, 60–67).
   */
  | "PIS_COFINS_REGIME_INCOMPATIVEL"
  /** ERRO: CST 01/02 com alíquota zero — alíquota zero é o CST 06. */
  | "PIS_COFINS_ALIQUOTA_INVALIDA"
  /**
   * ERRO: PIS/COFINS com alíquota maior que 0 numa empresa do Simples (CRT 1/2/4) —
   * no Simples o PIS/COFINS vai na guia do Simples, e a alíquota na nota fica 0.
   * A SEFAZ AUTORIZA a nota com o valor destacado; só se desfaz cancelando.
   */
  | "PIS_COFINS_ALIQUOTA_SIMPLES"
  /**
   * ERRO (era AVISO até a decisão 3 do dono): CST de PIS/COFINS de entrada
   * (50–98) numa nota de SAÍDA (devolução de compra). Nenhuma nota de fornecedor
   * traz CST de entrada, então não há herança a proteger. O 99 serve aos dois.
   */
  | "PIS_CST_ENTRADA_EM_SAIDA"
  /** ERRO que a caixinha "Revisei" NÃO libera: a original cobrou ICMS-ST e o Dexo ainda não devolve ST. */
  | "ICMS_ST_NAO_DEVOLVIDO"
  | "ICMS_ORIGEM_NAO_INFORMADA"
  /** AVISO: devolução de compra (Simples ← fora do Simples) com menos ICMS que o proporcional da compra. */
  | "ICMS_COMPRA_A_MENOR"
  /** AVISO: CSOSN 500 num item cuja compra não teve ICMS-ST. */
  | "ICMS_500_SEM_ST"
  // montagem do rascunho
  | "TOTALMENTE_DEVOLVIDA"
  | "PARCIALMENTE_DEVOLVIDA"
  | "JA_E_DEVOLUCAO"
  | "ORIGINAL_ENTRADA"
  | "CHAVE_DIVERGENTE"
  | "XML_SEM_AUTORIZACAO"
  | "EMISSAO_EM_ANDAMENTO"
  | "DESTINATARIO_AUSENTE";

export interface DevolucaoIssue {
  code: DevolucaoIssueCode;
  /** ERRO bloqueia a emissão; AVISO só informa. */
  severidade: SeveridadeIssue;
  /** Posição do item da devolução (1..990), quando a issue é de item. */
  ordem?: number;
  /** pt-BR; cita a rejeição SEFAZ equivalente quando há uma (rastreabilidade). */
  mensagem: string;
  /**
   * A PEÇA a que a issue se refere: nº do item na nota ORIGINAL e a chave dela
   * (as recusas do PUT dos itens mandam; opcional). Com eles a tela acha o cartão
   * sem depender de `ordem`, que muda quando uma peça sai da devolução.
   */
  nItem?: number;
  chaveAcesso?: string;
  /**
   * A DEVOLUÇÃO a que a issue se refere (recusa ORIGINAL_COM_DEVOLUCAO do
   * cancelamento da nota original): o id dela e o nº fiscal — null enquanto
   * não autorizada (rascunho/em envio não têm número fiscal). Opcional.
   */
  devolucaoNfeId?: string;
  numeroDevolucao?: number | null;
  serieDevolucao?: number | null;
}

// ─────────────────────────── Imposto original (XML) ───────────────────────────

export interface IcmsOriginal {
  /** Tag do XML original: "ICMS00", "ICMSSN102"… */
  grupo: string;
  orig: number | null;
  cst?: string;
  csosn?: string;
  modBC?: string;
  vBC?: number;
  pRedBC?: number;
  pICMS?: number;
  vICMS?: number;
  vBCST?: number;
  vICMSST?: number;
  pCredSN?: number;
  vCredICMSSN?: number;
  /**
   * O resto do grupo de ICMS-ST do XML original — guardado para o dia em que o
   * construtor devolver ST (o subgrupo ST do ICMSSN900/ICMS90 exige modBCST e
   * pICMSST, que não se inventam). Só rascunhos criados daqui em diante os têm.
   */
  modBCST?: string;
  pMVAST?: number;
  pRedBCST?: number;
  pICMSST?: number;
  vFCPST?: number;
  /** ST retido antes (CST 60 / CSOSN 500). */
  vBCSTRet?: number;
  pST?: number;
  vICMSSubstituto?: number;
  vICMSSTRet?: number;
}

export interface IpiOriginal {
  /** "IPITrib" | "IPINT" */
  grupo: string;
  cEnq?: string;
  cst: string;
  vBC?: number;
  pIPI?: number;
  vIPI?: number;
}

export interface PisOriginal {
  /** "PISAliq" | "PISQtde" | "PISNT" | "PISOutr" */
  grupo: string;
  cst: string;
  vBC?: number;
  pPIS?: number;
  vPIS?: number;
  qBCProd?: number;
  vAliqProd?: number;
}

export interface CofinsOriginal {
  /** "COFINSAliq" | "COFINSQtde" | "COFINSNT" | "COFINSOutr" */
  grupo: string;
  cst: string;
  vBC?: number;
  pCOFINS?: number;
  vCOFINS?: number;
  qBCProd?: number;
  vAliqProd?: number;
}

/** `imposto` do det original normalizado (gravado em NfeDevolucaoItem.impostoOriginalJson). */
export interface ImpostoOriginal {
  icms: IcmsOriginal | null;
  ipi: IpiOriginal | null;
  pis: PisOriginal | null;
  cofins: CofinsOriginal | null;
  /** Grupo IBSCBS presente (não é emitido na devolução; gera aviso). */
  temIbsCbs: boolean;
}

// ─────────────────────────── Tributação da devolução ───────────────────────────

/** Allowlist v1 de tags ICMS na devolução (plano §6.4). */
export type TagIcmsDevolucao =
  | "ICMSSN102"
  | "ICMSSN500"
  | "ICMSSN900"
  | "ICMS00"
  | "ICMS40"
  | "ICMS60"
  | "ICMS90";

export type MotivoRevisaoTributacao =
  | "SEM_XML"
  | "QUANTIDADE_ORIGINAL_DESCONHECIDA"
  | "REGIME_DIVERGENTE"
  | "ICMS_AUSENTE"
  | "ICMS_ORIGEM_AUSENTE"
  | "ICMS_GRUPO_NAO_SUPORTADO"
  | "ICMS_ST_NAO_SUPORTADO"
  | "ICMS_BASE_REDUZIDA"
  | "ICMS_MODBC_NAO_SUPORTADO"
  | "ICMS_VALORES_AUSENTES"
  | "IPI_DESTACADO"
  | "PIS_AUSENTE"
  | "PIS_NAO_SUPORTADO"
  | "PIS_VALORES_AUSENTES"
  | "COFINS_AUSENTE"
  | "COFINS_NAO_SUPORTADO"
  | "COFINS_VALORES_AUSENTES"
  | "PIS_CST_SAIDA_EM_ENTRADA"
  | "ALTERADA_PELO_USUARIO";

export type AvisoTributacao = "PIS_CST_SAIDA_EM_ENTRADA" | "PIS_CST_ENTRADA_EM_SAIDA" | "IBS_CBS_NAO_ENVIADO";

export interface TributoPisCofinsDevolucao {
  cst: string | null;
  vBC: number;
  /** Alíquota (%). */
  p: number;
  /** Valor. */
  v: number;
}

/** Gravada em NfeDevolucaoItem.tributacaoJson. */
export interface TributacaoDevolucaoItem {
  versao: 1;
  fonte: "XML_ORIGINAL" | "SEM_XML" | "USUARIO";
  icms: {
    /** null = fora da allowlist (bloqueia até revisão). */
    tag: TagIcmsDevolucao | null;
    cst: string | null;
    csosn: string | null;
    orig: number | null;
    modBC: string | null;
    vBC: number;
    pICMS: number;
    vICMS: number;
  };
  pis: TributoPisCofinsDevolucao;
  cofins: TributoPisCofinsDevolucao;
  /** impostoDevol (IPI devolvido). Só com IPI destacado na original. */
  ipiDevol: { pDevol: number; vIPIDevol: number } | null;
  requerRevisao: boolean;
  motivosRevisao: MotivoRevisaoTributacao[];
  avisos: AvisoTributacao[];
  /** Usuário confirmou a revisão (confirmarTributacao). */
  confirmada: boolean;
}

/** Ajuste explícito do usuário (PUT …/devolucao/itens). Passa pela mesma allowlist. */
export interface TributacaoOverride {
  icms?: {
    cst?: string | null;
    csosn?: string | null;
    modBC?: string | null;
    pICMS?: number | null;
  };
  pis?: { cst?: string | null; p?: number | null };
  cofins?: { cst?: string | null; p?: number | null };
  /** false remove o grupo impostoDevol. */
  ipiDevol?: boolean;
}

// ──────────────── Regime do emitente → códigos de ICMS que a tela oferece ────────────────

/** Como o código de ICMS se chama no regime: CSOSN (3 dígitos) ou CST (2 dígitos). */
export type TipoCodigoIcms = "CSOSN" | "CST";

/**
 * Um código de ICMS emitível na devolução por este emitente. A lista sai das
 * MESMAS tabelas que o montador usa (`tributacao.ts`), nunca de um literal na tela.
 */
export interface OpcaoIcmsDevolucao {
  /**
   * "102" | "103" | "300" | "400" | "500" | "900" (CSOSN) ·
   * "00" | "40" | "41" | "50" | "60" | "90" (CST).
   *
   * É o código LITERAL que vai no XML, não o nome do grupo: 400 e 102 caem os
   * dois em `ICMSSN102`, mas `<CSOSN>400</CSOSN>` (não tributada) e
   * `<CSOSN>102</CSOSN>` (tributada sem crédito) são notas diferentes.
   */
  codigo: string;
  tipo: TipoCodigoIcms;
  /** Grupo do XML que este código monta. */
  tag: TagIcmsDevolucao;
  /** Frase em português para quem não é contadora ler num seletor. */
  rotulo: string;
  /** true ⇒ o grupo leva base e alíquota (a tela precisa pedir a alíquota). */
  exigeValores: boolean;
}

/** Por que um código digitado não serve para este emitente. */
export type CausaRecusaIcms = "VAZIO" | "FORMATO" | "REGIME" | "NAO_SUPORTADO";

export type ResultadoCodigoIcms =
  | { ok: true; codigo: string; tipo: TipoCodigoIcms; tag: TagIcmsDevolucao }
  | { ok: false; codigo: string; causa: CausaRecusaIcms; motivo: string };

/**
 * O regime do emitente DA DEVOLUÇÃO, do jeito que a tela precisa para recusar o
 * código na hora (rejeições 590/591 da SEFAZ) em vez de deixar salvar e travar
 * na emissão.
 */
export interface RegimeEmitenteDevolucao {
  /** Regime da CompanyFiscalConfig ("SIMPLES", "LUCRO_REAL"…); null = não cadastrado. */
  regimeTributario: string | null;
  /** CRT do emitente; null = regime não cadastrado/desconhecido. */
  crt: CrtEmitente | null;
  /** null = regime desconhecido: os dois valem (o servidor também aceita os dois). */
  tipoCodigoIcms: TipoCodigoIcms | null;
  /** Só os códigos que ESTE emitente pode usar. Com regime desconhecido, todos. */
  icmsOpcoes: OpcaoIcmsDevolucao[];
  /** Frase pronta para o campo ("Sua empresa é Simples Nacional…"). */
  ajuda: string;
  /**
   * Tipo da devolução que ORDENOU `pisCofinsOpcoes` (o sentido da nota: entrada
   * na devolução de venda, saída na de compra). null = não informado.
   * Opcional só por compatibilidade com quem monta o bloco à mão (servidor antigo).
   */
  tipoDevolucao?: TipoDevolucao | null;
  /**
   * CSTs de PIS/COFINS que ESTE emitente pode usar na devolução, vindos das
   * MESMAS tabelas do servidor (`PIS_COFINS_CST_SUPORTADOS` + `ROTULOS_PIS_COFINS_DEVOLUCAO`).
   * Simples (CRT 1/2/4): sem o 01 e o 02 (alíquota do regime normal) e sem os de
   * crédito (50–56, 60–67). Nota de SAÍDA (devolução de compra): sem os de
   * entrada (50–98); o 99 fica. Os do sentido da nota vêm primeiro
   * (`doSentidoDaNota`), os usuais do regime no topo (`usual`). O seletor nunca
   * recebe código que o servidor recusaria.
   */
  pisCofinsOpcoes?: OpcaoPisCofinsDevolucao[];
  /** Frase pronta para o campo de PIS/COFINS (uma vez, no topo). */
  pisCofinsAjuda?: string;
}

// ──────────────── Regime do emitente → CSTs de PIS/COFINS que a tela oferece ────────────────

/**
 * Os 31 CSTs de PIS/COFINS que os montadores emitem no grupo certo — a união
 * EXATA de `PIS_COFINS_CST_SUPORTADOS` (03 e 05 ficam de fora: por quantidade e
 * substituição tributária). O `Record` de rótulos é exaustivo sobre este tipo:
 * somar um código aqui sem rótulo quebra o `tsc`, e a suíte prende a sincronia
 * com o `Set` do servidor nos dois sentidos.
 */
export type CstPisCofinsDevolucao =
  | "01" | "02" | "04" | "06" | "07" | "08" | "09"
  | "49" | "50" | "51" | "52" | "53" | "54" | "55" | "56"
  | "60" | "61" | "62" | "63" | "64" | "65" | "66" | "67"
  | "70" | "71" | "72" | "73" | "74" | "75" | "98" | "99";

/** Tabela oficial: 01–49 saída, 50–98 entrada, 99 os dois. */
export type SentidoCstPisCofins = "SAIDA" | "ENTRADA" | "AMBOS";

export interface OpcaoPisCofinsDevolucao {
  /** CST literal ("49", "04"…) — é o que vai no XML. */
  codigo: string;
  /**
   * "49 — Outras operações de saída (…)" — o número primeiro, a explicação
   * depois (`ROTULOS_PIS_COFINS_DEVOLUCAO`, conferidos com a tabela oficial).
   */
  rotulo: string;
  sentido: SentidoCstPisCofins;
  /**
   * true ⇒ o grupo leva base e alíquota (PISAliq/PISOutr) e a tela pede a
   * alíquota; false ⇒ PISNT (04, 06–09), sem alíquota (o servidor zera).
   */
  exigeAliquota: boolean;
  /** true ⇒ do sentido desta nota (ou 99). Sem tipo informado, sempre true. */
  doSentidoDaNota: boolean;
  /** true ⇒ um dos códigos que o regime usa no dia a dia neste sentido (vão no topo). */
  usual: boolean;
}

/**
 * Por que um CST de PIS/COFINS não serve.
 *  - REGIME: numa empresa do Simples (CRT 1/2/4), 01/02 (alíquota do regime
 *    normal) ou um código de crédito (50–56, 60–67);
 *  - ALIQUOTA: alíquota fora de 0–100; 01/02 com alíquota zero; ou, no Simples,
 *    alíquota maior que 0 (o PIS/COFINS vai na guia do Simples);
 *  - SENTIDO: CST de entrada (50–98) numa nota de SAÍDA (devolução de compra).
 *    O 99 serve aos dois sentidos. (Saída numa ENTRADA continua só aviso.)
 */
export type CausaRecusaPisCofins = "VAZIO" | "FORMATO" | "NAO_SUPORTADO" | "REGIME" | "ALIQUOTA" | "SENTIDO";

/**
 * Aviso (não recusa) de sentido. Hoje só `PIS_CST_SAIDA_EM_ENTRADA` é emitido
 * pelo juiz (CST de saída numa nota de entrada: o 49 que o Simples herda das
 * próprias vendas); o de entrada numa saída virou recusa (causa SENTIDO) e fica
 * no tipo só por compatibilidade.
 */
export type AvisoSentidoPisCofins = "PIS_CST_SAIDA_EM_ENTRADA" | "PIS_CST_ENTRADA_EM_SAIDA";

export type ResultadoCstPisCofins =
  | {
      ok: true;
      /** Normalizado com o zero à esquerda ("1" → "01"). É ele que deve ser salvo. */
      codigo: string;
      sentido: SentidoCstPisCofins;
      exigeAliquota: boolean;
      /** Sentido oposto ao da nota: não impede, mas a tela mostra junto do campo. */
      aviso: AvisoSentidoPisCofins | null;
      /** Frase do aviso ("" quando não há). */
      avisoTexto: string;
    }
  | { ok: false; codigo: string; causa: CausaRecusaPisCofins; motivo: string };

// ──────────────── O imposto da nota original, para a tela conferir ────────────────

/**
 * O imposto do XML original na proporção da quantidade devolvida, pronto para a
 * tela mostrar ao lado do seletor ("Na nota do fornecedor: CST 00 · base R$ 123,56
 * · 12% · ICMS R$ 14,83"). Sai de `referenciaImpostoOriginal` (tributacao.ts).
 * `null` no detalhe = devolução manual sem XML: não há imposto original para conferir.
 */
export interface ReferenciaImpostoOriginal {
  /** FORNECEDOR na devolução de compra; PROPRIA na de venda (a nota é da própria empresa). */
  deQuem: "FORNECEDOR" | "PROPRIA";
  /** "Na nota do fornecedor" | "Na sua nota de venda". */
  titulo: string;
  /** true ⇒ valores já na proporção da quantidade devolvida; false ⇒ os da linha inteira da nota. */
  proporcional: boolean;
  quantidadeOriginal: number | null;
  quantidadeDevolvida: number;
  icms: {
    /** CST ou CSOSN, como veio. */
    codigo: string | null;
    tipo: "CST" | "CSOSN" | null;
    vBC: number;
    pICMS: number;
    vICMS: number;
    vBCST: number;
    vICMSST: number;
  } | null;
  pis: { cst: string | null; vBC: number; p: number; v: number; porQuantidade: boolean } | null;
  cofins: { cst: string | null; vBC: number; p: number; v: number; porQuantidade: boolean } | null;
  ipi: { cst: string | null; pIPI: number; vIPI: number } | null;
  /** Frases prontas, uma por tributo ("" quando o tributo não veio na nota original). */
  frases: { icms: string; pis: string; cofins: string; ipi: string };
}

/**
 * Totais da devolução como a EMISSÃO vai calcular (`calcularDevolucao` usa a
 * mesma função, `totaisDevolucao`), para a tela mostrar antes de emitir.
 */
export interface TotaisDevolucao {
  totalProdutos: number;
  totalDesconto: number;
  /** 0 com o frete desligado (mesma regra da emissão). */
  totalFrete: number;
  totalBcIcms: number;
  totalIcms: number;
  totalPis: number;
  totalCofins: number;
  /** Σ vIPIDevol (impostoDevol). Entra no valor da nota. */
  totalIpiDevol: number;
  /** vNF = produtos − desconto + frete + IPI devolvido. */
  totalNota: number;
  /** false ⇒ algum item ainda não fecha (tributação faltando ou por confirmar): é uma PRÉVIA. */
  completo: boolean;
  /** Itens (ordem) que ainda não fecham, crescente. */
  itensPendentes: number[];
}

// ─────────────────────────────── Saldo ───────────────────────────────

export interface SaldoItemOriginal {
  nItem: number;
  /** null = original externa sem XML (saldo não verificável). */
  quantidadeOriginal: number | null;
  /** AUTHORIZED — consome. */
  devolvidaAutorizada: number;
  /** VALIDATING | SIGNING | SENDING — reserva. */
  emProcessamento: number;
  /** DRAFT | REJECTED — só informa. */
  emRascunho: number;
  /** max(0, original − autorizada − emProcessamento); null quando original é null. */
  disponivel: number | null;
}

// ─────────────────────── Snapshot da origem e referências ───────────────────────

/** Item do XML autorizado da original (em NfeDevolucao.origensJson). */
export interface OrigemItemSnapshot {
  nItem: number;
  codigo: string;
  descricao: string;
  ncm: string;
  cest: string | null;
  unidade: string;
  cfop: string;
  quantidade: number;
  valorUnitario: number;
  valorProduto: number;
  desconto: number;
  origem: number | null;
  impostoOriginal: ImpostoOriginal;
}

export interface OrigemDevolucaoSnapshot {
  chaveAcesso: string;
  originalNfeId: string | null;
  modelo: string;
  /** nNF/série REAIS (da chave), nunca NfeEmitida.numero. */
  numero: number;
  serie: number;
  /** YYYY-MM-DD (data de emissão no Brasil). */
  dataEmissao: string | null;
  emitenteCnpjCpf: string;
  crtOriginal: string | null;
  idDest: IdDest;
  itens: OrigemItemSnapshot[];
}

/** Referência de um item da devolução (NfeDevolucaoItem em memória). */
export interface RefDevolucaoItem {
  /** 1..990 = NfeItem.numero da devolução = det@nItem da devolução. */
  ordem: number;
  originalNfeId: string | null;
  chaveAcessoOriginal: string;
  /** det@nItem do XML AUTORIZADO da original (nunca NfeItem.numero). */
  nItemOriginal: number;
  codigoOriginal: string;
  cfopOriginal: string | null;
  quantidadeOriginal: number | null;
  valorUnitarioOriginal: number | null;
  quantidade: number;
  valor: number;
  impostoOriginal: ImpostoOriginal | null;
  tributacao: TributacaoDevolucaoItem;
  cfopMapeamento: MapeamentoCfopDevolucao;
}

export type StatusNotaDevolucao = NfeStatus;
