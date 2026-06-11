/**
 * Construtor de XMLs de evento para SEFAZ (NT 2014.002 v4.00).
 *
 * Cobre dois eventos hoje:
 *  - 110111 (Cancelamento de NFe) — F-E
 *  - 110110 (Carta de Correção)   — F-F (uso futuro, builder já preparado)
 *
 * Saída: string `<evento versao="1.00"><infEvento Id="ID...">...</infEvento></evento>`
 * SEM `<Signature>` (assinatura entra depois via `XmlSignerService`, referenciando
 * `infEvento` em vez de `infNFe`).
 *
 * O Id do `infEvento` é determinístico:
 *   ID = "ID" + tpEvento(6) + chNFe(44) + nSeqEvento(2 dígitos com pad)
 *   → total 54 caracteres.
 *
 * Builder PURO — sem I/O, sem chamadas externas.
 */

import { create } from "xmlbuilder2";
import { COD_UF, type UF } from "./endpoints";

const NFE_NS = "http://www.portalfiscal.inf.br/nfe";

export type EventoTpEvento =
  | "110111" // Cancelamento
  | "110110"; // Carta de Correção

export interface EventoBuildOptions {
  /** Chave de acesso da NFe a quem o evento se refere. */
  chNFe: string;
  /** UF do emitente (necessária para cOrgao). */
  uf: UF;
  /** Ambiente: "homologacao" → tpAmb=2, "producao" → tpAmb=1. */
  ambiente: "homologacao" | "producao";
  /** CNPJ do emitente (somente dígitos). */
  cnpj: string;
  /** Tipo do evento (110111 / 110110). */
  tpEvento: EventoTpEvento;
  /** Sequência do evento (1..20 para CCe, 1 para cancelamento). */
  nSeqEvento: number;
  /** Data/hora do evento. Default: agora. */
  dhEvento?: Date;
  /** Conteúdo `detEvento` por tipo. */
  detalhe: CancelamentoDetalhe | CartaCorrecaoDetalhe;
}

export interface CancelamentoDetalhe {
  kind: "cancelamento";
  /** Protocolo de autorização da NFe que está sendo cancelada. */
  nProt: string;
  /** Justificativa (15..255 chars sem caracteres proibidos). */
  xJust: string;
}

export interface CartaCorrecaoDetalhe {
  kind: "cce";
  /** Texto da correção (15..1000 chars). */
  xCorrecao: string;
}

export interface EventoBuildResult {
  /** XML `<evento>...</evento>` sem Signature. */
  xml: string;
  /** Id do infEvento (ex.: "ID110111<chave>01"). */
  infEventoId: string;
  /** Texto do detEvento (descEvento) — útil para auditoria. */
  descEvento: "Cancelamento" | "Carta de Correcao";
}

