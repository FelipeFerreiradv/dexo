/**
 * Validação da NF-e de DEVOLUÇÃO — roda ANTES do claim (erro de montagem queima
 * número no V1) e como prévia no GET do detalhe.
 *
 * Cada regra vira uma `DevolucaoIssue` com a rejeição SEFAZ equivalente na
 * mensagem (rastreabilidade). ERRO bloqueia a emissão; AVISO só informa.
 *
 * O contexto é montado pelo use case (rascunho + NfeItem + NfeDevolucaoItem +
 * saldo sob a MESMA regra de `saldo.ts` + originais do Dexo). Este módulo não
 * consulta nada: se um dado não veio (saldo, status da original), a regra que
 * depende dele simplesmente não é avaliada — exceto o saldo sem nenhuma fonte,
 * que exige `confirmadoSemXml`.
 *
 * Módulo PURO — seguro para backend, testes e client.
 */

import { UF_POR_CUF, parseChaveAcesso } from "../domain/chave-acesso-dv";
import {
  CFOPS_MEI_DEVOLUCAO,
  idDestDoCfop,
  isCfopPermitidoEmDevolucao,
} from "../domain/devolucao-cfop";
import { issueSaldoExcedido, quantidadeParaUnidades, temAteQuatroCasas } from "./saldo";
import {
  MENSAGEM_MOTIVO_REVISAO,
  PIS_COFINS_CREDITO,
  PIS_COFINS_CST_SUPORTADOS,
  compraTeveIcmsSt,
  familiaIcmsDaOriginal,
  familiaPisCofinsDoCrt,
  icmsDestacadoDaOriginal,
  icmsStDaOriginal,
  originalTemIcmsSt,
  reais,
  round2,
  sentidoCstPisCofins,
  tagCompativelComCrt,
} from "./tributacao";
import type {
  CrtEmitente,
  DevolucaoIssue,
  DevolucaoIssueCode,
  IdDest,
  ImpostoOriginal,
  SeveridadeIssue,
  TipoDevolucao,
  TributacaoDevolucaoItem,
} from "./tipos";

export interface RefValidacaoDevolucao {
  ordem: number;
  chaveAcesso: string;
  nItem: number;
  codigoOriginal: string;
  quantidade: number | string;
  quantidadeOriginal?: number | string | null;
  tributacao?: TributacaoDevolucaoItem | null;
  /**
   * Imposto do XML original deste item (NfeDevolucaoItem.impostoOriginalJson).
   * Ausente = as regras que dependem dele (ST a devolver, ICMS da compra) usam
   * só o que está na tributação. O caso de uso já passa o ref inteiro.
   */
  impostoOriginal?: ImpostoOriginal | null;
}

export interface ContextoValidacaoDevolucao {
  /** NfeDevolucao; null = rascunho com finalidade DEVOLUCAO sem cabeçalho (não gerenciada). */
  cabecalho: {
    tipo: TipoDevolucao;
    devolvidaAposEntrega: boolean | null;
    confirmadoSemXml?: boolean | null;
    /**
     * Snapshot das originais (NfeDevolucao.origensJson). Só o CRT de quem emitiu
     * a original é lido — para saber se a compra veio de fornecedor fora do
     * Simples. Ausente = a regra do ICMS da compra usa o tipo de código do grupo.
     */
    origensJson?: ReadonlyArray<{ chaveAcesso: string; crtOriginal?: string | null }> | null;
  } | null;
  nota: {
    modelo: string;
    finalidade: string;
    tipoOperacao: string;
    /** INTERNA | INTERESTADUAL | EXTERIOR (ou "1"/"2"/"3"). */
    destinoOperacao: string;
    ambiente?: string | null;
    destinatarioCpfCnpj?: string | null;
    /**
     * Destinatário do rascunho. Lido: IE (cliente contribuinte, na devolução de
     * venda — mesma regra do `indIEDest` do montador) e UF (devolução de compra:
     * tem de ser a UF da chave do fornecedor).
     */
    destinatarioJson?: {
      tipoPessoa?: string | null;
      inscricaoEstadual?: string | null;
      uf?: string | null;
    } | null;
    notasReferenciadasJson?: unknown;
    pagamentosJson?: unknown;
    duplicatasJson?: unknown;
  };
  emitente: { cnpj: string; crt?: CrtEmitente | string | null };
  /** NfeItem da devolução. */
  itens: Array<{ numero: number; codigo: string; quantidade: number | string; cfop: string }>;
  /** NfeDevolucaoItem da devolução. */
  refs: RefValidacaoDevolucao[];
  /**
   * Saldo por (chave, nItem) EXCLUINDO esta devolução. Ausente = não verificado aqui.
   * `devolvidaAutorizada` e `emProcessamento` (opcionais — o caso de uso já os
   * passa em runtime, é o `SaldoComChave` de saldo.ts) dizem de onde veio o que
   * falta, e o `emProcessamento` de OUTRA devolução em envio vira o aviso
   * OUTRA_DEVOLUCAO_EM_ENVIO.
   */
  saldos?: Array<{
    chaveAcesso: string;
    nItem: number;
    disponivel: number | null;
    devolvidaAutorizada?: number | null;
    emProcessamento?: number | null;
  }> | null;
  /** Originais do Dexo encontradas pelas chaves. */
  originais?: Array<{ chaveAcesso: string; status: string; ambiente?: string | null }> | null;
  /** idDest da original (a devolução espelha). */
  idDestOriginal?: IdDest | null;
}

