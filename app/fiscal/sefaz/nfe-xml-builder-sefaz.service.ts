/**
 * Construtor de XML NFe modelo 55 v4.00 para envio direto à SEFAZ.
 *
 * Diferente de `app/fiscal/generators/nfe-xml-builder.service.ts` (que produz
 * JSON Focus), este serviço produz o XML real conforme schema PL_009_V4.
 *
 * Saída: a string `<NFe xmlns="..."><infNFe Id="NFe<chave>" versao="4.00">
 * ...</infNFe></NFe>` SEM o `Signature` (assinatura entra depois via
 * XmlSignerService) e SEM envelope SOAP (vai depois via envelopes.ts).
 *
 * O builder é PURO: não faz I/O, não chama serviços externos. Recebe os
 * dados via parâmetro, retorna string. Determinístico se `dhEmi` e `cNF`
 * forem fixados explicitamente.
 */

import { create } from "xmlbuilder2";
import { createHash } from "crypto";

import type { NfeDraftResponse, NfeDraftItem } from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type {
  RegimeTributario,
  ModalidadeFrete,
  IndicadorPresenca,
  FinalidadeNfe,
  DestinoOperacao,
  TipoOperacao,
  MeioPagamento,
  NfeItemTributos,
} from "../domain/nfe.types";
import {
  MODALIDADE_FRETE_COD,
  IND_PRESENCA_COD,
  FINALIDADE_NFE_COD,
  DESTINO_OPERACAO_COD,
  MEIO_PAGAMENTO_COD,
} from "../domain/nfe.types";
import { composeInfCpl } from "../domain/inf-cpl";
import {
  exigeGrupoCard,
  TP_INTEGRA_NAO_INTEGRADO,
  type ModeloDocumento,
} from "../domain/pagamento-card";
import { COD_UF, type UF } from "./endpoints";
import { montarChave, chaveToString, type ChaveAcessoParts } from "./chave-acesso";

const NFE_NS = "http://www.portalfiscal.inf.br/nfe";

export interface NfeXmlSefazBuildResult {
  /** XML completo `<NFe><infNFe>...</infNFe></NFe>` sem Signature. */
  xml: string;
  /** Chave de acesso de 44 dígitos gerada. */
  chaveAcesso: string;
  /** Partes da chave (cUF, cNF, cDV etc.) — útil para auditoria. */
  chaveParts: ChaveAcessoParts;
  /** `Id` atribuído ao infNFe (NFe<chave>). */
  infNFeId: string;
}

/**
 * Responsável Técnico (NT 2018.005) — software house. É o MESMO para todos os
 * tenants (não vem de CompanyFiscalConfig, que é por empresa), então é
 * resolvido do ambiente pelo caller (provider) e injetado aqui, mantendo o
 * builder puro. `idCSRT`/`csrt` são condicionais (só quando a UF exige CSRT).
 */
export interface NfeRespTec {
  cnpj: string;
  xContato: string;
  email: string;
  fone: string;
  idCSRT?: string;
  csrt?: string;
}

export interface NfeXmlSefazBuildOptions {
  draft: NfeDraftResponse;
  config: CompanyFiscalConfig;
  numero: number;
  /** Override do dhEmi (default: agora). Útil para testes. */
  dhEmi?: Date;
  /** Override do cNF (default: gerado aleatoriamente). Útil para testes. */
  cNF?: string;
  /** Tipo de emissão (1=normal, 6=SVC-AN, 7=SVC-RS). Default: 1. */
  tpEmis?: 1 | 6 | 7;
  /**
   * Responsável Técnico. Quando ausente (undefined), o grupo <infRespTec> NÃO é
   * emitido e o XML fica byte-a-byte igual ao anterior (kill-switch off). O
   * caller (SefazDirectProvider) resolve do env via resolveRespTecFromEnv().
   */
  respTec?: NfeRespTec;
}

