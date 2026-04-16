/**
 * Monta o payload JSON no formato esperado pela API Focus NFe.
 *
 * Focus NFe recebe JSON e internamente gera/assina o XML modelo 55.
 * Docs: https://focusnfe.com.br/doc/#criacao-de-nfe
 *
 * Este builder converte NfeDraftResponse + CompanyFiscalConfig → JSON Focus.
 */

import type { NfeDraftResponse, NfeDraftItem, NfeDestinatario } from "../../interfaces/nfe.interface";
import type { CompanyFiscalConfig } from "../../interfaces/company-fiscal.interface";
import type { NfeItemTributos, NfeTotais, RegimeTributario } from "../domain/nfe.types";
import {
  FINALIDADE_NFE_COD,
  DESTINO_OPERACAO_COD,
  MODALIDADE_FRETE_COD,
  IND_PRESENCA_COD,
  MEIO_PAGAMENTO_COD,
  type FinalidadeNfe,
  type DestinoOperacao,
  type ModalidadeFrete,
  type IndicadorPresenca,
  type MeioPagamento,
} from "../domain/nfe.types";

export interface FocusNfePayload {
  [key: string]: any;
}

export class NfeXmlBuilderService {
  /**
   * Monta payload completo para envio ao Focus NFe.
   */
  build(
    draft: NfeDraftResponse,
    config: CompanyFiscalConfig,
    numero: number,
  ): FocusNfePayload {
    const payload: FocusNfePayload = {};

    // ── Identificação ──
    payload.natureza_operacao = draft.naturezaOperacao;
    payload.forma_pagamento = "0"; // 0 = à vista (campo legado, Focus aceita)
    payload.tipo_documento = draft.tipoOperacao === "SAIDA" ? "1" : "0";
    payload.local_destino = DESTINO_OPERACAO_COD[draft.destinoOperacao as DestinoOperacao] ?? "1";
    payload.finalidade_emissao = FINALIDADE_NFE_COD[draft.finalidade as FinalidadeNfe] ?? "1";
    payload.consumidor_final = "1";
    payload.presenca_comprador = IND_PRESENCA_COD[draft.indPresenca as IndicadorPresenca] ?? "0";
    payload.numero_nota = String(numero);
    payload.serie = String(draft.serie);

    if (draft.dataEmissao) {
      payload.data_emissao = new Date(draft.dataEmissao).toISOString();
    }
    if (draft.dataSaida) {
      payload.data_entrada_saida = new Date(draft.dataSaida).toISOString();
    }

    // ── Emitente (via config) ──
    payload.cnpj_emitente = config.cnpj;
    payload.nome_emitente = config.razaoSocial;
    payload.nome_fantasia_emitente = config.nomeFantasia || config.razaoSocial;
    payload.inscricao_estadual_emitente = config.inscricaoEstadual;
    payload.logradouro_emitente = config.logradouro || "";
    payload.numero_emitente = config.numero || "S/N";
    payload.complemento_emitente = config.complemento || "";
    payload.bairro_emitente = config.bairro || "";
    payload.municipio_emitente = config.municipio || "";
    payload.codigo_municipio_emitente = config.codMunicipio || "";
    payload.uf_emitente = config.uf || "";
    payload.cep_emitente = config.cep || "";
    payload.codigo_pais_emitente = config.codPais || "1058";
    payload.pais_emitente = config.pais || "BRASIL";

    // Regime tributário Focus: 1=Simples, 2=Simples Excesso, 3=Regime Normal
    const regimeMap: Record<string, string> = {
      SIMPLES: "1",
      LUCRO_PRESUMIDO: "3",
      LUCRO_REAL: "3",
    };
    payload.regime_tributario_emitente = regimeMap[config.regimeTributario] ?? "3";

    if (config.inscricaoMunicipal) {
      payload.inscricao_municipal_emitente = config.inscricaoMunicipal;
    }
    if (config.cnae) {
      payload.cnae_fiscal_emitente = config.cnae;
    }

    // ── Destinatário ──
    const dest = draft.destinatarioJson;
    if (dest) {
      this.buildDestinatario(payload, dest);
    }

    // ── Itens ──
    payload.items = this.buildItems(
      draft.itens,
      config.regimeTributario as RegimeTributario,
    );

    // ── Frete ──
    payload.modalidade_frete = MODALIDADE_FRETE_COD[
      (draft.modalidadeFrete ?? "SEM_FRETE") as ModalidadeFrete
    ] ?? "9";

    const transp = draft.transportadoraJson as any;
    if (transp?.cpfCnpj) {
      if (transp.cpfCnpj.length <= 11) {
        payload.cpf_transportador = transp.cpfCnpj;
      } else {
        payload.cnpj_transportador = transp.cpfCnpj;
      }
      if (transp.nome) payload.nome_transportador = transp.nome;
      if (transp.inscricaoEstadual) payload.inscricao_estadual_transportador = transp.inscricaoEstadual;
      if (transp.endereco) payload.endereco_transportador = transp.endereco;
      if (transp.municipio) payload.municipio_transportador = transp.municipio;
      if (transp.uf) payload.uf_transportador = transp.uf;
    }

    // ── Volumes ──
    const volumes = draft.volumesJson as any[];
    if (volumes && volumes.length > 0) {
      payload.volumes = volumes.map((v: any) => ({
        quantidade: v.quantidade ? String(v.quantidade) : undefined,
        especie: v.especie || undefined,
        marca: v.marca || undefined,
        peso_liquido: v.pesoLiquido ? String(v.pesoLiquido) : undefined,
        peso_bruto: v.pesoBruto ? String(v.pesoBruto) : undefined,
      }));
    }

    // ── Duplicatas / Cobrança ──
    const duplicatas = draft.duplicatasJson as any[];
    if (duplicatas && duplicatas.length > 0) {
      payload.duplicatas = duplicatas.map((d: any) => ({
        numero: d.numero || undefined,
        data_vencimento: d.dataVencimento || undefined,
        valor: d.valor ? String(d.valor) : undefined,
      }));
    }

    // ── Pagamentos ──
    const pagamentos = draft.pagamentosJson as any[];
    if (pagamentos && pagamentos.length > 0) {
      payload.formas_pagamento = pagamentos.map((p: any) => ({
        tipo_pagamento: MEIO_PAGAMENTO_COD[p.meio as MeioPagamento] ?? "99",
        valor_pagamento: p.valor ? String(Number(p.valor).toFixed(2)) : "0.00",
      }));
    } else {
      // Default: sem pagamento
      payload.formas_pagamento = [
        { tipo_pagamento: "90", valor_pagamento: "0.00" },
      ];
    }

    // ── Notas referenciadas ──
    const notasRef = draft.notasReferenciadasJson as any[];
    if (notasRef && notasRef.length > 0) {
      payload.notas_referenciadas = notasRef.map((n: any) => ({
        chave_nfe: n.chaveAcesso,
      }));
    }

    // ── Informações adicionais ──
    if (draft.numeroPedido) {
      payload.informacoes_adicionais_contribuinte = `Pedido: ${draft.numeroPedido}`;
    }

    return payload;
  }

