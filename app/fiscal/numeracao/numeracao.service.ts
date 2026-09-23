import { randomInt } from "node:crypto";
import { avaliarFaixa, decidirAdocaoLegado, mensagemBloqueiosFaixa, motivoTrocaChave } from "./decisao";
import type { ChaveFiscal } from "./decisao";
import { concorrencia, NumeracaoError } from "./numeracao.errors";
import { NfeNumeracaoRepository } from "./numeracao.repository";
import { chaveDaReserva, chaveOrdenavel } from "./persistencia";
import type { ContextoReserva, INfeNumeracaoRepository, NovaTentativa, NumeracaoTx, Reserva, ReservaPatch, Tentativa, TentativaPatch } from "./persistencia";
import { ESTADOS_CONSUMIDOS, ESTADOS_REUSAVEIS, ESTADOS_VIVOS } from "./tipos";
import type { Classificacao, EstadoReserva } from "./tipos";
import { naoConstaMinMs } from "../flags";

export type ReservaDecidida = Reserva & { origemDecisao: "REUSO" | "ADOCAO_LEGADO" | "CONTADOR" };
export interface ResultadoFiscal {
  classificacao: Classificacao;
  protocolo?: string | null;
  chaveAcesso?: string | null;
  dataAutorizacao?: Date;
  httpStatus?: number | null;
  transporte?: string | null;
  nRec?: string | null;
}
const reusavel = (r: Reserva) => ESTADOS_REUSAVEIS.includes(r.estado);
const viva = (rs: Reserva[]) => rs.find(r => ESTADOS_VIVOS.includes(r.estado)) ?? null;
const aberta = (r: Reserva) => r.estado === "EM_TRANSMISSAO" || r.estado === "INCERTO";

export class NfeNumeracaoService {
  constructor(
    readonly repo: INfeNumeracaoRepository = new NfeNumeracaoRepository(),
    private readonly agora: () => Date = () => new Date(),
    private readonly cnf: () => string = () => String(randomInt(0, 100_000_000)).padStart(8, "0"),
  ) {}

  async reservaViva(userId: string, nfeId: string): Promise<Reserva | null> { return viva(await this.repo.reservas(userId, nfeId)); }
  tentativas(userId: string, reservaId: string): Promise<Tentativa[]> { return this.repo.tentativas(userId, reservaId); }
  async tentativasAbertas(userId: string, reservaId: string): Promise<Tentativa[]> {
    return (await this.tentativas(userId, reservaId)).filter(t => t.fase !== "FECHADA");
  }