export class NfeXmlBuilderSefazService {
  build(opts: NfeXmlSefazBuildOptions): NfeXmlSefazBuildResult {
    const { draft, config, numero, dhEmi = new Date(), tpEmis = 1 } = opts;

    if (!config.uf) {
      throw new Error("CompanyFiscalConfig.uf obrigatorio para SEFAZ direto");
    }
    if (!config.codMunicipio) {
      throw new Error(
        "CompanyFiscalConfig.codMunicipio obrigatorio para SEFAZ direto",
      );
    }
    // NFC-e (Fase 2): modelo vem do draft; ausente/qualquer-outro ⇒ "55"
    // (comportamento atual byte-idêntico). TODA diferença de 65 abaixo é
    // guardada por `modelo === "65"`.
    const modelo: "55" | "65" = draft.modelo === "65" ? "65" : "55";

    // No modelo 65 o destinatário é OPCIONAL (consumidor não identificado).
    if (modelo !== "65" && !draft.destinatarioJson) {
      throw new Error("destinatarioJson ausente — destinatario e obrigatorio");
    }
    if (!draft.itens || draft.itens.length === 0) {
      throw new Error("Nota sem itens");
    }

    const uf = config.uf as UF;
    const cnpj = onlyDigits(config.cnpj);
    // A AAMM da chave de acesso DEVE bater com o ano/mes de dhEmi. Ambos sao
    // derivados do MESMO horario de Brasilia (UTC-03:00), independentemente do
    // fuso do servidor — senao um servidor em UTC viraria o mes na virada do dia
    // e geraria divergencia AAMM x dhEmi (rejeicao). Ver brazilParts/formatDhEmi.
    const bp = brazilParts(dhEmi);
    const partes = montarChave({
      uf,
      ano: bp.year,
      mes: bp.month,
      cnpj,
      modelo,
      serie: draft.serie,
      numero,
      tpEmis,
      cNF: opts.cNF,
    });
    const chaveAcesso = chaveToString(partes);
    const infNFeId = `NFe${chaveAcesso}`;

    const doc = create({ version: "1.0", encoding: "UTF-8" });
    const nfe = doc.ele("NFe", { xmlns: NFE_NS });
    const infNFe = nfe.ele("infNFe", { Id: infNFeId, versao: "4.00" });

    this.buildIde(infNFe, draft, partes, dhEmi, tpEmis, config, modelo);
    this.buildEmit(infNFe, config);
    this.buildDest(infNFe, draft, modelo);
    draft.itens.forEach((item, idx) =>
      this.buildDet(
        infNFe,
        item,
        idx + 1,
        config.regimeTributario as RegimeTributario,
        modelo,
        draft.ambiente,
      ),
    );
    this.buildTotal(infNFe, draft);
    this.buildTransp(infNFe, draft, modelo);
    // <cobr> (duplicatas) nao existe no modelo 65.
    if (modelo !== "65") this.buildCobr(infNFe, draft);
    this.buildPag(infNFe, draft);
    this.buildInfAdic(infNFe, draft);
    // <infRespTec> e o ULTIMO grupo dentro de infNFe (leiaute 4.00). Fica dentro
    // do conteudo assinado (a assinatura e feita depois, sobre o infNFe completo).
    this.buildInfRespTec(infNFe, opts.respTec, chaveAcesso);

    const xml = doc.end({ headless: true, format: "xml" });
    return { xml, chaveAcesso, chaveParts: partes, infNFeId };
  }

  // ── <ide> ──

  private buildIde(
    parent: any,
    draft: NfeDraftResponse,
    partes: ChaveAcessoParts,
    dhEmi: Date,
    tpEmis: number,
    config: CompanyFiscalConfig,
    modelo: "55" | "65" = "55",
  ): void {
    const isNfce = modelo === "65";
    const tpAmb = draft.ambiente === "PRODUCAO" ? "1" : "2";
    const tpNF = draft.tipoOperacao === ("SAIDA" as TipoOperacao) ? "1" : "0";
    // NFC-e: operacao SEMPRE interna (idDest=1).
    const idDest = isNfce
      ? "1"
      : (DESTINO_OPERACAO_COD[draft.destinoOperacao as DestinoOperacao] ?? "1");
    const indFinal = "1"; // consumidor final — pode evoluir conforme draft
    // NFC-e: indPres nao pode ser 0 — fallback presencial (1).
    const indPresMapped =
      IND_PRESENCA_COD[draft.indPresenca as IndicadorPresenca] ?? "0";
    const indPres = isNfce && indPresMapped === "0" ? "1" : indPresMapped;
    const finNFe = FINALIDADE_NFE_COD[draft.finalidade as FinalidadeNfe] ?? "1";

    const ide = parent.ele("ide");
    ide.ele("cUF").txt(partes.cUF).up();
    ide.ele("cNF").txt(partes.cNF).up();
    // natOp e obrigatorio (1..60 chars). Trunca e usa fallback se vazio.
    ide.ele("natOp").txt(truncate(draft.naturezaOperacao || "VENDA", 60)).up();
    ide.ele("mod").txt(partes.mod).up();
    ide.ele("serie").txt(String(draft.serie)).up();
    ide.ele("nNF").txt(String(Number(partes.nNF))).up();
    ide.ele("dhEmi").txt(formatDhEmi(dhEmi)).up();

    // dhSaiEnt NAO e permitido no modelo 65.
    if (!isNfce && draft.dataSaida && tpNF === "1") {
      ide.ele("dhSaiEnt").txt(formatDhEmi(new Date(draft.dataSaida))).up();
    }

    ide.ele("tpNF").txt(tpNF).up();
    ide.ele("idDest").txt(idDest).up();
    ide.ele("cMunFG").txt(config.codMunicipio ?? "").up();
    // tpImp: 1 = DANFE retrato (55); 4 = DANFE NFC-e (cupom).
    ide.ele("tpImp").txt(isNfce ? "4" : "1").up();
    ide.ele("tpEmis").txt(String(tpEmis)).up();
    ide.ele("cDV").txt(partes.cDV).up();
    ide.ele("tpAmb").txt(tpAmb).up();
    ide.ele("finNFe").txt(finNFe).up();
    ide.ele("indFinal").txt(indFinal).up();
    ide.ele("indPres").txt(indPres).up();
    ide.ele("procEmi").txt("0").up(); // 0 = emissão de aplicativo do contribuinte
    ide.ele("verProc").txt("Dexo-1.0").up();
  }

