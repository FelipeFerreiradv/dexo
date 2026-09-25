"use client";
// React explicito, como no `devolucao-editor.tsx` ao lado: o tsconfig usa jsx em
// modo preserve, entao o esbuild do vitest compila o JSX para o
// React.createElement classico e o componente so monta em jsdom com o React em
// escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import {useCallback,useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {getApiBaseUrl} from "@/lib/api";
import type {DevolucaoAbertaResumo} from "@/app/fiscal/devolucao/contrato";
import {navegarPara} from "../lib/nfe-navegacao";
import {consultarDisponibilidade} from "../lib/nfe-devolucao-disponibilidade-ui";
// Textos, ordem e o descarte (com a confirmação do número fiscal) vivem no
// módulo puro ao lado, testado em node. Aqui só se desenha.
import {
  LINK_INUTILIZAR,
  ROTULO_CANCELAR,
  ROTULO_CONTINUAR,
  ROTULO_DESCARTAR,
  ROTULO_DESCARTAR_CONFIRMADO,
  SUBTITULO_DEVOLUCOES_EM_ANDAMENTO,
  TITULO_DEVOLUCOES_EM_ANDAMENTO,
  descartarRascunho,
  lerAbertas,
  viewDevolucoesAbertas,
} from "../lib/nfe-devolucoes-abertas-ui";

/**
 * "Devoluções em andamento": os rascunhos de devolução que a lista de notas
 * esconde (ela só mostra nota com número real). Com "Continuar" e "Descartar".
 *
 * Some por inteiro (renderiza nada) quando a empresa não tem a devolução ligada
 * ou quando não há nenhuma em andamento — a lista das outras empresas fica
 * exatamente como era.
 *
 * Pergunta ANTES se a devolução está ligada (a mesma pergunta do "Devolução
 * manual", dividida quando os dois montam juntos): desligada, o GET /abertas
 * nem sai — antes era um 404 e uma consulta ao banco em toda carga da lista, de
 * todo cliente.
 */
export function DevolucoesEmAndamento({email}:{email:string}) {
  const [abertas,setAbertas]=useState<DevolucaoAbertaResumo[]>([]);
  const [confirmar,setConfirmar]=useState<{draftId:string;mensagem:string}|null>(null);
  const [ocupado,setOcupado]=useState<string|null>(null);
  const [erro,setErro]=useState<{draftId:string;mensagem:string}|null>(null);
  // Respondida uma vez por montagem: recarregar depois de um descarte não pergunta de novo.
  const ligada=useRef<{email:string;sim:boolean}|null>(null);
  const carregar=useCallback(async()=>{
    if(!email)return;
    try{
      if(ligada.current?.email!==email)ligada.current={email,sim:(await consultarDisponibilidade({base:getApiBaseUrl(),email})).ligada};
      if(!ligada.current.sim){setAbertas([]);return;}
      const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/devolucao/abertas`,{headers:{email}});
      if(!r.ok){setAbertas([]);return;}
      setAbertas(lerAbertas(await r.json().catch(()=>null)));
    }catch{/* silencioso: o quadro só não aparece */}
  },[email]);
  useEffect(()=>{void carregar();},[carregar]);

  const descartar=async(draftId:string,descartarNumero:boolean)=>{
    if(ocupado)return;setOcupado(draftId);setErro(null);
    try{
      const r=await descartarRascunho({base:getApiBaseUrl(),email,draftId,descartarNumero});
      if(r.ok){setConfirmar(null);await carregar();return;}
      if(r.confirmar){setConfirmar({draftId,mensagem:r.mensagem});return;}
      setConfirmar(null);setErro({draftId,mensagem:r.mensagem});
    }finally{setOcupado(null);}
  };

  if(!abertas.length)return null;
  const linhas=viewDevolucoesAbertas(abertas);
  return <section aria-label={TITULO_DEVOLUCOES_EM_ANDAMENTO} className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
    <p className="font-medium">{TITULO_DEVOLUCOES_EM_ANDAMENTO} ({linhas.length})</p>
    <p className="text-xs text-muted-foreground">{SUBTITULO_DEVOLUCOES_EM_ANDAMENTO}</p>
    <ul className="space-y-2">{linhas.map(l=><li key={l.draftId} className="space-y-1 rounded border bg-card/60 p-3 text-sm" data-draft={l.draftId}>
      <p className="font-medium">{l.titulo}{l.para?` — ${l.para}`:""}</p>
      <p className="text-xs text-muted-foreground">{[l.notas,l.itens,l.quando].filter(Boolean).join(" · ")}</p>
      {l.numero && <p className="text-xs">{l.numero}</p>}
      {l.aviso && <p className="text-xs text-amber-800">{l.aviso}</p>}
      {l.repetida && <p className="text-xs text-amber-800">{l.repetida}</p>}
      {confirmar?.draftId===l.draftId
        ?<div role="alertdialog" aria-label="Confirmar descarte" className="space-y-2 rounded border border-destructive/40 bg-destructive/5 p-2">
          <p className="text-sm">{confirmar.mensagem}</p>
          <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="destructive" disabled={ocupado!==null} onClick={()=>void descartar(l.draftId,true)}>{ROTULO_DESCARTAR_CONFIRMADO}</Button><Button type="button" size="sm" variant="outline" onClick={()=>setConfirmar(null)}>{ROTULO_CANCELAR}</Button></div>
        </div>
        :<div className="flex flex-wrap items-center gap-2">
          {l.podeContinuar && l.continuarUrl && <Button type="button" size="sm" variant="outline" onClick={()=>navegarPara(l.continuarUrl!)}>{ROTULO_CONTINUAR}</Button>}
          <Button type="button" size="sm" variant="ghost" disabled={ocupado!==null} onClick={()=>void descartar(l.draftId,false)}>{ocupado===l.draftId?"Descartando…":ROTULO_DESCARTAR}</Button>
        </div>}
      {l.avisoNumero && <p className="text-xs text-muted-foreground">{l.avisoNumero} <a className="underline" href={LINK_INUTILIZAR}>Inutilizar número</a></p>}
      {erro?.draftId===l.draftId && <p role="alert" className="text-xs text-destructive">{erro.mensagem}</p>}
    </li>)}</ul>
  </section>;
}