  private buildDestinatario(
    payload: FocusNfePayload,
    dest: NfeDestinatario,
  ): void {
    if (dest.cpfCnpj) {
      const doc = dest.cpfCnpj.replace(/\D/g, "");
      if (doc.length <= 11) {
        payload.cpf_destinatario = doc;
      } else {
        payload.cnpj_destinatario = doc;
      }
    }

    payload.nome_destinatario = dest.nome || "";

    if (dest.inscricaoEstadual) {
      payload.inscricao_estadual_destinatario = dest.inscricaoEstadual;
    }
    if (dest.email) {
      payload.email_destinatario = dest.email;
    }
    if (dest.telefone) {
      payload.telefone_destinatario = dest.telefone.replace(/\D/g, "");
    }

    payload.logradouro_destinatario = dest.logradouro || "";
    payload.numero_destinatario = dest.numero || "S/N";
    payload.complemento_destinatario = dest.complemento || "";
    payload.bairro_destinatario = dest.bairro || "";
    payload.municipio_destinatario = dest.municipio || "";
    payload.codigo_municipio_destinatario = dest.codMunicipio || "";
    payload.uf_destinatario = dest.uf || "";
    payload.cep_destinatario = (dest.cep || "").replace(/\D/g, "");
    payload.codigo_pais_destinatario = dest.codPais || "1058";
    payload.pais_destinatario = dest.pais || "BRASIL";

    // Indicador IE destinatário:
    // 1 = Contribuinte ICMS, 2 = Isento, 9 = Não contribuinte
    if (dest.inscricaoEstadual && dest.inscricaoEstadual !== "ISENTO") {
      payload.indicador_inscricao_estadual_destinatario = "1";
    } else if (dest.tipoPessoa === "PJ") {
      payload.indicador_inscricao_estadual_destinatario = "2";
    } else {
      payload.indicador_inscricao_estadual_destinatario = "9";
    }
  }