  // ── <emit> ──

  private buildEmit(parent: any, config: CompanyFiscalConfig): void {
    const emit = parent.ele("emit");
    emit.ele("CNPJ").txt(onlyDigits(config.cnpj)).up();
    emit.ele("xNome").txt(truncate(config.razaoSocial, 60)).up();
    if (config.nomeFantasia) {
      emit.ele("xFant").txt(truncate(config.nomeFantasia, 60)).up();
    }

    const ender = emit.ele("enderEmit");
    ender.ele("xLgr").txt(truncate(config.logradouro ?? "SEM ENDERECO", 60)).up();
    ender.ele("nro").txt(config.numero ?? "S/N").up();
    if (config.complemento) {
      ender.ele("xCpl").txt(truncate(config.complemento, 60)).up();
    }
    ender.ele("xBairro").txt(truncate(config.bairro ?? "CENTRO", 60)).up();
    ender.ele("cMun").txt(config.codMunicipio ?? "").up();
    ender.ele("xMun").txt(truncate(config.municipio ?? "", 60)).up();
    ender.ele("UF").txt(config.uf ?? "").up();
    ender.ele("CEP").txt(onlyDigits(config.cep ?? "")).up();
    ender.ele("cPais").txt(config.codPais ?? "1058").up();
    ender.ele("xPais").txt(config.pais ?? "BRASIL").up();

    emit.ele("IE").txt(onlyDigits(config.inscricaoEstadual)).up();

    // SEFAZ XSD: IM aparece SE houver IM. CNAE aparece SE houver IM. CRT é obrigatório.
    if (config.inscricaoMunicipal) {
      emit.ele("IM").txt(config.inscricaoMunicipal).up();
      if (config.cnae) {
        emit.ele("CNAE").txt(config.cnae).up();
      }
    }

    const crt = crtFromRegime(config.regimeTributario as RegimeTributario);
    emit.ele("CRT").txt(crt).up();
  }

  // ── <dest> ──

  private buildDest(
    parent: any,
    draft: NfeDraftResponse,
    modelo: "55" | "65" = "55",
  ): void {
    const dest = draft.destinatarioJson;
    // Modelo 65: destinatario e OPCIONAL (consumidor nao identificado —
    // grupo <dest> simplesmente omitido). Sem CPF/CNPJ util ⇒ omite tambem.
    if (modelo === "65") {
      if (!dest) return;
      const doc65 = onlyDigits(dest.cpfCnpj);
      if (!doc65) return;
      const destEl = parent.ele("dest");
      if (doc65.length <= 11) {
        destEl.ele("CPF").txt(doc65.padStart(11, "0")).up();
      } else {
        destEl.ele("CNPJ").txt(doc65).up();
      }
      // Mesma regra 598 de homologacao do 55 (literal obrigatorio no xNome).
      const xNome65 =
        draft.ambiente === "HOMOLOGACAO"
          ? HOMOLOG_DEST_XNOME
          : truncate(dest.nome, 60);
      if (xNome65) destEl.ele("xNome").txt(xNome65).up();
      // NFC-e: consumidor final nao contribuinte; SEM enderDest / IE.
      destEl.ele("indIEDest").txt("9").up();
      return;
    }

    if (!dest) return; // já validado em build()

    const destEl = parent.ele("dest");
    const doc = onlyDigits(dest.cpfCnpj);
    if (dest.tipoPessoa === "EXTERIOR") {
      destEl.ele("idEstrangeiro").txt(dest.cpfCnpj).up();
    } else if (doc.length <= 11) {
      destEl.ele("CPF").txt(doc.padStart(11, "0")).up();
    } else {
      destEl.ele("CNPJ").txt(doc).up();
    }

    // Regra SEFAZ (Rejeicao 598): em HOMOLOGACAO o xNome do destinatario DEVE
    // ser exatamente "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL".
    // Sem isso, TODA emissao de homologacao e rejeitada — e e por homologacao que
    // o emissor e credenciado. Em producao usa-se o nome real.
    const xNomeDest =
      draft.ambiente === "HOMOLOGACAO"
        ? HOMOLOG_DEST_XNOME
        : truncate(dest.nome, 60);
    destEl.ele("xNome").txt(xNomeDest).up();

    // <enderDest> e OBRIGATORIO para destinatario nacional (PF/PJ). So pode
    // ser omitido em operacao com EXTERIOR (idEstrangeiro). Emitimos sempre
    // para nacional — a completude dos campos e garantida pela validacao no
    // use case (NfeEmissionUseCase.validate), que falha localmente com mensagem
    // clara em vez de deixar a SEFAZ rejeitar com "sem endereco do destinatario".
    if (dest.tipoPessoa !== "EXTERIOR") {
      const ender = destEl.ele("enderDest");
      ender.ele("xLgr").txt(truncate(dest.logradouro ?? "SEM ENDERECO", 60)).up();
      ender.ele("nro").txt(truncate(dest.numero ?? "S/N", 60)).up();
      if (dest.complemento?.trim()) {
        ender.ele("xCpl").txt(truncate(dest.complemento, 60)).up();
      }
      ender.ele("xBairro").txt(truncate(dest.bairro ?? "CENTRO", 60)).up();
      ender.ele("cMun").txt((dest.codMunicipio ?? "").trim()).up();
      ender.ele("xMun").txt(truncate(dest.municipio ?? "", 60)).up();
      ender.ele("UF").txt((dest.uf ?? "").trim()).up();
      ender.ele("CEP").txt(onlyDigits(dest.cep ?? "")).up();
      ender.ele("cPais").txt(dest.codPais ?? "1058").up();
      ender.ele("xPais").txt(truncate(dest.pais ?? "BRASIL", 60)).up();
      if (dest.telefone) {
        ender.ele("fone").txt(onlyDigits(dest.telefone)).up();
      }
    }

    // Indicador IE: 1 = Contribuinte, 2 = Isento, 9 = Não contribuinte
    let indIEDest = "9";
    if (dest.tipoPessoa === "EXTERIOR") {
      indIEDest = "9";
    } else if (dest.inscricaoEstadual && dest.inscricaoEstadual !== "ISENTO") {
      indIEDest = "1";
    } else if (dest.tipoPessoa === "PJ") {
      indIEDest = "2";
    }
    destEl.ele("indIEDest").txt(indIEDest).up();

    if (indIEDest === "1" && dest.inscricaoEstadual) {
      destEl.ele("IE").txt(onlyDigits(dest.inscricaoEstadual)).up();
    }

    if (dest.email?.trim()) {
      destEl.ele("email").txt(truncate(dest.email, 60)).up();
    }
  }

