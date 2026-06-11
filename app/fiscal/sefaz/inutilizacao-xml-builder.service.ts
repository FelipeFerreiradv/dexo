/**
 * Construtor de XML para inutilização de faixa de numeração NFe (NfeInutilizacao4).
 *
 * Saída: string `<inutNFe versao="4.00"><infInut Id="ID...">...</infInut></inutNFe>`
 * SEM `<Signature>` (assinatura entra depois via `XmlSignerService`, referenciando
 * `infInut`).
 *
 * Id do infInut (formato fixo de 43 chars):
 *   ID + cUF(2) + ano(2) + CNPJ(14) + mod(2) + serie(3) + nNFIni(9) + nNFFin(9)
 *   → total 43 caracteres
 */

import { create } from "xmlbuilder2";
import { COD_UF, type UF } from "./endpoints";

const NFE_NS = "http://www.portalfiscal.inf.br/nfe";

export interface InutilizacaoBuildOptions {
  uf: UF;
  ambiente: "homologacao" | "producao";
  cnpj: string;
  /** Ano da inutilização (4 dígitos — usaremos os 2 últimos). */
  ano: number;
  modelo: "55" | "65";
  serie: number;
  nNFIni: number;
  nNFFin: number;
  /** Justificativa (15..255 chars). */
  xJust: string;
}

export interface InutilizacaoBuildResult {
  xml: string;
  infInutId: string;
}

export class InutilizacaoXmlBuilderService {
  build(opts: InutilizacaoBuildOptions): InutilizacaoBuildResult {
    const cnpj = onlyDigits(opts.cnpj);
    if (cnpj.length !== 14) {
      throw new Error(
        `Inutilizacao: CNPJ deve ter 14 digitos (recebido: ${cnpj.length})`,
      );
    }
    if (opts.serie < 0 || opts.serie > 999) {
      throw new Error(`Inutilizacao: serie fora do range 0..999`);
    }
    if (opts.nNFIni < 1 || opts.nNFFin < 1) {
      throw new Error(`Inutilizacao: nNFIni/nNFFin devem ser >= 1`);
    }
    if (opts.nNFIni > opts.nNFFin) {
      throw new Error(
        `Inutilizacao: nNFIni (${opts.nNFIni}) > nNFFin (${opts.nNFFin})`,
      );
    }
    if (opts.xJust.length < 15 || opts.xJust.length > 255) {
      throw new Error(
        "Inutilizacao: xJust deve ter 15..255 caracteres",
      );
    }

    const cUF = pad(COD_UF[opts.uf], 2);
    const ano2 = pad(opts.ano % 100, 2);
    const mod = opts.modelo;
    const serie3 = pad(opts.serie, 3);
    const ini9 = pad(opts.nNFIni, 9);
    const fin9 = pad(opts.nNFFin, 9);
    const infInutId = `ID${cUF}${ano2}${cnpj}${mod}${serie3}${ini9}${fin9}`;

    if (infInutId.length !== 43) {
      throw new Error(
        `Inutilizacao: Id calculado tem ${infInutId.length} chars (esperado 43)`,
      );
    }

    const tpAmb = opts.ambiente === "producao" ? "1" : "2";

    const doc = create({ version: "1.0", encoding: "UTF-8" });
    const inut = doc.ele("inutNFe", { xmlns: NFE_NS, versao: "4.00" });
    const infInut = inut.ele("infInut", { Id: infInutId });

    infInut.ele("tpAmb").txt(tpAmb).up();
    infInut.ele("xServ").txt("INUTILIZAR").up();
    infInut.ele("cUF").txt(cUF).up();
    infInut.ele("ano").txt(ano2).up();
    infInut.ele("CNPJ").txt(cnpj).up();
    infInut.ele("mod").txt(mod).up();
    infInut.ele("serie").txt(String(opts.serie)).up();
    infInut.ele("nNFIni").txt(String(opts.nNFIni)).up();
    infInut.ele("nNFFin").txt(String(opts.nNFFin)).up();
    infInut.ele("xJust").txt(opts.xJust).up();

    const xml = doc.end({ headless: true, format: "xml" });
    return { xml, infInutId };
  }
}

function onlyDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function pad(value: number | string, len: number): string {
  return String(value).padStart(len, "0");
}