  private buildItems(
    itens: NfeDraftItem[],
    regime: RegimeTributario,
  ): any[] {
    return itens.map((item, idx) => {
      const tributos = (item.tributosJson ?? {}) as NfeItemTributos;
      const valorTotal = Number(item.valorTotal);
      const desconto = Number(item.desconto ?? 0);

      const focusItem: any = {
        numero_item: String(item.numero ?? idx + 1),
        codigo_produto: item.codigo,
        descricao: item.descricao,
        codigo_ncm: item.ncm,
        cfop: item.cfop,
        unidade_comercial: item.unidade,
        quantidade_comercial: String(item.quantidade),
        valor_unitario_comercial: String(Number(item.valorUnitario).toFixed(4)),
        valor_bruto: String(valorTotal.toFixed(2)),
        unidade_tributavel: item.unidade,
        quantidade_tributavel: String(item.quantidade),
        valor_unitario_tributavel: String(Number(item.valorUnitario).toFixed(4)),
        origem: String(item.origem ?? 0),
        inclui_no_total: "1",
      };

      if (item.cest) {
        focusItem.codigo_cest = item.cest;
      }

      if (desconto > 0) {
        focusItem.valor_desconto = String(desconto.toFixed(2));
      }

      // ── ICMS ──
      if (regime === "SIMPLES") {
        const csosn = item.cstIcms || "102";
        focusItem.icms_situacao_tributaria = csosn;
        focusItem.icms_origem = String(item.origem ?? 0);
      } else {
        const cst = item.cstIcms || "00";
        focusItem.icms_situacao_tributaria = cst;
        focusItem.icms_origem = String(item.origem ?? 0);

        if (tributos.bcIcms > 0) {
          focusItem.icms_modalidade_base_calculo = "3"; // valor da operação
          focusItem.icms_base_calculo = String(tributos.bcIcms.toFixed(2));
          focusItem.icms_aliquota = String(tributos.aliquotaIcms.toFixed(2));
          focusItem.icms_valor = String(tributos.valorIcms.toFixed(2));
        }
      }

      // ── PIS ──
      const cstPis = item.cstPis || (regime === "SIMPLES" ? "49" : "01");
      focusItem.pis_situacao_tributaria = cstPis;
      if (tributos.bcPis > 0) {
        focusItem.pis_base_calculo = String(tributos.bcPis.toFixed(2));
        focusItem.pis_aliquota_porcentual = String(tributos.aliquotaPis.toFixed(2));
        focusItem.pis_valor = String(tributos.valorPis.toFixed(2));
      }

      // ── COFINS ──
      const cstCofins = item.cstCofins || (regime === "SIMPLES" ? "49" : "01");
      focusItem.cofins_situacao_tributaria = cstCofins;
      if (tributos.bcCofins > 0) {
        focusItem.cofins_base_calculo = String(tributos.bcCofins.toFixed(2));
        focusItem.cofins_aliquota_porcentual = String(tributos.aliquotaCofins.toFixed(2));
        focusItem.cofins_valor = String(tributos.valorCofins.toFixed(2));
      }

      return focusItem;
    });
  }
}