  // ── <det nItem="N"> ──

  private buildDet(
    parent: any,
    item: NfeDraftItem,
    nItem: number,
    regime: RegimeTributario,
    modelo: "55" | "65" = "55",
    ambiente?: string,
  ): void {
    const det = parent.ele("det", { nItem: String(nItem) });

    // NFC-e em HOMOLOGACAO: a SEFAZ exige o literal no xProd do PRIMEIRO item
    // (equivalente da regra 598 do xNome, que no 65 pode nao ter <dest>).
    const xProd =
      modelo === "65" && ambiente === "HOMOLOGACAO" && nItem === 1
        ? HOMOLOG_NFCE_XPROD
        : truncate(item.descricao, 120);

    // <prod>
    const prod = det.ele("prod");
    prod.ele("cProd").txt(truncate(item.codigo, 60)).up();
    prod.ele("cEAN").txt("SEM GTIN").up();
    prod.ele("xProd").txt(xProd).up();
    prod.ele("NCM").txt(onlyDigits(item.ncm)).up();
    if (item.cest) {
      prod.ele("CEST").txt(onlyDigits(item.cest)).up();
    }
    prod.ele("CFOP").txt(onlyDigits(item.cfop)).up();
    prod.ele("uCom").txt(truncate(item.unidade, 6)).up();
    prod.ele("qCom").txt(fmt4(item.quantidade)).up();
    prod.ele("vUnCom").txt(fmt4(item.valorUnitario)).up();
    prod.ele("vProd").txt(fmt2(item.valorTotal)).up();
    prod.ele("cEANTrib").txt("SEM GTIN").up();
    prod.ele("uTrib").txt(truncate(item.unidade, 6)).up();
    prod.ele("qTrib").txt(fmt4(item.quantidade)).up();
    prod.ele("vUnTrib").txt(fmt4(item.valorUnitario)).up();

    if (item.desconto && Number(item.desconto) > 0) {
      prod.ele("vDesc").txt(fmt2(item.desconto)).up();
    }

    prod.ele("indTot").txt("1").up();

    // <imposto>
    const imposto = det.ele("imposto");
    const tributos = (item.tributosJson ?? emptyTributos()) as NfeItemTributos;

    this.buildIcms(imposto, item, regime, tributos);
    // <IPI> nao se aplica ao modelo 65 (venda a consumidor final).
    if (modelo !== "65") this.buildIpi(imposto, item, tributos);
    this.buildPis(imposto, item, regime, tributos);
    this.buildCofins(imposto, item, regime, tributos);
  }

  // ── <ICMS> ──