export class EventoXmlBuilderService {
  build(opts: EventoBuildOptions): EventoBuildResult {
    const chNFe = onlyDigits(opts.chNFe);
    if (chNFe.length !== 44) {
      throw new Error(
        `Evento: chNFe deve ter 44 digitos (recebido: ${chNFe.length})`,
      );
    }
    const cnpj = onlyDigits(opts.cnpj);
    if (cnpj.length !== 14) {
      throw new Error(`Evento: CNPJ deve ter 14 digitos (recebido: ${cnpj.length})`);
    }
    if (opts.nSeqEvento < 1 || opts.nSeqEvento > 99) {
      throw new Error(
        `Evento: nSeqEvento fora do range 1..99 (recebido: ${opts.nSeqEvento})`,
      );
    }

    const tpAmb = opts.ambiente === "producao" ? "1" : "2";
    const cOrgao = COD_UF[opts.uf];
    const nSeqStr = String(opts.nSeqEvento).padStart(2, "0");
    const dhEvento = formatDhEvento(opts.dhEvento ?? new Date());
    const infEventoId = `ID${opts.tpEvento}${chNFe}${nSeqStr}`;

    if (infEventoId.length !== 54) {
      throw new Error(
        `Evento: Id calculado tem ${infEventoId.length} chars (esperado 54)`,
      );
    }

    const doc = create({ version: "1.0", encoding: "UTF-8" });
    const evento = doc.ele("evento", { xmlns: NFE_NS, versao: "1.00" });
    const infEvento = evento.ele("infEvento", { Id: infEventoId });
    infEvento.ele("cOrgao").txt(String(cOrgao)).up();
    infEvento.ele("tpAmb").txt(tpAmb).up();
    infEvento.ele("CNPJ").txt(cnpj).up();
    infEvento.ele("chNFe").txt(chNFe).up();
    infEvento.ele("dhEvento").txt(dhEvento).up();
    infEvento.ele("tpEvento").txt(opts.tpEvento).up();
    infEvento.ele("nSeqEvento").txt(String(opts.nSeqEvento)).up();
    infEvento.ele("verEvento").txt("1.00").up();

    const detEvento = infEvento.ele("detEvento", { versao: "1.00" });
    let descEvento: EventoBuildResult["descEvento"];
    if (opts.detalhe.kind === "cancelamento") {
      if (opts.tpEvento !== "110111") {
        throw new Error("Detalhe 'cancelamento' exige tpEvento=110111");
      }
      if (opts.detalhe.xJust.length < 15 || opts.detalhe.xJust.length > 255) {
        throw new Error("Justificativa de cancelamento exige 15..255 caracteres");
      }
      descEvento = "Cancelamento";
      detEvento.ele("descEvento").txt(descEvento).up();
      detEvento.ele("nProt").txt(opts.detalhe.nProt).up();
      detEvento.ele("xJust").txt(opts.detalhe.xJust).up();
    } else {
      if (opts.tpEvento !== "110110") {
        throw new Error("Detalhe 'cce' exige tpEvento=110110");
      }
      if (opts.detalhe.xCorrecao.length < 15 || opts.detalhe.xCorrecao.length > 1000) {
        throw new Error("Texto da CCe exige 15..1000 caracteres");
      }
      descEvento = "Carta de Correcao";
      detEvento.ele("descEvento").txt(descEvento).up();
      detEvento.ele("xCorrecao").txt(opts.detalhe.xCorrecao).up();
      detEvento.ele("xCondUso").txt(CONDICOES_USO_CCE).up();
    }

    const xml = doc.end({ headless: true, format: "xml" });
    return { xml, infEventoId, descEvento };
  }
}

// Texto fixo exigido pela SEFAZ em toda Carta de Correção.
const CONDICOES_USO_CCE =
  "A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do " +
  "Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para " +
  "regularizacao de erro ocorrido na emissao de documento fiscal, desde " +
  "que o erro nao esteja relacionado com: I - as variaveis que determinam " +
  "o valor do imposto tais como: base de calculo, aliquota, diferenca de " +
  "preco, quantidade, valor da operacao ou da prestacao; II - a correcao " +
  "de dados cadastrais que implique mudanca do remetente ou do destinatario; " +
  "III - a data de emissao ou de saida.";

function onlyDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

// Brasil = UTC-03:00 (sem horario de verao desde 2019). Offset fixo, igual ao
// nfe-xml-builder-sefaz — NAO derivar de getTimezoneOffset() do runtime, pois
// um servidor em UTC carimbaria +00:00 (divergente da hora local da operacao e,
// num servidor em fuso positivo, poderia bater na Rejeicao 578). Ver EVT-1.
const BRAZIL_OFFSET_MIN = -180;

function formatDhEvento(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const shifted = new Date(d.getTime() + BRAZIL_OFFSET_MIN * 60_000);
  const yyyy = shifted.getUTCFullYear();
  const mm = pad(shifted.getUTCMonth() + 1);
  const dd = pad(shifted.getUTCDate());
  const hh = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const ss = pad(shifted.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-03:00`;
}
