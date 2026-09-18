import { describe, it, expect } from "vitest";
import { NfeNumeracaoService } from "../../../app/fiscal/numeracao/numeracao.service";
import { classificarCStatSefaz, classificarConsultaSefaz } from "../../../app/fiscal/numeracao/classificacao";
import type { ContextoReserva, Reserva } from "../../../app/fiscal/numeracao/persistencia";
import { FakeNumeracaoRepository } from "../__harness__/fake-numeracao-repository";

function mundo() {
  const repo = new FakeNumeracaoRepository();
  let clock = new Date("2026-09-18T12:00:00Z");
  const svc = new NfeNumeracaoService(repo, () => clock, () => "12345678");
  const ctx = (id: string, patch: Partial<ContextoReserva> = {}): ContextoReserva => {
    const c: ContextoReserva = { userId: "tenant", nfeId: id, key: { cfc: "empresa", ambiente: "HOMOLOGACAO", modelo: "55", serie: 1 },
      isDefault: false, row: { numero: -1, serie: 1, ambiente: "HOMOLOGACAO", companyFiscalConfigId: "empresa", status: "DRAFT" },
      providerName: "SEFAZ_DIRECT", emitenteSnapshot: {}, ...patch };
    repo.state.notas.set(id, { id, userId: c.userId, numero: c.row.numero, status: "VALIDATING", key: c.key });
    return c;
  };
  const start = (r: Reserva) => svc.iniciarTransmissao(r, { provedor: "SEFAZ_DIRECT", chaveAcesso: "1".repeat(44), dhEmi: clock,
    digestValue: "digest", xmlAssinadoPath: "/tmp/assinado.xml", conteudoSha256: "a".repeat(64), focusRef: null }, 600_000);
  return { repo, svc, ctx, start, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe("persistência transacional da numeração V2", () => {
  it("readback Focus realinha nota, ledger e contador atomicamente",async()=>{
    const w=mundo();const c=w.ctx("focus",{providerName:"FOCUS_NFE"});
    const inicial=await w.svc.reservarOuReutilizar(c);
    const envio=await w.svc.iniciarTransmissao(inicial,{provedor:"FOCUS_NFE",chaveAcesso:null,dhEmi:new Date(),digestValue:null,xmlAssinadoPath:null,conteudoSha256:"a".repeat(64),focusRef:"focus"},600000);
    const real=await w.svc.registrarReadbackFocus(envio.reserva,envio.tentativa,{classificacao:classificarCStatSefaz(100),protocolo:"p",chaveAcesso:"1".repeat(44)},{numero:9,serie:1},false);
    expect(real).toMatchObject({numero:9,estado:"AUTORIZADO",origem:"READBACK_FOCUS"});
    expect(w.repo.state.reservas.get(inicial.id)?.estado).toBe("ABANDONADO");
    expect(w.repo.state.notas.get("focus")).toMatchObject({numero:9,status:"AUTHORIZED"});
    expect(await w.svc.focusRefAutorizada(c.userId,c.nfeId)).toBe("focus");
    expect((await w.svc.reservarOuReutilizar(w.ctx("proxima"))).numero).toBe(10);
  });
  it("20 reservas concorrentes usam 1..20 e deixam contador 21", async () => {
    const w = mundo();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => w.svc.reservarOuReutilizar(w.ctx(`n${i}`))));
    expect(rs.map(r => r.numero).sort((a,b) => a-b)).toEqual(Array.from({length: 20}, (_, i) => i + 1));
    expect([...w.repo.state.sequences.values()][0].proximoNumero).toBe(21);
  });
  it.each(["tenant", "empresa", "ambiente", "modelo", "serie"])("isola %s", async campo => {
    const w = mundo(); const a = w.ctx("a"); const b = w.ctx("b");
    if (campo === "tenant") { b.userId = "outro"; b.key.cfc = "empresa-outro-tenant"; }
    if (campo === "empresa") b.key.cfc = "outra";
    if (campo === "ambiente") b.key.ambiente = "PRODUCAO";
    if (campo === "modelo") b.key.modelo = "65";
    if (campo === "serie") b.key.serie = 2;
    w.repo.state.notas.get("b")!.userId = b.userId;
    const rs = await Promise.all([a,b].map(c => w.svc.reservarOuReutilizar(c)));
    expect(rs.map(r => r.numero)).toEqual([1,1]);
  });
  it("rollback após incremento remove também a reserva e a sequência nova", async () => {
    const w = mundo(); const c = w.ctx("a"); w.repo.state.falharGravacao = true;
    await expect(w.svc.reservarOuReutilizar(c)).rejects.toThrow("23505");
    expect(w.repo.state.reservas.size).toBe(0); expect(w.repo.state.sequences.size).toBe(0);
    w.repo.state.falharGravacao = false;
    expect((await w.svc.reservarOuReutilizar(c)).numero).toBe(1);
  });
  it("reusa por nfeId após edição DRAFT e não troca cNF", async () => {
    const w = mundo(); const c = w.ctx("a"); const r = await w.svc.reservarOuReutilizar(c);
    c.row.numero = r.numero; c.row.status = "DRAFT";
    const retry = await w.svc.reservarOuReutilizar(c);
    expect(retry).toMatchObject({ id: r.id, cNF: r.cNF, numero: 1, origemDecisao: "REUSO" });
    expect((await w.svc.reservarOuReutilizar(w.ctx("b"))).numero).toBe(2);
  });
  it("produção exige confirmação ao trocar série; rollback preserva a reserva", async () => {
    const w = mundo(); const c = w.ctx("a"); c.key.ambiente = "PRODUCAO";
    const r = await w.svc.reservarOuReutilizar(c); c.row.numero = r.numero; c.key.serie = 2;
    await expect(w.svc.reservarOuReutilizar(c)).rejects.toMatchObject({ code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409 });
    expect(w.repo.state.reservas.get(r.id)?.estado).toBe("RESERVADO");
    await w.svc.reservarOuReutilizar({ ...c, confirmarDescarte: true });
    expect(w.repo.state.reservas.get(r.id)).toMatchObject({ estado: "ABANDONADO", requerInutilizacao: true });
  });
  it("adota legado apenas com trilha e nunca da Focus", async () => {
    for (const providerName of ["SEFAZ_DIRECT", "FOCUS_NFE"] as const) {
      const w = mundo(); const c = w.ctx("a", { providerName }); c.row.numero = 5;
      await w.svc.avancarContadorAtomico(c.userId, c.key, false, 8);
      w.repo.state.trilhas.set("a", [{evento:"NUMERADA",detalhes:{numero:5,serie:1}}, {evento:"EDITADA_DRAFT",detalhes:{motivo:"Erro antes do envio: certificado"}}]);
      const r = await w.svc.reservarOuReutilizar(c);
      expect(r.numero).toBe(providerName === "SEFAZ_DIRECT" ? 5 : 8);
    }
  });
  it("contador só avança mesmo em chamadas concorrentes", async () => {
    const w = mundo(); const c = w.ctx("a");
    await Promise.all([20,8,35,1,10].map(n => w.svc.avancarContadorAtomico(c.userId,c.key,false,n)));
    expect([...w.repo.state.sequences.values()][0].proximoNumero).toBe(35);
  });
  it("pula números ocupados e abandonados sem pool", async () => {
    const w = mundo(); const c = w.ctx("a"); const r = await w.svc.reservarOuReutilizar(c);
    w.repo.state.notas.get("a")!.status = "DRAFT";
    await w.svc.abandonarPorExclusao("tenant", "a");
    expect(w.repo.state.reservas.get(r.id)?.estado).toBe("ABANDONADO");
    w.repo.state.inutilizadas.push({key:c.key,ini:2,fim:3});
    expect((await w.svc.reservarOuReutilizar(w.ctx("b"))).numero).toBe(4);
  });
  it("apenas uma transmissão vence e a tentativa existe antes de SENDING", async () => {
    const w = mundo(); const r = await w.svc.reservarOuReutilizar(w.ctx("a"));
    const results = await Promise.allSettled([w.start(r),w.start(r)]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(w.repo.state.tentativas.size).toBe(1);
    expect(w.repo.state.notas.get("a")?.status).toBe("SENDING");
  });
  it("rejeição 974 preserva o número no retry após edição", async () => {
    const w = mundo(); const c = w.ctx("a"); const r = await w.svc.reservarOuReutilizar(c); const started = await w.start(r);
    await w.svc.registrarResposta(started.reserva, started.tentativa, { classificacao: classificarCStatSefaz(974) });
    expect(w.repo.state.notas.get("a")).toMatchObject({status:"REJECTED",cStatRejeicao:974});
    w.repo.state.notas.get("a")!.status = "VALIDATING"; c.row.numero = 1;
    expect((await w.svc.reservarOuReutilizar(c)).numero).toBe(1);
  });
  it("takeover impede resposta tardia e um segundo dono de lease", async () => {
    const w = mundo(); const r = await w.svc.reservarOuReutilizar(w.ctx("a")); const started = await w.start(r);
    expect(await w.svc.tomarLease("tenant", r.id, 180000)).toBeNull(); w.advance(600001);
    const owner = await w.svc.tomarLease("tenant",r.id,180000); expect(owner).not.toBeNull();
    expect(await w.svc.tomarLease("tenant",r.id,180000)).toBeNull();
    await expect(w.svc.registrarResposta(started.reserva,started.tentativa,{classificacao:classificarCStatSefaz(974)})).rejects.toMatchObject({code:"NUMERACAO_CONCORRENCIA"});
    expect(w.repo.state.notas.get("a")?.status).toBe("SENDING");
  });
  it("INCERTO não permite descarte nem reenvio", async () => {
    const w = mundo(); const c = w.ctx("a"); const r = await w.svc.reservarOuReutilizar(c); const s = await w.start(r);
    await w.svc.devolverIncerto(s.reserva);
    await expect(w.svc.abandonarPorExclusao("tenant","a",true)).rejects.toMatchObject({code:"NFE_NUMERO_PENDENTE_CONSULTA"});
    await expect(w.svc.reservarOuReutilizar(c)).rejects.toMatchObject({code:"NUMERACAO_CONCORRENCIA"});
  });
  it("não consta só libera após prova madura de todas as tentativas", async () => {
    const w = mundo(); const r = await w.svc.reservarOuReutilizar(w.ctx("a")); const s = await w.start(r);
    const incerto = await w.svc.devolverIncerto(s.reserva);
    await expect(w.svc.naoConstaConfirmado(incerto)).rejects.toMatchObject({code:"NUMERACAO_CONCORRENCIA"});
    w.advance(600001);
    const owner = (await w.svc.tomarLease("tenant",r.id,180000))!;
    const cls = classificarConsultaSefaz({ transporte:null,httpStatus:200,cStat:217,xMotivo:"Não consta",nProt:null,dhRecbto:null,digVal:null,chNFe:null,protNFeXml:null }, { madura:true, chavesNossas:[], digestsNossos:[] });
    const token = await w.svc.registrarConsulta(owner,s.tentativa,{classificacao:cls});
    expect((await w.svc.naoConstaConfirmado(token)).estado).toBe("RESERVADO");
    expect(w.repo.state.notas.get("a")?.status).toBe("REJECTED");
  });
  it("autorização e cancelamento nunca liberam o número", async () => {
    const w = mundo(); const r = await w.svc.reservarOuReutilizar(w.ctx("a")); const s = await w.start(r);
    await w.svc.registrarResposta(s.reserva,s.tentativa,{classificacao:classificarCStatSefaz(100,{nProt:"p"}),protocolo:"p",chaveAcesso:"1".repeat(44)});
    await w.svc.marcarCancelado("tenant","a");
    await expect(w.svc.abandonarPorExclusao("tenant","a",true)).rejects.toMatchObject({code:"DOCUMENTO_FISCAL_REGISTRADO"});
    expect((await w.svc.reservarOuReutilizar(w.ctx("b"))).numero).toBe(2);
  });
  it("inutilização bloqueia documento vivo e consome abandonado", async () => {
    const w = mundo(); const c = w.ctx("a"); const r = await w.svc.reservarOuReutilizar(c);
    await expect(w.svc.inutilizacaoGuard("tenant",c.key,false,1,1,async () => true)).rejects.toMatchObject({code:"FAIXA_COM_NUMERO_VIVO"});
    w.repo.state.notas.get("a")!.status = "DRAFT"; await w.svc.abandonarPorExclusao("tenant","a");
    expect(await w.svc.inutilizacaoGuard("tenant",c.key,false,1,1,async () => true)).toBe(true);
    await w.svc.inutilizacaoPos("tenant",c.key,false,1,1);
    expect(w.repo.state.reservas.get(r.id)?.estado).toBe("INUTILIZADO");
  });
  it("nega escrita cross-tenant", async () => {
    const w = mundo(); const r = await w.svc.reservarOuReutilizar(w.ctx("a"));
    expect(await w.svc.reservaViva("outro","a")).toBeNull();
    await expect(w.start({...r,userId:"outro"})).rejects.toMatchObject({code:"NUMERACAO_CONCORRENCIA"});
  });
});