  private buildIcms(
    parent: any,
    item: NfeDraftItem,
    regime: RegimeTributario,
    trib: NfeItemTributos,
  ): void {
    const icms = parent.ele("ICMS");
    const orig = String(item.origem ?? 0);

    if (regime === "SIMPLES") {
      // Simples Nacional: CSOSN 101..900 → ICMSSNxxx
      const csosn = item.cstIcms ?? "102";
      const tag = `ICMSSN${csosn}`;
      const node = icms.ele(tag);
      node.ele("orig").txt(orig).up();
      node.ele("CSOSN").txt(csosn).up();
      // CSOSN 101 / 201 / 900 podem ter vCredICMSSN, mas é raro fora de regime
      // específico; deixamos para evoluir conforme necessidade.
      if ((csosn === "101" || csosn === "201") && trib.valorIcms > 0) {
        node.ele("pCredSN").txt(fmt2(trib.aliquotaIcms)).up();
        node.ele("vCredICMSSN").txt(fmt2(trib.valorIcms)).up();
      }
      node.up();
    } else {
      // Regime normal: CST 00..90 → ICMSxx
      const cst = item.cstIcms ?? "00";
      const TRIBUTADO = ["00", "10", "20", "70", "90"];
      const DESONERADO = ["40", "41", "50"]; // isento / nao tributado / suspensao
      // Grupo gerado por CST. Para CSTs nao explicitamente cobertos, caímos no
      // grupo tributado (orig+CST+modBC+vBC+pICMS+vICMS) quando ha base/valor de
      // ICMS calculado; senao tratamos como desonerado (orig+CST). Isso evita
      // emitir um <ICMSxx> com apenas orig+CST quando o CST exige campos de
      // valor (rejeicao de schema). O nucleo do negocio e Simples (CSOSN), entao
      // o caminho CST e secundario.
      const grupo = TRIBUTADO.includes(cst)
        ? "tributado"
        : DESONERADO.includes(cst)
          ? "desonerado"
          : trib.bcIcms > 0 || trib.valorIcms > 0
            ? "tributado"
            : "desonerado";

      const tag = `ICMS${cst}`;
      const node = icms.ele(tag);
      node.ele("orig").txt(orig).up();
      node.ele("CST").txt(cst).up();

      if (grupo === "tributado") {
        node.ele("modBC").txt("3").up(); // 3 = valor da operação
        node.ele("vBC").txt(fmt2(trib.bcIcms)).up();
        node.ele("pICMS").txt(fmt2(trib.aliquotaIcms)).up();
        node.ele("vICMS").txt(fmt2(trib.valorIcms)).up();
      }
      // desonerado: apenas orig + CST (vICMSDeson/motDesonICMS sao condicionais
      // e so se aplicam quando ha desoneracao efetiva, que nao calculamos aqui).
      node.up();
    }
    icms.up();
  }

  // ── <IPI> ──

  private buildIpi(parent: any, item: NfeDraftItem, trib: NfeItemTributos): void {
    if (!trib.valorIpi || trib.valorIpi <= 0) return;

    const ipi = parent.ele("IPI");
    ipi.ele("cEnq").txt("999").up(); // 999 = tributação normal
    const trib50 = ipi.ele("IPITrib");
    trib50.ele("CST").txt("50").up();
    trib50.ele("vBC").txt(fmt2(trib.bcIpi)).up();
    trib50.ele("pIPI").txt(fmt2(trib.aliquotaIpi)).up();
    trib50.ele("vIPI").txt(fmt2(trib.valorIpi)).up();
    trib50.up();
    ipi.up();
  }

  // ── <PIS> ──

  private buildPis(
    parent: any,
    item: NfeDraftItem,
    regime: RegimeTributario,
    trib: NfeItemTributos,
  ): void {
    const pis = parent.ele("PIS");
    const cst = item.cstPis ?? (regime === "SIMPLES" ? "49" : "01");

    if (cst === "01" || cst === "02") {
      const node = pis.ele("PISAliq");
      node.ele("CST").txt(cst).up();
      node.ele("vBC").txt(fmt2(trib.bcPis)).up();
      node.ele("pPIS").txt(fmt2(trib.aliquotaPis)).up();
      node.ele("vPIS").txt(fmt2(trib.valorPis)).up();
      node.up();
    } else if (cst === "04" || cst === "06" || cst === "07" || cst === "08" || cst === "09") {
      const node = pis.ele("PISNT");
      node.ele("CST").txt(cst).up();
      node.up();
    } else {
      // CST 49 e demais — PISOutr (default Simples + outras situações)
      const node = pis.ele("PISOutr");
      node.ele("CST").txt(cst).up();
      node.ele("vBC").txt(fmt2(trib.bcPis)).up();
      node.ele("pPIS").txt(fmt2(trib.aliquotaPis)).up();
      node.ele("vPIS").txt(fmt2(trib.valorPis)).up();
      node.up();
    }
    pis.up();
  }

  // ── <COFINS> ──