  async reservarOuReutilizar(c: ContextoReserva, validarNaTransacao?: (tx: NumeracaoTx) => Promise<void>): Promise<ReservaDecidida> {
    this.validarChave(c.userId, c.key);
    const antes = await this.reservaViva(c.userId, c.nfeId);
    const trilha = !antes && c.row.numero > 0 ? await this.repo.trilha(c.userId, c.nfeId) : [];
    return this.repo.transaction(async tx => {
      // All participating sequences are locked in a stable order, before ledger and invoice rows.
      const keys = new Map([ [chaveOrdenavel(c.key), c.key] ]);
      if (antes) keys.set(chaveOrdenavel(chaveDaReserva(antes)), chaveDaReserva(antes));
      const sequencias = new Map<string, {id: string; proximoNumero: number}>();
      for (const [id, k] of [...keys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        sequencias.set(id, await tx.lockSequencia(c.userId, k, id === chaveOrdenavel(c.key) && c.isDefault));
      }
      const r = viva(await tx.reservas(c.userId, c.nfeId, true));
      if ((antes?.id ?? null) !== (r?.id ?? null) || (r && !reusavel(r))) concorrencia();
      if (validarNaTransacao) await validarNaTransacao(tx);
      if (r && !motivoTrocaChave(r, c.key) && c.row.numero === r.numero) {
        await tx.gravarNumero(c, r.numero);
        return { ...await tx.atualizarReserva(r,{}), origemDecisao: "REUSO" };
      }
      if (r) {
        const motivo = motivoTrocaChave(r, c.key) ?? "FLAG_ROLLBACK_V1";
        if (motivo !== "FLAG_ROLLBACK_V1") this.confirmarDescarte(r, c.confirmarDescarte === true, motivo);
        await tx.transicionar(r, "ABANDONADO", { motivo, requerInutilizacao: r.ambiente === "PRODUCAO" });
        if(tx.sql)await tx.sql.$executeRawUnsafe(`INSERT INTO "NfeAuditLog" ("id","nfeId","userId","evento","detalhes") VALUES (gen_random_uuid()::text,$1,$2,'NUMERACAO_DESCARTADA',$3::jsonb)`,c.nfeId,c.userId,JSON.stringify({actorUserId:c.actorUserId??c.userId,numero:r.numero,serie:r.serie,motivo,confirmado:c.confirmarDescarte===true}));
      }
      const seq = sequencias.get(chaveOrdenavel(c.key))!;
      const linhaNaChave = c.row.companyFiscalConfigId === c.key.cfc || (c.isDefault && c.row.companyFiscalConfigId === null);
      if (!r && c.row.numero > 0 && linhaNaChave && c.row.serie === c.key.serie && c.row.ambiente === c.key.ambiente && (c.row.modelo ?? "55") === c.key.modelo) {
        const decisao = decidirAdocaoLegado({ row: { ...c.row, cStatRejeicao: c.row.cStatRejeicao }, providerName: c.providerName, trilha,
          proximoNumero: seq.proximoNumero, ocupacao: await tx.ocupacao(c, c.row.numero) });
        if (decisao.adotar) {
          // Adota a linha legada (contador ainda com companyFiscalConfigId NULL) na MESMA transação,
          // como o V1 faz: sem isso um lockSequencia posterior sem isDefault criaria uma sequência-sombra em 1.
          await tx.avancarContador(seq.id, c.key.cfc, seq.proximoNumero);
          const adotada = await tx.inserirReserva(this.novaReserva(c, c.row.numero, decisao.estado, "LEGADO_V1"));
          await tx.gravarNumero(c, adotada.numero);
          return { ...adotada, origemDecisao: "ADOCAO_LEGADO" };
        }
      }
      const anteriores = await tx.reservasNaChave(c.userId, c.key);
      if (!anteriores.length) seq.proximoNumero = await tx.avancarContador(seq.id, c.key.cfc, (await tx.pisoPorEvidencia(c)) + 1);
      const bloqueantes = anteriores.slice(0, 3);
      if (bloqueantes.length === 3 && bloqueantes.every(x => x.estado === "CONSUMIDO_EXTERNO")) {
        // O guard é legítimo (não martelar a SEFAZ com número que ela já tem), mas lança ANTES
        // de `inserirReserva`: nenhuma reserva mais nova nasce, estas 3 seguem sendo as mais
        // recentes (`reservasNaChave` ordena por createdAt DESC) e sem saída ele trancaria a
        // série INTEIRA, de todo operador, para sempre. A saída é o contador — o que a própria
        // mensagem manda ajustar.
        //
        // Critério: o guard só vale enquanto o contador ainda aponta para DENTRO da faixa já
        // queimada. Logo após reservar o maior desses números o contador vale exatamente
        // `maior + 1` (a alocação faz `avancarContador(numero + 1)`), e nada mais escreve na
        // sequência enquanto o guard está armado. Então `proximoNumero >= maior + 2` é a prova
        // de estado de que alguém o moveu de propósito (avancarContadorAtomico, inutilizacaoPos
        // ou a importação dos XMLs já emitidos). `NfeSequence.updatedAt` NÃO serve: o
        // `avancarContador` carimba NOW() mesmo quando o GREATEST não muda o número, então
        // reajustar para o valor atual — que não corrige nada — destravaria.
        const maior = Math.max(...bloqueantes.map(x => x.numero));
        const minimo = maior + 2;
        if (seq.proximoNumero < minimo) {
          const numeros = bloqueantes.map(x => x.numero).sort((a, b) => a - b);
          throw new NumeracaoError("SEQUENCIA_ATRAS_DA_SEFAZ", 409,
            `Os nºs ${numeros.join(", ")} da série ${c.key.serie} já existiam na SEFAZ com outra chave: o contador do Dexo está atrás da numeração real deste CNPJ, e nenhuma NF-e desta série sai enquanto ele não for corrigido. Para destravar, nesta ordem: 1) veja no portal da SEFAZ qual foi o último nº já usado por este CNPJ nesta série; 2) ponha o próximo número da série em ${minimo} ou mais (o maior entre esse valor e o último da SEFAZ + 1). Excluir o rascunho, tentar por outro usuário ou reenviar a mesma nota não destrava.`,
            { numeros, serie: c.key.serie, ambiente: c.key.ambiente, modelo: c.key.modelo,
              proximoNumeroAtual: seq.proximoNumero, proximoNumeroMinimo: minimo });
        }
      }
      for (let i = 0; i < 50; i++) {
        const numero = seq.proximoNumero;
        if (numero > 999999999) throw new NumeracaoError("NUMERACAO_ESGOTADA", 409, "Numeração desta série esgotada");
        seq.proximoNumero = await tx.avancarContador(seq.id, c.key.cfc, numero + 1);
        const ocupacao = await tx.ocupacao(c, numero);
        if (ocupacao.emNota || ocupacao.inutilizado || ocupacao.reservado) continue;
        const nova = await tx.inserirReserva(this.novaReserva(c, numero, "RESERVADO", "CONTADOR"));
        await tx.gravarNumero(c, numero);
        return { ...nova, origemDecisao: "CONTADOR" };
      }
      throw new NumeracaoError("COLISOES_EXCESSIVAS", 409, "50 números seguidos já usados — revise a numeração");
    });
  }

  private novaReserva(c: ContextoReserva, numero: number, estado: EstadoReserva, origem: Reserva["origem"]) {
    return { userId: c.userId, companyFiscalConfigId: c.key.cfc, ambiente: c.key.ambiente, modelo: c.key.modelo, serie: c.key.serie,
      numero, nfeId: c.nfeId, estado, origem, cNF: this.cnf(), ultimoCStat: origem === "LEGADO_V1" ? c.row.cStatRejeicao : null };
  }

  async iniciarTransmissao(r: Reserva, dados: Omit<NovaTentativa, "reservaId" | "nfeId" | "userId" | "seq" | "ambiente" | "cNF" | "transmitidaEm">, leaseMs: number): Promise<{reserva: Reserva; tentativa: Tentativa}> {
    if (!r.nfeId || !Number.isFinite(leaseMs) || leaseMs <= 0 || !/^[a-f0-9]{64}$/.test(dados.conteudoSha256)) {
      throw new NumeracaoError("TENTATIVA_INVALIDA", 422, "Dados da tentativa de emissão inválidos");
    }
    if (dados.provedor === "SEFAZ_DIRECT" && (!/^\d{44}$/.test(dados.chaveAcesso ?? "") || !dados.digestValue || !dados.xmlAssinadoPath || !dados.dhEmi)) {
      throw new NumeracaoError("TENTATIVA_SEM_XML", 422, "A tentativa precisa do XML assinado persistido antes do envio");
    }
    if (dados.provedor === "FOCUS_NFE" && !dados.focusRef) throw new NumeracaoError("TENTATIVA_SEM_REF", 422, "Referência da emissão ausente");
    return this.repo.transaction(async tx => {
      const atual = await this.guardar(tx, r);
      if (!reusavel(atual)) concorrencia();
      const ts = await tx.tentativas(r.userId, r.id, true);
      if (ts.some(t => t.fase !== "FECHADA")) concorrencia();
      const agora = this.agora();
      const reserva = await tx.transicionar(atual, "EM_TRANSMISSAO", { leaseAte: new Date(agora.getTime() + leaseMs), provedorUltimo: dados.provedor });
      const tentativa = await tx.inserirTentativa({ ...dados, reservaId: r.id, nfeId: r.nfeId!, userId: r.userId, seq: (ts[0]?.seq ?? 0) + 1,
        ambiente: r.ambiente, cNF: r.cNF, transmitidaEm: agora });
      await tx.atualizarNota(r.userId, r.nfeId!, ["VALIDATING", "SIGNING"], { status: "SENDING", chaveAcesso: dados.chaveAcesso, dataEmissao: dados.dhEmi ?? undefined });
      return { reserva, tentativa };
    });
  }

  /** Snapshot returned here is a fencing token. A previous sender cannot commit after takeover. */
  async tomarLease(userId: string, reservaId: string, ms: number): Promise<Reserva | null> {
    if (!Number.isFinite(ms) || ms <= 0) throw new NumeracaoError("LEASE_INVALIDO", 422, "Duração de consulta inválida");
    return this.repo.transaction(async tx => {
      const r = await tx.reserva(userId, reservaId, true);
      const agora = this.agora();
      if (!r || !aberta(r) || (r.leaseAte && r.leaseAte >= agora) || (r.bloqueadoAte && r.bloqueadoAte>=agora)) return null;
      return tx.atualizarReserva(r, { leaseAte: new Date(agora.getTime() + ms) });
    });
  }

  /** Conclusive send result, applied atomically to ledger, attempt and invoice. */
  registrarResposta(r: Reserva, tentativa: Tentativa, resultado: ResultadoFiscal): Promise<Reserva> {
    return this.aplicarResultado(r, tentativa, resultado, false);
  }
  private aplicarResultado(r: Reserva, tentativa: Tentativa, resultado: ResultadoFiscal, consulta: boolean): Promise<Reserva> {
    return this.repo.transaction(async tx => {
      const atual = await this.guardar(tx, r);
      if (!aberta(atual) || (!consulta && atual.estado !== "EM_TRANSMISSAO")) concorrencia();
      const ts = await tx.tentativas(r.userId, r.id, true);
      const t = ts.find(x => x.id === tentativa.id);
      if (!t || t.fase === "FECHADA" || (!consulta && ts[0]?.id !== t.id)) concorrencia();
      const cls = resultado.classificacao;
      const alvo = cls.estadoAlvo ?? "INCERTO";
      // Focus: "autorizado" + chave de 44 dígitos é a prova (o 201 e a consulta simples vêm sem protocolo).
      if (alvo === "AUTORIZADO" && (!/^\d{44}$/.test(resultado.chaveAcesso ?? "") || (!resultado.protocolo && t.provedor !== "FOCUS_NFE"))) {
        throw new NumeracaoError("AUTORIZACAO_SEM_PROVA", 409, "Autorização sem chave ou protocolo — consulte a situação");
      }
      if ((alvo === "REJEITADO" || alvo === "RESERVADO") && ts.some(x => x.id !== t.id && x.fase !== "FECHADA")) concorrencia();
      const agora = this.agora();
      const reserva = await tx.transicionar(atual, alvo, { ultimaClasse: cls.classe, ultimoCStat: cls.cStat,
        ultimoCodigoProvedor: cls.codigoProvedor?.slice(0, 64) ?? null, motivo: cls.mensagem.slice(0, 500), leaseAte: null,
        bloqueadoAte: cls.retryAposMs ? new Date(agora.getTime() + cls.retryAposMs) : null,
        consumidoEm: ESTADOS_CONSUMIDOS.includes(alvo) ? agora : atual.consumidoEm });
      await tx.atualizarTentativa(t, { ...this.patchResposta(resultado), fase: alvo === "INCERTO" || alvo === "BLOQUEADO" ? "RESPONDIDA" : "FECHADA",
        prova: cls.conclusiva || alvo === "AUTORIZADO" ? "RESPOSTA_CONCLUSIVA" : null,
        respondidaEm: consulta ? t.respondidaEm : agora, consultadaEm: consulta ? agora : t.consultadaEm });
      if (alvo === "AUTORIZADO") {
        // Nota autorizada não carrega o cStat de uma tentativa rejeitada anterior: o claim da reemissão só limpa `motivoRejeicao`.
        await tx.atualizarNota(r.userId, t.nfeId, ["SENDING"], { status: "AUTHORIZED", chaveAcesso: resultado.chaveAcesso, cStatRejeicao: null,
          protocoloAutorizacao: resultado.protocolo ?? null, dataAutorizacao: resultado.dataAutorizacao ?? agora, xmlAssinadoPath: t.xmlAssinadoPath });
      } else if (alvo === "BLOQUEADO") {
        // A RESERVA fica retida para conferência manual (BLOQUEADO), mas a NOTA não pode ficar em
        // SENDING: ali ela some do wizard (findDraftById só enxerga DRAFT/REJECTED), `consultar` não
        // a alcança (BLOQUEADO não é estado consultável) e `emitir` responde 409 NUMERACAO_BLOQUEADA
        // — beco sem saída destravável só por SQL em produção. O caso real é o cStat 613 ("Chave de
        // Acesso difere da existente em BD"), que nunca traz chave de 44 dígitos na mensagem: o ramo
        // BLOQUEADO do orquestrador é determinístico para ele.
        // O cStat REAL da duplicidade é preservado — nada de inventar código que a SEFAZ não devolveu.
        await tx.atualizarNota(r.userId, t.nfeId, ["SENDING"], { status: "REJECTED", cStatRejeicao: cls.cStat,
          motivoRejeicao: `Nº ${atual.numero} retido para conferência: ${cls.mensagem}`.slice(0, 500) });
      } else if (alvo !== "INCERTO") {
        await tx.atualizarNota(r.userId, t.nfeId, ["SENDING"], { status: "REJECTED", motivoRejeicao: cls.mensagem, cStatRejeicao: cls.cStat });
      }
      return reserva;
    });
  }

  /** Records a consultation; an absence closes ONLY this mature attempt. */
  async registrarConsulta(r: Reserva, tentativa: Tentativa, resultado: ResultadoFiscal): Promise<Reserva> {
    const cls = resultado.classificacao;
    // Focus 55 (e SEFAZ em modo recibo) é assíncrona: a rejeição da tentativa chega pela consulta.
    // Resultado conclusivo com alvo REJEITADO/RESERVADO (rejeição, 108/109, 656, erro do provedor)
    // é aplicado como resposta da tentativa, com motivo e cStat reais. "Não consta" segue abaixo.
    const conclusivoDaTentativa = cls.conclusiva && cls.classe !== "NAO_CONSTA" && (cls.estadoAlvo === "REJEITADO" || cls.estadoAlvo === "RESERVADO");
    if (cls.estadoAlvo && (conclusivoDaTentativa || ["AUTORIZADO", "DENEGADO", "INUTILIZADO", "CONSUMIDO_EXTERNO", "BLOQUEADO"].includes(cls.estadoAlvo))) {
      return this.aplicarResultado(r, tentativa, resultado, true);
    }
    return this.repo.transaction(async tx => {
      const atual = await this.guardar(tx, r);
      if (!aberta(atual)) concorrencia();
      const t = (await tx.tentativas(r.userId, r.id, true)).find(x => x.id === tentativa.id);
      if (!t || t.fase === "FECHADA") concorrencia();
      const agora = this.agora();
      const madura = agora.getTime() - t.transmitidaEm.getTime() >= naoConstaMinMs();
      const fecha = cls.conclusiva && ((cls.classe === "NAO_CONSTA" && madura) || cls.classe === "REJEICAO" || cls.classe === "PRE_ENVIO_PROVEDOR");
      await tx.atualizarTentativa(t, { ...this.patchResposta(resultado), consultadaEm: agora, fase: fecha ? "FECHADA" : "RESPONDIDA",
        prova: fecha ? (cls.classe === "NAO_CONSTA" ? "NAO_CONSTA_MADURO" : "RESPOSTA_CONCLUSIVA") : null });
      return tx.atualizarReserva(atual, cls.retryAposMs?{bloqueadoAte:new Date(agora.getTime()+cls.retryAposMs)}:{});
    });
  }

  async naoConstaConfirmado(r: Reserva): Promise<Reserva> {
    return this.repo.transaction(async tx => {
      const atual = await this.guardar(tx, r);
      const ts = await tx.tentativas(r.userId, r.id, true);
      if (!aberta(atual) || !ts.length || ts.some(t => t.fase !== "FECHADA" || !["NAO_CONSTA_MADURO", "RESPOSTA_CONCLUSIVA"].includes(t.prova ?? "") || t.protocolo)) concorrencia();
      const mensagem = `Envio não registrado na SEFAZ — nº ${r.numero} mantido`;
      const reserva = await tx.transicionar(atual, "RESERVADO", { leaseAte: null, motivo: mensagem });
      await tx.atualizarNota(r.userId, r.nfeId!, ["SENDING"], { status: "REJECTED", motivoRejeicao: mensagem });
      return reserva;
    });
  }
  devolverIncerto(r: Reserva): Promise<Reserva> {
    return this.repo.transaction(async tx => {
      const atual = await this.guardar(tx, r);
      if (!aberta(atual)) concorrencia();
      return tx.transicionar(atual, "INCERTO", { leaseAte: null });
    });
  }

  async marcarCancelado(userId: string, nfeId: string): Promise<void> {
    await this.repo.transaction(async tx => {
      const r = viva(await tx.reservas(userId, nfeId, true));
      if (!r || r.estado === "CANCELADO") return;
      if (r.estado !== "AUTORIZADO") concorrencia();
      await tx.transicionar(r, "CANCELADO");
    });
  }
  /** Authorization and Focus's actual fiscal identity are committed together. */
  async registrarReadbackFocus(r:Reserva,t:Tentativa,result:ResultadoFiscal,real:{numero:number;serie:number},isDefault:boolean):Promise<Reserva> {
    if(!result.chaveAcesso)throw new NumeracaoError("AUTORIZACAO_SEM_PROVA",409,"Autorização sem prova");
    return this.repo.transaction(async tx=>{
      const key={...chaveDaReserva(r),serie:real.serie};
      const keys=[chaveDaReserva(r),key].filter((k,i,all)=>all.findIndex(x=>chaveOrdenavel(x)===chaveOrdenavel(k))===i).sort((a,b)=>chaveOrdenavel(a).localeCompare(chaveOrdenavel(b)));
      let seq:{id:string;proximoNumero:number}|undefined;
      for(const k of keys){const s=await tx.lockSequencia(r.userId,k,isDefault);if(k.serie===real.serie)seq=s;}
      const atual=await this.guardar(tx,r);
      if(!aberta(atual))concorrencia();
      const existentes=await tx.reservasNaChave(r.userId,key,true);
      const ocupada=existentes.find(x=>x.numero===real.numero);
      const tentativa=(await tx.tentativas(r.userId,r.id,true)).find(x=>x.id===t.id);
      if(!tentativa || tentativa.fase==="FECHADA")concorrencia();
      let autorizada=await tx.transicionar(atual,"AUTORIZADO",{consumidoEm:this.agora(),leaseAte:null,ultimaClasse:"AUTORIZADA"});
      await tx.atualizarTentativa(tentativa,{...this.patchResposta(result),fase:"FECHADA",prova:"RESPOSTA_CONCLUSIVA",numeroLido:real.numero,serieLida:real.serie,respondidaEm:this.agora()});
      await tx.transicionar(autorizada,"ABANDONADO",{motivo:"FOCUS_NUMERO_DIVERGENTE",requerInutilizacao:r.ambiente==="PRODUCAO"});
      if(ocupada) {
        if(reusavel(ocupada))await tx.transicionar(ocupada,"CONSUMIDO_EXTERNO",{motivo:"NUMERO_USADO_VIA_FOCUS",consumidoEm:this.agora()});
        // Existing ledger identity cannot be reassigned to this document.
        autorizada={...autorizada,numero:real.numero,serie:real.serie};
      } else {
        autorizada=await tx.inserirReserva({userId:r.userId,companyFiscalConfigId:r.companyFiscalConfigId,ambiente:r.ambiente,modelo:r.modelo,serie:real.serie,numero:real.numero,nfeId:r.nfeId,estado:"AUTORIZADO",origem:"READBACK_FOCUS",cNF:result.chaveAcesso!.slice(35,43)});
      }
      await tx.avancarContador(seq!.id,key.cfc,real.numero+1);
      // cStatRejeicao: mesmo motivo do ramo AUTORIZADO de aplicarResultado — o claim da reemissao
      // limpa so o motivo e deixa o cStat da tentativa rejeitada vivo numa nota que autorizou.
      await tx.atualizarNota(r.userId,t.nfeId,["SENDING"],{status:"AUTHORIZED",chaveAcesso:result.chaveAcesso,protocoloAutorizacao:result.protocolo??null,dataAutorizacao:result.dataAutorizacao??this.agora(),cStatRejeicao:null});
      if(tx.sql) {
        await tx.sql.$executeRawUnsafe('SAVEPOINT focus_numero');
        try{await tx.atualizarNota(r.userId,t.nfeId,["AUTHORIZED"],{status:"AUTHORIZED",numero:real.numero,serie:real.serie});}
        catch(error){await tx.sql.$executeRawUnsafe('ROLLBACK TO SAVEPOINT focus_numero');const e=error as {code?:string;meta?:{code?:string}};if(e.code!=="P2002" && e.meta?.code!=="23505")throw error;}
        await tx.sql.$executeRawUnsafe('RELEASE SAVEPOINT focus_numero');
      } else await tx.atualizarNota(r.userId,t.nfeId,["AUTHORIZED"],{status:"AUTHORIZED",numero:real.numero,serie:real.serie});
      return autorizada;
    });
  }
  async abandonarPorExclusao(userId: string, nfeId: string, confirmar = false): Promise<void> {
    const antes = await this.reservaViva(userId, nfeId);
    await this.repo.transaction(async tx => {
      if (antes) await tx.lockSequencia(userId, chaveDaReserva(antes), false);
      const reservas = await tx.reservas(userId, nfeId, true);
      if (reservas.some(r => ["AUTORIZADO", "CANCELADO", "DENEGADO"].includes(r.estado))) throw new NumeracaoError("DOCUMENTO_FISCAL_REGISTRADO", 409, "Documento fiscal já registrado");
      const r = viva(reservas);
      if ((antes?.id ?? null) !== (r?.id ?? null)) concorrencia();
      if (r) {
        // BLOQUEADO é a anomalia pós-consulta (613 sem chave referida legível): a SEFAZ já respondeu,
        // então consultar de novo não move nada — o que falta é conferência humana. Esta é a saída, e
        // `confirmarDescarte` a mantém explícita (em QUALQUER ambiente, não só em produção).
        if (!reusavel(r) && r.estado !== "BLOQUEADO") throw new NumeracaoError("NFE_NUMERO_PENDENTE_CONSULTA", 409, "Consulte a situação antes de excluir o rascunho");
        this.confirmarDescarte(r, confirmar, "RASCUNHO_EXCLUIDO");
        await tx.transicionar(r, "ABANDONADO", { motivo: "RASCUNHO_EXCLUIDO", requerInutilizacao: r.ambiente === "PRODUCAO" });
      }
      await tx.excluirRascunho(userId, nfeId);
    });
  }

  /** Callback must insert PENDENTE in this transaction, closing the guard/send race. */
  async inutilizacaoGuard<T>(userId: string, key: ChaveFiscal, isDefault: boolean, ini: number, fim: number, registrarPendente: (tx: NumeracaoTx) => Promise<T>): Promise<T> {
    this.validarChave(userId, key);
    return this.repo.transaction(async tx => {
      await tx.lockSequencia(userId, key, isDefault);
      const reservas = await tx.reservasNaChave(userId, key, true);
      const linhas = await tx.linhasNaFaixa(userId, key, isDefault, ini, fim);
      const avaliacao = avaliarFaixa({ linhas, reservas, ini, fim });
      if (!avaliacao.ok) throw new NumeracaoError("FAIXA_COM_NUMERO_VIVO", 400, mensagemBloqueiosFaixa(avaliacao.bloqueios));
      return registrarPendente(tx);
    });
  }
  async inutilizacaoPos(userId: string, key: ChaveFiscal, isDefault: boolean, ini: number, fim: number): Promise<void> {
    this.validarChave(userId, key);
    if (!Number.isInteger(ini) || ini < 1 || !Number.isInteger(fim) || fim < ini || fim > 999999999) throw new NumeracaoError("FAIXA_INVALIDA", 422, "Faixa inválida");
    await this.repo.transaction(async tx => {
      const seq = await tx.lockSequencia(userId, key, isDefault);
      for (const r of await tx.reservasNaChave(userId, key, true)) {
        if (r.numero >= ini && r.numero <= fim && r.estado === "ABANDONADO") await tx.transicionar(r, "INUTILIZADO", { consumidoEm: this.agora(), requerInutilizacao: false });
      }
      await tx.avancarContador(seq.id, key.cfc, fim + 1);
    });
  }
  async avancarContadorAtomico(userId: string, key: ChaveFiscal, isDefault: boolean, proximo: number): Promise<number> {
    this.validarChave(userId, key);
    if (!Number.isInteger(proximo) || proximo < 1 || proximo > 1000000000) throw new NumeracaoError("CONTADOR_INVALIDO", 422, "Próximo número inválido");
    return this.repo.transaction(async tx => {
      const seq = await tx.lockSequencia(userId, key, isDefault);
      return tx.avancarContador(seq.id, key.cfc, proximo);
    });
  }
  async focusRefPara(userId: string, nfeId: string, reserva: Reserva): Promise<string> {
    for (const r of await this.repo.reservas(userId, nfeId)) {
      const ts = await this.repo.tentativas(userId, r.id);
      if (r.id === reserva.id && ts.some(t => t.focusRef)) return ts.find(t => t.focusRef)!.focusRef!;
    }
    for (const r of await this.repo.reservas(userId, nfeId)) {
      if ((await this.repo.tentativas(userId, r.id)).some(t => t.focusRef === nfeId)) return `${nfeId}n${reserva.numero}`;
    }
    return nfeId;
  }
  async focusRefAutorizada(userId: string, nfeId: string): Promise<string | null> {
    for (const r of await this.repo.reservas(userId, nfeId)) {
      const t = (await this.repo.tentativas(userId, r.id)).find(x => x.fase === "FECHADA" && x.classe === "AUTORIZADA" && x.focusRef);
      if (t) return t.focusRef;
    }
    return null;
  }

  private async guardar(tx: NumeracaoTx, r: Reserva): Promise<Reserva> {
    const atual = await tx.reserva(r.userId, r.id, true);
    if (!atual || atual.estado !== r.estado || atual.updatedAt.getTime() !== r.updatedAt.getTime()) concorrencia();
    return atual;
  }
  private patchResposta(r: ResultadoFiscal): TentativaPatch {
    return { classe: r.classificacao.classe, cStat: r.classificacao.cStat, codigoProvedor: r.classificacao.codigoProvedor?.slice(0, 64) ?? null,
      mensagem: `${r.classificacao.mensagem.slice(0, 400)}${r.classificacao.chaveReferida?` [chNFe:${r.classificacao.chaveReferida}]`:""}`, httpStatus: r.httpStatus, transporte: r.transporte, nRec: r.nRec, protocolo: r.protocolo };
  }
  private confirmarDescarte(r: Reserva, confirmou: boolean, motivo: string): void {
    // Número BLOQUEADO pode estar autorizado na SEFAZ com outro cNF: o descarte exige confirmação
    // explícita em QUALQUER ambiente, não só em produção — é o que impede a saída automática.
    const bloqueada = r.estado === "BLOQUEADO";
    if ((r.ambiente === "PRODUCAO" || bloqueada) && !confirmou) throw new NumeracaoError("NUMERACAO_CONFIRMAR_DESCARTE", 409,
      bloqueada
        ? `O nº ${r.numero} (série ${r.serie}) está retido para conferência: confirme que ele NÃO foi autorizado na SEFAZ antes de descartá-lo`
        : `O nº ${r.numero} (série ${r.serie}) ficará sem uso e precisará ser inutilizado`,
      { numero: r.numero, serie: r.serie, motivo });
  }
  private validarChave(userId: string, k: ChaveFiscal): void {
    if (!userId || !k.cfc || !["HOMOLOGACAO", "PRODUCAO"].includes(k.ambiente) || !["55", "65"].includes(k.modelo) || !Number.isInteger(k.serie) || k.serie < 0 || k.serie > 999) {
      throw new NumeracaoError("CHAVE_FISCAL_INVALIDA", 422, "Chave fiscal inválida");
    }
  }
}