const IDDEST_POR_DESTINO: Readonly<Record<string, IdDest>> = {
  INTERNA: 1,
  INTERESTADUAL: 2,
  EXTERIOR: 3,
  "1": 1,
  "2": 2,
  "3": 3,
};

const REJEICAO_IDDEST: Readonly<Record<IdDest, string>> = {
  1: "733",
  2: "732",
  3: "731",
};

const soDigitos = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");

/** 1.65 → "1,65%"; 7.6 → "7,6%". */
const percentualBR = (p: number) => `${String(round2(p)).replace(".", ",")}%`;

function listaNaoVazia(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && v !== undefined && typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

export function validarDevolucao(ctx: ContextoValidacaoDevolucao): DevolucaoIssue[] {
  const issues: DevolucaoIssue[] = [];
  const add = (code: DevolucaoIssueCode, severidade: SeveridadeIssue, mensagem: string, ordem?: number) =>
    issues.push(ordem === undefined ? { code, severidade, mensagem } : { code, severidade, ordem, mensagem });

  const { cabecalho, nota } = ctx;
  const tpNF: "0" | "1" = nota.tipoOperacao === "SAIDA" ? "1" : "0";
  const tipo: TipoDevolucao = cabecalho?.tipo ?? (tpNF === "1" ? "COMPRA_SAIDA" : "VENDA_ENTRADA");
  const crt = ctx.emitente.crt === null || ctx.emitente.crt === undefined ? null : String(ctx.emitente.crt);
  const cnpjEmitente = soDigitos(ctx.emitente.cnpj).padStart(14, "0");
  const emitenteSimplesPisCofins = familiaPisCofinsDoCrt(crt) === "SN";
  const emitenteSimplesIcms = crt === "1" || crt === "4";

  /**
   * PIS/COFINS da devolução — o que a caixinha "Revisei" NÃO pode liberar:
   *  - sem CST, ou fora da lista que o montador emite (03/05, base por quantidade):
   *    o montador SEFAZ trocaria em silêncio pelo padrão do regime, a Focus
   *    receberia `null`, e 03/05 cairiam em PISOutr (Rejeição 225);
   *  - numa empresa do Simples (CRT 1/2/4): 01/02 e os códigos de crédito
   *    (50–56, 60–67) — decisões do dono, igual ao ICMS de outro regime;
   *  - numa empresa do Simples, alíquota maior que 0 (decisão 2: vai na guia do
   *    Simples; a SEFAZ AUTORIZARIA a nota com o valor destacado);
   *  - 01/02 com alíquota zero (alíquota zero é o 06);
   *  - CST de entrada (50–98) numa nota de SAÍDA (decisão 3: era aviso).
   * O AVISO que fica: CST de saída numa nota de ENTRADA (decisão 4) — calculado
   * do próprio CST, para o servidor dizer o mesmo que o campo da tela, também
   * no 49 que a devolução de venda do Simples herda das próprias vendas.
   */
  const validarPisCofins = (r: RefValidacaoDevolucao, trib: TributacaoDevolucaoItem) => {
    const tributos = [
      { nome: "PIS", doNome: "do PIS", g: trib.pis, original: r.impostoOriginal?.pis ?? null },
      { nome: "COFINS", doNome: "da COFINS", g: trib.cofins, original: r.impostoOriginal?.cofins ?? null },
    ];
    const semCodigo = tributos.filter((x) => !x.g?.cst || !PIS_COFINS_CST_SUPORTADOS.has(x.g.cst));
    if (semCodigo.length > 0) {
      const quais = semCodigo.map((x) => x.doNome).join(" e ");
      const origem = semCodigo
        .map((x) =>
          x.original?.cst
            ? `${x.nome} ${x.original.cst}${x.original.qBCProd !== undefined || x.original.vAliqProd !== undefined ? " por quantidade" : ""}`
            : null,
        )
        .filter((x): x is string => !!x);
      add("PIS_COFINS_NAO_SUPORTADO", "ERRO",
        `Item ${r.ordem}: falta escolher o código (CST) ${quais} da devolução` +
          (origem.length > 0 ? ` — a nota original usa ${origem.join(" e ")}, que o Dexo não emite na devolução` : "") +
          ". O Dexo não escolhe por você.",
        r.ordem);
    }
    const validos = tributos.filter((x) => !!x.g?.cst && PIS_COFINS_CST_SUPORTADOS.has(x.g.cst));
    const doRegimeNormal = validos.filter((x) => x.g.cst === "01" || x.g.cst === "02");
    const deCredito = validos.filter((x) => PIS_COFINS_CREDITO.has(x.g.cst as string));
    // Um código só leva UMA recusa: o 01 (ou o 50) do Simples é de regime, e é
    // essa a frase; a alíquota e o sentido dele não se repetem por cima.
    const recusadosPorRegime = emitenteSimplesPisCofins ? [...doRegimeNormal, ...deCredito] : [];
    if (recusadosPorRegime.length > 0) {
      const porque = [
        doRegimeNormal.length > 0 ? "PIS/COFINS com alíquota na nota" : null,
        deCredito.length > 0 ? "crédito de PIS/COFINS" : null,
      ].filter((x): x is string => !!x).join(" e ");
      add("PIS_COFINS_REGIME_INCOMPATIVEL", "ERRO",
        `Item ${r.ordem}: o CST ${tributos.filter((x) => recusadosPorRegime.includes(x)).map((x) => `${x.g.cst} ${x.doNome}`).join(" e ")} é de empresa do regime normal (${porque}); a sua empresa é do Simples Nacional — escolha outro código.`,
        r.ordem);
    } else if (!emitenteSimplesPisCofins) {
      const aZero = doRegimeNormal.filter((x) => !(x.g.p > 0));
      if (aZero.length > 0) {
        add("PIS_COFINS_ALIQUOTA_INVALIDA", "ERRO",
          `Item ${r.ordem}: ${aZero.map((x) => `${x.nome} com CST ${x.g.cst}`).join(" e ")} a alíquota zero — alíquota zero tem código próprio, o 06.`,
          r.ordem);
      }
    }
    if (emitenteSimplesPisCofins) {
      const comAliquota = validos.filter((x) => !recusadosPorRegime.includes(x) && x.g.p > 0);
      if (comAliquota.length > 0) {
        add("PIS_COFINS_ALIQUOTA_SIMPLES", "ERRO",
          `Item ${r.ordem}: ${comAliquota.map((x) => `${x.nome} com alíquota de ${percentualBR(x.g.p)}`).join(" e ")} — no Simples o PIS/COFINS vai na guia do Simples, e a alíquota na nota fica 0. A SEFAZ autorizaria a nota com esse valor destacado, e isso só se desfaz cancelando.`,
          r.ordem);
      }
    }
    if (tpNF === "1") {
      const deEntrada = validos.filter((x) => !recusadosPorRegime.includes(x) && sentidoCstPisCofins(x.g.cst) === "ENTRADA");
      if (deEntrada.length > 0) {
        add("PIS_CST_ENTRADA_EM_SAIDA", "ERRO",
          `Item ${r.ordem}: o CST ${deEntrada.map((x) => `${x.g.cst} ${x.doNome}`).join(" e ")} é de entrada, e esta devolução de compra é uma nota de saída — escolha um código de saída (ou o 99, que serve para os dois lados).`,
          r.ordem);
      }
    }
  };

  /** CSTs de saída (01–49) de PIS/COFINS deste item, numa nota de ENTRADA — o aviso da decisão 4. */
  const saidaNaEntrada = (trib: TributacaoDevolucaoItem): string[] =>
    tpNF !== "0"
      ? []
      : [
          { g: trib.pis, doNome: "do PIS" },
          { g: trib.cofins, doNome: "da COFINS" },
        ]
          .filter((x) => !!x.g?.cst && PIS_COFINS_CST_SUPORTADOS.has(x.g.cst) && sentidoCstPisCofins(x.g.cst) === "SAIDA")
          .map((x) => `${x.g.cst} ${x.doNome}`);

  /**
   * ICMS da devolução contra o ICMS da nota ORIGINAL:
   *  - ICMS-ST cobrado na original: ERRO que a confirmação NÃO libera, com o
   *    valor que ficaria de fora (o construtor ainda não escreve ST — a nota
   *    sairia autorizada sem ele e o fornecedor não teria como estornar);
   *  - devolução de COMPRA de empresa do Simples a fornecedor fora do Simples
   *    que destacou ICMS: AVISO quando a devolução leva menos ICMS que o
   *    proporcional (Res. CGSN 140/2018, art. 59 — a contadora confirma);
   *  - CSOSN 500 num item cuja compra não teve ST: AVISO.
   */
  const validarIcmsDaOriginal = (r: RefValidacaoDevolucao, trib: TributacaoDevolucaoItem) => {
    // Origem ausente: o construtor escreve `orig ?? 0` (Nacional) sem avisar, e a SEFAZ
    // autoriza — numa peca importada o documento sai errado. So acontece na devolucao
    // pela chave com "Origem da mercadoria" em branco (pelo XML e pela nota Dexo a origem
    // vem preenchida). O Dexo nao escolhe por ela: trava e manda informar.
    if (trib.icms.orig === null || trib.icms.orig === undefined) {
      add("ICMS_ORIGEM_NAO_INFORMADA", "ERRO",
        `Item ${r.ordem}: a origem da mercadoria não foi informada.`,
        r.ordem);
    }
    const icmsOriginal = r.impostoOriginal?.icms ?? null;
    const temSt = originalTemIcmsSt(icmsOriginal) || trib.motivosRevisao.includes("ICMS_ST_NAO_SUPORTADO");
    if (temSt) {
      const st = icmsStDaOriginal({ impostoOriginal: r.impostoOriginal, quantidadeOriginal: r.quantidadeOriginal, quantidade: r.quantidade });
      const valor = st
        ? ` — ${reais(st.vICMSST)}${st.proporcional ? " na quantidade devolvida" : " na linha inteira da nota"}`
        : "";
      add("ICMS_ST_NAO_DEVOLVIDO", "ERRO",
        `Item ${r.ordem}: a nota original cobrou ICMS-ST desta peça${valor}, e o Dexo ainda não devolve ICMS-ST: esse valor ficaria fora da nota. Combine com a contadora como devolver este item.`,
        r.ordem);
    }
    if (tipo !== "COMPRA_SAIDA" || !emitenteSimplesIcms || !icmsOriginal) return;
    const crtOriginal =
      cabecalho?.origensJson?.find((o) => soDigitos(o.chaveAcesso) === soDigitos(r.chaveAcesso))?.crtOriginal ?? null;
    if (familiaIcmsDaOriginal(crtOriginal, icmsOriginal) === "NORMAL" && trib.icms.tag) {
      const compra = icmsDestacadoDaOriginal({ impostoOriginal: r.impostoOriginal, quantidadeOriginal: r.quantidadeOriginal, quantidade: r.quantidade });
      const devolucao = round2(trib.icms.vICMS ?? 0);
      // 1 centavo de folga: a base proporcional e o ICMS proporcional arredondam
      // cada um por si, e um centavo de diferença não é ICMS "de fora".
      if (compra && round2(compra.vICMS - devolucao) > 0.01) {
        add("ICMS_COMPRA_A_MENOR", "AVISO",
          `Item ${r.ordem}: a nota de compra destacou ${reais(compra.vICMS)} de ICMS nesta quantidade (base ${reais(compra.vBC)}), e a devolução vai com ${reais(devolucao)} — ficam de fora ${reais(round2(compra.vICMS - devolucao))}, que o fornecedor deixa de estornar. Pela Res. CGSN 140/2018, art. 59, a empresa do Simples que devolve compra informa a base e o ICMS da nota de compra nos campos próprios (no Simples, só o CSOSN 900 tem esses campos); a contadora confirma.`,
          r.ordem);
      }
    }
    if ((trib.icms.csosn === "500" || trib.icms.tag === "ICMSSN500") && !compraTeveIcmsSt(icmsOriginal)) {
      const codigoCompra = icmsOriginal.csosn ?? icmsOriginal.cst;
      add("ICMS_500_SEM_ST", "AVISO",
        `Item ${r.ordem}: o CSOSN 500 declara que o ICMS já foi cobrado antes por substituição tributária, mas a compra deste item não teve ST${codigoCompra ? ` (código ${codigoCompra} na nota do fornecedor)` : ""} — confirme o código com a contadora.`,
        r.ordem);
    }
  };

  // ── cabeçalho ──
  if (!cabecalho) {
    add("NAO_GERENCIADA", "ERRO",
      "Nota de devolução sem o vínculo com a nota original (Rejeição 321). Crie a devolução pela nota original ou pela devolução manual.");
  } else if (cabecalho.devolvidaAposEntrega === null || cabecalho.devolvidaAposEntrega === undefined) {
    // Na devolução de COMPRA quem recebeu foi ela, e quem recebe de volta é o
    // FORNECEDOR — "devolvida pelo cliente" mandava responder outra pergunta.
    add("ESCOLHA_PENDENTE", "ERRO",
      tipo === "COMPRA_SAIDA"
        ? "Responda se a mercadoria chegou até você e está sendo devolvida ao fornecedor."
        : "Responda se a mercadoria foi entregue e devolvida pelo cliente.");
  } else if (cabecalho.devolvidaAposEntrega !== true) {
    // Na COMPRA não se aponta caminho (nota de crédito ou outro): recusa de
    // mercadoria comprada se registra como a contadora disser.
    add("RECUSA_NAO_E_DEVOLUCAO", "ERRO",
      tipo === "COMPRA_SAIDA"
        ? "Mercadoria recusada na entrega, que não chegou a entrar, não é devolução de compra — esta nota não pode ser emitida para esse caso. Combine com a sua contadora como registrar a recusa."
        : "Recusa ou não entrega não é devolução (finNFe 5, nota de crédito) — esta nota não pode ser emitida para esse caso.");
  }

  if (nota.finalidade !== "DEVOLUCAO") {
    add("FINALIDADE_NAO_DEVOLUCAO", "ERRO",
      "A finalidade da nota precisa ser Devolução (finNFe 4) para usar CFOP de devolução (Rejeição 328).");
  }
  if (nota.modelo !== "55") {
    add("MODELO_NAO_PERMITIDO", "ERRO",
      "Nota de devolução só pode ser NF-e modelo 55 — NFC-e não admite devolução (Rejeição 706/715).");
  }
  const tpEsperado = tipo === "COMPRA_SAIDA" ? "SAIDA" : "ENTRADA";
  if (nota.tipoOperacao !== tpEsperado) {
    add("TIPO_OPERACAO_INCOERENTE", "ERRO",
      tipo === "COMPRA_SAIDA"
        ? "Devolução de compra é nota de SAÍDA (tpNF=1)."
        : "Devolução de venda é nota de ENTRADA (tpNF=0).");
  }
  if (listaNaoVazia(nota.notasReferenciadasJson)) {
    add("NFREF_PROIBIDA", "ERRO",
      "Notas referenciadas do formulário não podem ir junto com a referência da devolução (Rejeição 1010). Remova-as — a referência é gerada pelo Dexo.");
  }
  if (
    Array.isArray(nota.pagamentosJson) &&
    nota.pagamentosJson.some((p) => (p as { meio?: unknown } | null)?.meio !== "SEM_PAGAMENTO")
  ) {
    add("PAGAMENTO_SERA_90", "AVISO",
      "Nota de devolução não tem forma de pagamento: será enviado \"Sem pagamento\" (tPag 90, Rejeição 871).");
  }
  if (listaNaoVazia(nota.duplicatasJson)) {
    add("COBRANCA_NAO_ENVIADA", "AVISO",
      "Nota de devolução não tem duplicatas: a cobrança informada não será enviada.");
  }

  const idDestNota = IDDEST_POR_DESTINO[String(nota.destinoOperacao ?? "")] ?? null;
  if (ctx.idDestOriginal && idDestNota && ctx.idDestOriginal !== idDestNota) {
    add("IDDEST_DIVERGENTE_ORIGINAL", "ERRO",
      "O destino da operação (idDest) precisa ser o mesmo da nota original.");
  }

  // Regime NÃO cadastrado (crt explicitamente null — ausente = não avaliado): a
  // tela oferece CSOSN e CST, a validação do ICMS aceita os dois e o montador
  // SEFAZ carimba CRT 3 (`crtFromRegime`). Com um CSOSN escolhido seria a
  // Rejeição 590. Travar aqui, antes de reservar o número.
  if (ctx.emitente.crt === null) {
    add("REGIME_NAO_CADASTRADO", "ERRO",
      "O regime tributário da empresa não está cadastrado — sem ele o Dexo não sabe se o ICMS vai por CSOSN (Simples) ou CST, e a SEFAZ recusaria (Rejeição 590/591). Cadastre o regime na configuração fiscal.");
  }

  // Devolução de venda a cliente contribuinte (mesma regra do indIEDest do
  // montador: IE preenchida e diferente de ISENTO, fora do exterior). Quem
  // normalmente emite a devolução é ELE; a nota de entrada da loja é para quem
  // não emite (Convênio SINIEF s/nº 1970, art. 54 — a contadora confirma).
  // Só AVISO: o Dexo não sabe se o cliente já emitiu.
  if (tipo === "VENDA_ENTRADA" && destinatarioContribuinte(nota.destinatarioJson)) {
    add("DESTINATARIO_CONTRIBUINTE", "AVISO",
      "O cliente tem inscrição estadual (é contribuinte do ICMS): normalmente é ele quem emite a nota de devolução. Emita esta nota de entrada só se ele não for emitir a dele — se ele já emitiu, não emita esta.");
  }

  // ── itens × referências ──
  const itens = [...ctx.itens].sort((a, b) => a.numero - b.numero);
  const refs = [...ctx.refs].sort((a, b) => a.ordem - b.ordem);
  if (itens.length === 0) {
    add("SEM_ITENS", "ERRO", "Escolha pelo menos um item para devolver.");
  }
  if (itens.length === 0 || refs.length === 0) {
    add("REFERENCIA_AUSENTE", "ERRO",
      "NF-e de devolução sem documento fiscal referenciado (Rejeição 321).");
  }

  const refPorOrdem = new Map<number, RefValidacaoDevolucao>();
  for (const r of refs) if (!refPorOrdem.has(r.ordem)) refPorOrdem.set(r.ordem, r);

  const desalinhado =
    itens.length !== refs.length ||
    itens.some((it, i) => {
      const r = refs[i];
      if (!r || it.numero !== i + 1 || r.ordem !== i + 1) return true;
      if (String(it.codigo ?? "") !== String(r.codigoOriginal ?? "")) return true;
      const qi = quantidadeParaUnidades(it.quantidade);
      const qr = quantidadeParaUnidades(r.quantidade);
      return qi === null || qr === null || qi !== qr;
    });
  if (desalinhado && itens.length > 0 && refs.length > 0) {
    add("ITENS_DESALINHADOS", "ERRO",
      "Os itens da nota não correspondem às referências da devolução. Salve os itens pelo editor da devolução (Rejeição 321).");
  }

  // Itens sem referência na posição.
  for (const it of itens) {
    if (refs.length > 0 && !refPorOrdem.has(it.numero)) {
      add("REFERENCIA_AUSENTE", "ERRO",
        `Item ${it.numero} sem referência ao item da nota original (Rejeição 321).`, it.numero);
    }
  }

  // ── CFOP por item (o que o montador emite: NfeItem.cfop) ──
  for (const it of itens) {
    const cfop = soDigitos(it.cfop);
    if (!cfop) {
      add("CFOP_ESCOLHA_PENDENTE", "ERRO",
        `Item ${it.numero}: escolha o CFOP de devolução (Rejeição 327).`, it.numero);
      continue;
    }
    if (!isCfopPermitidoEmDevolucao(cfop, tpNF)) {
      add("CFOP_NAO_DEVOLUCAO", "ERRO",
        `Item ${it.numero}: o CFOP ${cfop} não é de devolução para esta operação (Rejeição 327).`, it.numero);
      continue;
    }
    const entrada = "123".includes(cfop[0]);
    if ((tpNF === "0") !== entrada) {
      add("CFOP_SENTIDO_INVALIDO", "ERRO",
        tpNF === "0"
          ? `Item ${it.numero}: CFOP de saída numa nota de entrada (Rejeição 519).`
          : `Item ${it.numero}: CFOP de entrada numa nota de saída (Rejeição 518).`,
        it.numero);
    }
    const idDestCfop = idDestDoCfop(cfop);
    if (idDestNota && idDestCfop && idDestCfop !== idDestNota) {
      add("CFOP_IDDEST_DIVERGENTE", "ERRO",
        `Item ${it.numero}: o CFOP ${cfop} não combina com o destino da operação (Rejeição ${REJEICAO_IDDEST[idDestCfop]}).`,
        it.numero);
    }
    if (crt === "4" && !CFOPS_MEI_DEVOLUCAO.has(cfop)) {
      add("CFOP_MEI_NAO_PERMITIDO", "ERRO",
        `Item ${it.numero}: MEI só pode usar os CFOPs de devolução 1202, 1553, 2202, 2553, 5202 e 6202 (Rejeição 1179).`,
        it.numero);
    }
  }

  // ── referências ──
  const saldoPorPar = new Map<string, number | null>();
  const saldoCompletoPorPar = new Map<string, NonNullable<ContextoValidacaoDevolucao["saldos"]>[number]>();
  for (const s of ctx.saldos ?? []) {
    saldoPorPar.set(`${soDigitos(s.chaveAcesso)}#${s.nItem}`, s.disponivel);
    saldoCompletoPorPar.set(`${soDigitos(s.chaveAcesso)}#${s.nItem}`, s);
  }
  const numeroOuZero = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const confirmadoSemXml = cabecalho?.confirmadoSemXml === true;
  const pares = new Set<string>();
  const emitentesReferenciados = new Set<string>();

  for (const r of refs) {
    const partes = parseChaveAcesso(r.chaveAcesso);
    const chave = partes?.chave ?? soDigitos(r.chaveAcesso);
    if (!partes || !partes.dvValido) {
      add("CHAVE_INVALIDA", "ERRO",
        `Item ${r.ordem}: chave de acesso da nota original inválida (44 dígitos com dígito verificador).`, r.ordem);
    } else {
      emitentesReferenciados.add(partes.cnpjCpf);
      if (partes.modelo !== "55" && partes.modelo !== "65") {
        add("MODELO_ORIGINAL_NAO_SUPORTADO", "ERRO",
          `Item ${r.ordem}: só NF-e (55) e NFC-e (65) podem ser referenciadas (modelo ${partes.modelo}).`, r.ordem);
      }
    }

    if (!Number.isInteger(r.nItem) || r.nItem < 1 || r.nItem > 990) {
      add("NITEM_INVALIDO", "ERRO",
        `Item ${r.ordem}: número do item da nota original fora de 1 a 990 (Rejeição 1048).`, r.ordem);
    }

    const par = `${chave}#${r.nItem}`;
    if (pares.has(par)) {
      add("REFERENCIA_DUPLICADA", "ERRO",
        `Item ${r.ordem}: o item ${r.nItem} da mesma nota original foi referenciado mais de uma vez (Rejeição 1072).`, r.ordem);
    }
    pares.add(par);

    const qU = quantidadeParaUnidades(r.quantidade);
    if (qU === null || qU <= 0 || !temAteQuatroCasas(r.quantidade)) {
      add("QUANTIDADE_INVALIDA", "ERRO",
        `Item ${r.ordem}: a quantidade devolvida precisa ser maior que zero, com no máximo 4 casas decimais.`, r.ordem);
    } else {
      const temSaldo = saldoPorPar.has(par);
      const disponivel = temSaldo ? saldoPorPar.get(par) ?? null : null;
      const qOrigU =
        r.quantidadeOriginal === null || r.quantidadeOriginal === undefined
          ? null
          : quantidadeParaUnidades(r.quantidadeOriginal);
      const disponivelU = disponivel === null ? null : quantidadeParaUnidades(disponivel);
      const saldoDoPar = saldoCompletoPorPar.get(par);
      // A frase é a MESMA do 409 do salvamento (`issueSaldoExcedido`): com a
      // peça, o que ela pediu, o que sobrou e onde está o resto — e, com nada
      // sobrando, "tire o item", não "baixe até o disponível" (que é 0).
      if (disponivelU !== null && qU > disponivelU) {
        issues.push(issueSaldoExcedido({
          ordem: r.ordem,
          nItemOriginal: r.nItem,
          codigo: r.codigoOriginal,
          pedida: Number(r.quantidade),
          saldo: {
            disponivel,
            devolvidaAutorizada: numeroOuZero(saldoDoPar?.devolvidaAutorizada),
            emProcessamento: numeroOuZero(saldoDoPar?.emProcessamento),
          },
        }));
      } else if (disponivelU === null && qOrigU !== null && qU > qOrigU) {
        issues.push(issueSaldoExcedido({
          ordem: r.ordem,
          nItemOriginal: r.nItem,
          codigo: r.codigoOriginal,
          pedida: Number(r.quantidade),
          saldo: null,
          quantidadeOriginal: Number(r.quantidadeOriginal),
        }));
      } else if (disponivelU === null && qOrigU === null && !confirmadoSemXml) {
        add("SALDO_NAO_VERIFICAVEL", "ERRO",
          `Item ${r.ordem}: sem o XML da nota original o saldo não pode ser conferido — confirme a devolução sem XML.`, r.ordem);
      }
      // K13: OUTRA devolução deste mesmo item está em envio à SEFAZ. A quantidade
      // dela já saiu do disponível (saldo.ts); o aviso diz de onde veio a falta
      // e que ela volta se aquela for recusada.
      const emEnvio = numeroOuZero(saldoDoPar?.emProcessamento);
      if (emEnvio > 0) {
        add("OUTRA_DEVOLUCAO_EM_ENVIO", "AVISO",
          `Item ${r.ordem}: outra devolução deste mesmo item está em envio à SEFAZ (${String(emEnvio).replace(".", ",")} em envio) — essa quantidade já saiu do que ainda pode ser devolvido; se aquela nota for recusada, ela volta.`,
          r.ordem);
      }
    }

    const trib = r.tributacao;
    if (!trib) {
      add("TRIBUTACAO_AUSENTE", "ERRO", `Item ${r.ordem}: tributação da devolução não definida.`, r.ordem);
    } else {
      if (trib.requerRevisao && !trib.confirmada) {
        const motivos = trib.motivosRevisao.map((m) => MENSAGEM_MOTIVO_REVISAO[m] ?? m).join(" ");
        add("TRIBUTACAO_REVISAO_PENDENTE", "ERRO",
          `Item ${r.ordem}: revise e confirme a tributação. ${motivos}`.trim(), r.ordem);
      }
      if (!trib.icms.tag) {
        add("TRIBUTACAO_NAO_SUPORTADA", "ERRO",
          `Item ${r.ordem}: grupo de ICMS não suportado na devolução — ajuste o CST/CSOSN.`, r.ordem);
      } else if (!tagCompativelComCrt(trib.icms.tag, crt)) {
        add("TRIBUTACAO_REGIME_INCOMPATIVEL", "ERRO",
          `Item ${r.ordem}: ${trib.icms.tag.startsWith("ICMSSN") ? "CSOSN para emitente fora do Simples (Rejeição 590)" : "CST para emitente do Simples (Rejeição 591)"} — ajuste a tributação.`,
          r.ordem);
      }
      if (trib.ipiDevol) {
        const { pDevol, vIPIDevol } = trib.ipiDevol;
        if (!(pDevol > 0 && pDevol <= 100) || !(vIPIDevol >= 0)) {
          // O percentual não é digitado: sai da quantidade devolvida sobre a da nota
          // original. A frase manda conferir o que ela de fato controla.
          add("IPI_DEVOL_INVALIDO", "ERRO",
            `Item ${r.ordem}: o percentual de IPI devolvido sai da quantidade devolvida sobre a da nota original e ficou fora de 0 a 100 (grupo impostoDevol) — confira a quantidade no passo 3 ("Produtos").`, r.ordem);
        }
      }
      // Decisão 4: o aviso sai do PRÓPRIO CST, não só da marca gravada — a
      // derivação não marca o 49 que a devolução de venda do Simples herda das
      // próprias vendas, e o campo da tela avisa nele. Agora os dois dizem o mesmo
      // (também nos rascunhos gravados antes). Continua só AVISO.
      const saidas = saidaNaEntrada(trib);
      if (tpNF === "0" && (saidas.length > 0 || trib.avisos.includes("PIS_CST_SAIDA_EM_ENTRADA"))) {
        add("PIS_CST_SAIDA_EM_ENTRADA", "AVISO",
          saidas.length > 0
            ? `Item ${r.ordem}: o CST ${saidas.join(" e ")} é de saída, numa nota de entrada — não impede a emissão; confirme com o contador.`
            : `Item ${r.ordem}: CST de PIS/COFINS de saída numa nota de entrada — confirme com o contador.`,
          r.ordem);
      }
      if (trib.avisos.includes("IBS_CBS_NAO_ENVIADO")) {
        add("IBS_CBS_NAO_ENVIADO", "AVISO",
          `Item ${r.ordem}: IBS/CBS da nota original não é enviado na devolução.`, r.ordem);
      }
      validarPisCofins(r, trib);
      validarIcmsDaOriginal(r, trib);
    }
  }

  // ── emitente(s) das chaves ──
  if (emitentesReferenciados.size > 1) {
    add("EMITENTES_DIVERSOS", "ERRO",
      "Todas as notas referenciadas precisam ser do mesmo emitente (Rejeição 1193).");
  }
  const [emitenteReferenciado] = Array.from(emitentesReferenciados);
  if (emitentesReferenciados.size === 1 && emitenteReferenciado) {
    if (tpNF === "1") {
      const dest = soDigitos(nota.destinatarioCpfCnpj ?? "").padStart(14, "0");
      if (dest !== emitenteReferenciado) {
        add("DESTINATARIO_NAO_E_EMITENTE_ORIGINAL", "ERRO",
          "Na devolução de compra o destinatário precisa ser o emitente da nota original (Rejeição 1194).");
      }
      // O destinatário da devolução de compra é o estabelecimento que emitiu a
      // chave: a UF dele É o cUF da chave. UF digitada diferente leva o destino
      // da operação errado para a SEFAZ (Rejeição 772/773).
      const ufChave = ufDaChaveReferenciada(refs, emitenteReferenciado);
      const ufDest = (nota.destinatarioJson?.uf ?? "").trim().toUpperCase();
      if (ufChave && ufDest && ufDest !== ufChave) {
        add("DESTINATARIO_UF_DIVERGENTE_CHAVE", "ERRO",
          `Na devolução de compra o destinatário é o fornecedor da nota original, que é de ${ufChave} (está na chave de acesso); o destinatário está com UF ${ufDest}. Com a UF errada a SEFAZ recusa o destino da operação (Rejeição 772/773).`);
      }
    } else if (emitenteReferenciado !== cnpjEmitente) {
      add("EMITENTE_ORIGINAL_DIVERGENTE", "ERRO",
        "Na devolução de venda a nota original precisa ter sido emitida por este mesmo CNPJ (regra do Dexo, mais estrita que a 1193).");
    }
  }

  // ── originais do Dexo ──
  const vistas = new Set<string>();
  for (const o of ctx.originais ?? []) {
    const chave = parseChaveAcesso(o.chaveAcesso)?.chave ?? soDigitos(o.chaveAcesso);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    if (o.status === "CANCELLED") {
      add("ORIGINAL_CANCELADA", "ERRO", `A nota original ${chave} está cancelada — não há o que devolver.`);
    } else if (o.status !== "AUTHORIZED") {
      add("ORIGINAL_NAO_AUTORIZADA", "ERRO", `A nota original ${chave} não está autorizada.`);
    }
    if (o.ambiente && nota.ambiente && o.ambiente !== nota.ambiente) {
      add("AMBIENTE_DIVERGENTE", "ERRO",
        "A nota original e a devolução estão em ambientes diferentes (homologação × produção).");
    }
  }

  return issues;
}

/** Mesma regra do `indIEDest` do montador SEFAZ: IE preenchida, diferente de ISENTO, fora do exterior. */
function destinatarioContribuinte(
  dest: { tipoPessoa?: string | null; inscricaoEstadual?: string | null } | null | undefined,
): boolean {
  if (!dest || dest.tipoPessoa === "EXTERIOR") return false;
  const ie = (dest.inscricaoEstadual ?? "").trim();
  return ie !== "" && ie.toUpperCase() !== "ISENTO";
}

/** UF (sigla) do cUF da primeira chave válida do emitente referenciado. */
function ufDaChaveReferenciada(refs: readonly RefValidacaoDevolucao[], emitente: string): string | null {
  for (const r of refs) {
    const partes = parseChaveAcesso(r.chaveAcesso);
    if (partes?.dvValido && partes.cnpjCpf === emitente) return UF_POR_CUF[partes.cUF] ?? null;
  }
  return null;
}

export function issuesBloqueantes(issues: readonly DevolucaoIssue[]): DevolucaoIssue[] {
  return issues.filter((i) => i.severidade === "ERRO");
}

export function temBloqueio(issues: readonly DevolucaoIssue[]): boolean {
  return issues.some((i) => i.severidade === "ERRO");
}