  private buildCofins(
    parent: any,
    item: NfeDraftItem,
    regime: RegimeTributario,
    trib: NfeItemTributos,
  ): void {
    const cofins = parent.ele("COFINS");
    const cst = item.cstCofins ?? (regime === "SIMPLES" ? "49" : "01");

    if (cst === "01" || cst === "02") {
      const node = cofins.ele("COFINSAliq");
      node.ele("CST").txt(cst).up();
      node.ele("vBC").txt(fmt2(trib.bcCofins)).up();
      node.ele("pCOFINS").txt(fmt2(trib.aliquotaCofins)).up();
      node.ele("vCOFINS").txt(fmt2(trib.valorCofins)).up();
      node.up();
    } else if (cst === "04" || cst === "06" || cst === "07" || cst === "08" || cst === "09") {
      const node = cofins.ele("COFINSNT");
      node.ele("CST").txt(cst).up();
      node.up();
    } else {
      const node = cofins.ele("COFINSOutr");
      node.ele("CST").txt(cst).up();
      node.ele("vBC").txt(fmt2(trib.bcCofins)).up();
      node.ele("pCOFINS").txt(fmt2(trib.aliquotaCofins)).up();
      node.ele("vCOFINS").txt(fmt2(trib.valorCofins)).up();
      node.up();
    }
    cofins.up();
  }

  // ── <total> ──

  private buildTotal(parent: any, draft: NfeDraftResponse): void {
    const totais =
      draft.totaisJson ?? deriveTotaisFromItens(draft.itens);

    const total = parent.ele("total");
    const icmsTot = total.ele("ICMSTot");

    // Todos os campos abaixo são obrigatórios mesmo zerados (SEFAZ exige).
    icmsTot.ele("vBC").txt(fmt2(totais.totalBcIcms)).up();
    icmsTot.ele("vICMS").txt(fmt2(totais.totalIcms)).up();
    icmsTot.ele("vICMSDeson").txt("0.00").up();
    icmsTot.ele("vFCP").txt("0.00").up();
    icmsTot.ele("vBCST").txt("0.00").up();
    icmsTot.ele("vST").txt("0.00").up();
    icmsTot.ele("vFCPST").txt("0.00").up();
    icmsTot.ele("vFCPSTRet").txt("0.00").up();
    icmsTot.ele("vProd").txt(fmt2(totais.totalProdutos)).up();
    icmsTot.ele("vFrete").txt("0.00").up();
    icmsTot.ele("vSeg").txt("0.00").up();
    icmsTot.ele("vDesc").txt(fmt2(totais.totalDesconto)).up();
    icmsTot.ele("vII").txt("0.00").up();
    icmsTot.ele("vIPI").txt(fmt2(totais.totalIpi)).up();
    icmsTot.ele("vIPIDevol").txt("0.00").up();
    icmsTot.ele("vPIS").txt(fmt2(totais.totalPis)).up();
    icmsTot.ele("vCOFINS").txt(fmt2(totais.totalCofins)).up();
    icmsTot.ele("vOutro").txt("0.00").up();
    icmsTot.ele("vNF").txt(fmt2(totais.totalNota)).up();
  }

  // ── <transp> ──

  private buildTransp(
    parent: any,
    draft: NfeDraftResponse,
    modelo: "55" | "65" = "55",
  ): void {
    const transp = parent.ele("transp");
    // NFC-e: entrega no balcao — sempre sem frete (9) e sem transportadora.
    const mod = modelo === "65"
      ? "9"
      : (MODALIDADE_FRETE_COD[
          (draft.modalidadeFrete ?? "SEM_FRETE") as ModalidadeFrete
        ] ?? "9");
    transp.ele("modFrete").txt(mod).up();

    if (modelo === "65") {
      transp.up();
      return;
    }

    const t = draft.transportadoraJson as any;
    if (t?.cpfCnpj || t?.nome) {
      const transportador = transp.ele("transporta");
      const doc = onlyDigits(t.cpfCnpj ?? "");
      if (doc.length === 11) {
        transportador.ele("CPF").txt(doc).up();
      } else if (doc.length === 14) {
        transportador.ele("CNPJ").txt(doc).up();
      }
      if (t.nome) transportador.ele("xNome").txt(truncate(t.nome, 60)).up();
      if (t.inscricaoEstadual) {
        transportador.ele("IE").txt(onlyDigits(t.inscricaoEstadual)).up();
      }
      if (t.endereco) transportador.ele("xEnder").txt(truncate(t.endereco, 60)).up();
      if (t.municipio) transportador.ele("xMun").txt(truncate(t.municipio, 60)).up();
      if (t.uf) transportador.ele("UF").txt(t.uf).up();
    }

    transp.up();
  }

  // ── <cobr> (duplicatas) ──

  private buildCobr(parent: any, draft: NfeDraftResponse): void {
    const duplicatas = (draft.duplicatasJson as any[]) || [];
    if (duplicatas.length === 0) return;

    const cobr = parent.ele("cobr");
    duplicatas.forEach((d, idx) => {
      const dup = cobr.ele("dup");
      dup.ele("nDup").txt(d.numero ?? String(idx + 1).padStart(3, "0")).up();
      if (d.dataVencimento) {
        dup.ele("dVenc").txt(formatDateOnly(new Date(d.dataVencimento))).up();
      }
      dup.ele("vDup").txt(fmt2(Number(d.valor ?? 0))).up();
      dup.up();
    });
    cobr.up();
  }

