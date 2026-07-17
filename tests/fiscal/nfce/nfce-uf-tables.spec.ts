import { describe, it, expect } from "vitest";

import {
  NFCE_ENDPOINTS,
  getNfceEndpoint,
  type UF,
} from "../../../app/fiscal/sefaz/endpoints";
import {
  NFCE_QR_URLS,
  getNfceQrUrls,
} from "../../../app/fiscal/nfce/nfce-urls";

// Tabelas NFC-e por UF (follow-up do PR #153) — conferidas por cruzamento
// ACBrNFeServicos.ini × sped-nfe (mod65) + probe HTTP nas divergências.

describe("NFCE_ENDPOINTS — expansão de UFs", () => {
  it("REGRESSÃO: SC continua no SVRS com as MESMAS URLs", () => {
    expect(getNfceEndpoint("SC", "homologacao", "NFeAutorizacao4")).toBe(
      "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
    );
    expect(getNfceEndpoint("SC", "producao", "NFeAutorizacao4")).toBe(
      "https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
    );
  });

  it("BA/CE/PA/PE entram como SVRS (SOAP no SVRS; só QR/consulta é próprio)", () => {
    for (const uf of ["BA", "CE", "PA", "PE"] as const) {
      expect(getNfceEndpoint(uf, "producao", "NFeAutorizacao4")).toBe(
        "https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
      );
    }
  });

  it("autorizadores próprios: GO, MG, MS, MT, PR, SP", () => {
    expect(getNfceEndpoint("GO", "producao", "NFeAutorizacao4")).toBe(
      "https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4",
    );
    expect(getNfceEndpoint("MG", "homologacao", "NFeAutorizacao4")).toBe(
      "https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4",
    );
    expect(getNfceEndpoint("MS", "producao", "NfeConsultaProtocolo4")).toBe(
      "https://nfce.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4",
    );
    // MT nomeia os serviços fora do padrão (NfeConsulta4, RecepcaoEvento4).
    expect(getNfceEndpoint("MT", "producao", "NfeConsultaProtocolo4")).toBe(
      "https://nfce.sefaz.mt.gov.br/nfcews/services/NfeConsulta4",
    );
    expect(getNfceEndpoint("PR", "producao", "NFeAutorizacao4")).toBe(
      "https://nfce.sefa.pr.gov.br/nfce/NFeAutorizacao4",
    );
    expect(getNfceEndpoint("SP", "producao", "NFeAutorizacao4")).toBe(
      "https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx",
    );
  });

  it("AM segue FORA (fontes divergem) → erro claro", () => {
    expect(() => getNfceEndpoint("AM", "producao", "NFeAutorizacao4")).toThrow(
      /nao suportada para NFC-e/,
    );
  });

  it("todas as UFs listadas têm os 5 serviços nos 2 ambientes, com https", () => {
    for (const [uf, cfg] of Object.entries(NFCE_ENDPOINTS)) {
      for (const amb of ["homologacao", "producao"] as const) {
        for (const [servico, url] of Object.entries(cfg[amb])) {
          expect(url, `${uf}/${amb}/${servico}`).toMatch(/^https:\/\//);
        }
        expect(Object.keys(cfg[amb])).toHaveLength(5);
      }
    }
  });
});

describe("NFCE_QR_URLS — expansão de UFs", () => {
  it("REGRESSÃO: SC e RS byte-idênticas ao que já estava em produção", () => {
    expect(getNfceQrUrls("SC", "homologacao")).toEqual({
      qr: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
      chave: "https://hom.sat.sef.sc.gov.br/nfce/consulta",
    });
    expect(getNfceQrUrls("SC", "producao")).toEqual({
      qr: "https://sat.sef.sc.gov.br/nfce/consulta",
      chave: "https://sat.sef.sc.gov.br/nfce/consulta",
    });
    expect(getNfceQrUrls("RS", "producao").qr).toBe(
      "https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx",
    );
  });

  it("spot-checks das UFs desempatadas por probe (RJ, RN, PB, BA, SP)", () => {
    // RJ hom: www4 (sped) redireciona para consultadfe (ACBr).
    expect(getNfceQrUrls("RJ", "homologacao").qr).toBe(
      "https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode",
    );
    // RN: host novo sefaz.rn.gov.br vivo; set.rn.gov.br morto.
    expect(getNfceQrUrls("RN", "producao").qr).toBe(
      "https://nfce.sefaz.rn.gov.br/consultarNFCe.aspx",
    );
    // PB hom: sefaz.pb.gov.br vivo; receita.pb.gov.br morto.
    expect(getNfceQrUrls("PB", "homologacao").chave).toBe(
      "www.sefaz.pb.gov.br/nfcehom",
    );
    // BA/SP: URL v2 do ACBr confirmada com HTTP 200 (a do sped era a v1).
    expect(getNfceQrUrls("BA", "producao").qr).toBe(
      "http://nfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx",
    );
    expect(getNfceQrUrls("SP", "producao").qr).toBe(
      "https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx",
    );
  });

  it("UFs sem desempate seguem FORA → erro claro (AM, PE, RR, SE)", () => {
    for (const uf of ["AM", "PE", "RR", "SE"] as const) {
      expect(() => getNfceQrUrls(uf, "producao")).toThrow(
        /sem URLs de QR Code NFC-e/,
      );
    }
  });

  it("invariantes: qr sempre com esquema http(s); chave não vazia; toda UF com QR tem autorizador", () => {
    for (const [uf, cfg] of Object.entries(NFCE_QR_URLS)) {
      for (const amb of ["homologacao", "producao"] as const) {
        // O QR precisa abrir no navegador do consumidor → esquema obrigatório.
        expect(cfg[amb].qr, `${uf}/${amb}/qr`).toMatch(/^https?:\/\//);
        // chave é o texto canônico do <urlChave> (pode vir sem esquema).
        expect(cfg[amb].chave.length, `${uf}/${amb}/chave`).toBeGreaterThan(10);
        // Sem "?" solto: o motor concatena "?p=" na URL do QR.
        expect(cfg[amb].qr.includes("?"), `${uf}/${amb}/qr sem query`).toBe(
          false,
        );
      }
      expect(
        NFCE_ENDPOINTS[uf as UF],
        `${uf} tem QR mas não tem autorizador`,
      ).toBeDefined();
    }
  });
});