  // ── <pag> ──

  private buildPag(parent: any, draft: NfeDraftResponse): void {
    const pag = parent.ele("pag");
    const pagamentos = (draft.pagamentosJson as any[]) || [];

    if (pagamentos.length === 0) {
      const detPag = pag.ele("detPag");
      detPag.ele("tPag").txt("90").up(); // 90 = sem pagamento
      detPag.ele("vPag").txt("0.00").up();
      detPag.up();
    } else {
      const modelo: ModeloDocumento = draft.modelo === "65" ? "65" : "55";
      pagamentos.forEach((p) => {
        const detPag = pag.ele("detPag");
        const cod = MEIO_PAGAMENTO_COD[p.meio as MeioPagamento] ?? "99";
        detPag.ele("tPag").txt(cod).up();
        detPag.ele("vPag").txt(fmt2(Number(p.valor ?? 0))).up();
        // Grupo `card` (YA04a) — obrigatório em cartão (03/04) e, desde a NT
        // 2025.001, também em PIX (17). Sem ele a SEFAZ rejeita com 391.
        // A decisão é centralizada em exigeGrupoCard: aqui só se OBEDECE.
        // Ordem do layout: <card> vem DEPOIS de <vPag>, dentro do detPag —
        // por isso é montado por último, e por pagamento (misto funciona:
        // cada detPag decide sozinho).
        if (exigeGrupoCard(cod, modelo)) {
          const card = detPag.ele("card");
          // tpIntegra=2 (não integrado): o Dexo registra o meio, não captura a
          // transação. Com 2, CNPJ/tBand/cAut são opcionais e ficam de fora —
          // informá-los em branco ou inventados é que causaria rejeição.
          card.ele("tpIntegra").txt(TP_INTEGRA_NAO_INTEGRADO).up();
          card.up();
        }
        detPag.up();
      });
    }
    pag.up();
  }

  // ── <infAdic> ──

  private buildInfAdic(parent: any, draft: NfeDraftResponse): void {
    // Observacoes do usuario primeiro, depois "Pedido: N" — composicao unica
    // em composeInfCpl (compartilhada com o builder Focus e o DANFE).
    // NOTA: o aviso de homologacao NAO vai aqui. A SEFAZ exige o literal no
    // xNome do <dest> (tratado em buildDest, regra 598), nao no infCpl.
    const infCpl = composeInfCpl(draft);
    if (!infCpl) return;

    const infAdic = parent.ele("infAdic");
    infAdic.ele("infCpl").txt(infCpl).up();
    infAdic.up();
  }

  // ── <infRespTec> (Responsável Técnico — NT 2018.005) ──

  private buildInfRespTec(
    parent: any,
    respTec: NfeRespTec | undefined,
    chaveAcesso: string,
  ): void {
    // KILL-SWITCH: sem respTec (env NFE_RESP_TEC_CNPJ vazio), NADA e emitido —
    // o XML fica identico ao anterior. Ver resolveRespTecFromEnv.
    if (!respTec) return;

    const cnpj = onlyDigits(respTec.cnpj);
    const xContato = truncate(respTec.xContato ?? "", 60);
    const email = truncate(respTec.email ?? "", 60);
    const fone = onlyDigits(respTec.fone);

    // Validacao defensiva: NAO emitir um grupo pela metade (a SEFAZ rejeita).
    // Falha local com mensagem clara (no espirito de NfeEmissionUseCase.validate)
    // em vez de deixar a rejeicao generica da SEFAZ.
    if (cnpj.length !== 14) {
      throw new Error(
        "infRespTec: CNPJ do Responsavel Tecnico invalido (NFE_RESP_TEC_CNPJ deve ter 14 digitos).",
      );
    }
    const faltantes: string[] = [];
    if (!xContato) faltantes.push("xContato (NFE_RESP_TEC_XCONTATO)");
    if (!email) faltantes.push("email (NFE_RESP_TEC_EMAIL)");
    if (!fone) faltantes.push("fone (NFE_RESP_TEC_FONE)");
    if (faltantes.length > 0) {
      throw new Error(
        `infRespTec habilitado mas incompleto — preencha: ${faltantes.join(", ")}.`,
      );
    }

    const grp = parent.ele("infRespTec");
    grp.ele("CNPJ").txt(cnpj).up();
    grp.ele("xContato").txt(xContato).up();
    grp.ele("email").txt(email).up();
    grp.ele("fone").txt(fone).up();

    // CSRT (condicional): SO emite idCSRT+hashCSRT quando AMBOS estao setados.
    // hashCSRT = Base64( SHA-1( CSRT + chaveAcesso ) ). Off por padrao (GO/produção
    // sem CSRT resolve so com CNPJ/xContato/email/fone).
    if (respTec.idCSRT && respTec.csrt) {
      const hash = createHash("sha1")
        .update(respTec.csrt + chaveAcesso, "utf8")
        .digest("base64");
      grp.ele("idCSRT").txt(respTec.idCSRT).up();
      grp.ele("hashCSRT").txt(hash).up();
    }

    grp.up();
  }
}

/** Literal obrigatorio no xNome do destinatario em homologacao (Rejeicao 598). */
const HOMOLOG_DEST_XNOME =
  "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";

/** Literal obrigatorio no xProd do 1o item da NFC-e em homologacao. */
const HOMOLOG_NFCE_XPROD =
  "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";

// ── Helpers puros ──

function onlyDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  // Campos texto da NF-e (TString) NÃO podem ter espaço no início/fim — o XSD
  // rejeita com "Falha no Schema XML do lote". Damos trim ANTES de truncar.
  // Para valores já limpos, s.trim() === s → comportamento idêntico (sem
  // regressão); só remove espaços sobrando (ex.: nome de produto importado do
  // marketplace terminando em " ").
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function fmt2(n: number | null | undefined): string {
  return Number(n ?? 0).toFixed(2);
}

function fmt4(n: number | null | undefined): string {
  return Number(n ?? 0).toFixed(4);
}

// Brasil = UTC-03:00, sem horario de verao desde 2019. A NFe usa a hora LOCAL
// do estabelecimento emitente. Fixamos -03:00 em vez de derivar de
// getTimezoneOffset() do runtime — senao um servidor em UTC (caso comum em
// VPS/containers) carimbaria offset +00:00 e geraria dhEmi divergente da hora
// real da operacao (e AAMM da chave inconsistente). Ver brazilParts.
const BRAZIL_OFFSET_MIN = -180;

interface BrazilParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  min: number;
  sec: number;
}

/**
 * Converte um instante absoluto para os componentes de data/hora no fuso de
 * Brasilia (UTC-03:00), independentemente do timezone do servidor. Desloca o
 * instante por -3h e le os componentes em UTC.
 */
function brazilParts(d: Date): BrazilParts {
  const shifted = new Date(d.getTime() + BRAZIL_OFFSET_MIN * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    min: shifted.getUTCMinutes(),
    sec: shifted.getUTCSeconds(),
  };
}

function formatDhEmi(d: Date): string {
  // ISO 8601 com offset fixo -03:00, ex.: 2026-05-14T12:00:00-03:00
  const pad = (n: number) => String(n).padStart(2, "0");
  const p = brazilParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.min)}:${pad(p.sec)}-03:00`;
}

function formatDateOnly(d: Date): string {
  // Mesma logica de fuso do dhEmi: data no horario de Brasilia, independente
  // do TZ do servidor (evita "virar o dia" em servidor UTC).
  const pad = (n: number) => String(n).padStart(2, "0");
  const p = brazilParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function crtFromRegime(regime: RegimeTributario): string {
  // CRT: 1=Simples Nacional, 2=Simples Excesso, 3=Regime Normal (LP/LR), 4=MEI
  if (regime === "SIMPLES") return "1";
  return "3";
}

function emptyTributos(): NfeItemTributos {
  return {
    bcIcms: 0,
    valorIcms: 0,
    aliquotaIcms: 0,
    bcIpi: 0,
    valorIpi: 0,
    aliquotaIpi: 0,
    bcPis: 0,
    valorPis: 0,
    aliquotaPis: 0,
    bcCofins: 0,
    valorCofins: 0,
    aliquotaCofins: 0,
    valorTotalTributos: 0,
  };
}

function deriveTotaisFromItens(itens: NfeDraftItem[]): {
  totalProdutos: number;
  totalDesconto: number;
  totalBcIcms: number;
  totalIcms: number;
  totalBcIpi: number;
  totalIpi: number;
  totalPis: number;
  totalCofins: number;
  totalNota: number;
  totalTributos: number;
} {
  let prod = 0;
  let desc = 0;
  let bcIcms = 0;
  let icms = 0;
  let bcIpi = 0;
  let ipi = 0;
  let pis = 0;
  let cofins = 0;

  for (const i of itens) {
    prod += Number(i.valorTotal);
    desc += Number(i.desconto ?? 0);
    const t = (i.tributosJson ?? emptyTributos()) as NfeItemTributos;
    bcIcms += t.bcIcms;
    icms += t.valorIcms;
    bcIpi += t.bcIpi;
    ipi += t.valorIpi;
    pis += t.valorPis;
    cofins += t.valorCofins;
  }

  const totalNota = prod - desc + ipi;
  return {
    totalProdutos: prod,
    totalDesconto: desc,
    totalBcIcms: bcIcms,
    totalIcms: icms,
    totalBcIpi: bcIpi,
    totalIpi: ipi,
    totalPis: pis,
    totalCofins: cofins,
    totalNota,
    totalTributos: icms + ipi + pis + cofins,
  };
}
