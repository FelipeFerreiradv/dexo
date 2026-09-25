"use client";
// React explícito, como no `devolucoes-em-andamento.tsx`: o esbuild do vitest compila o JSX no runtime clássico e o componente só monta em jsdom com o React em escopo. Em produção o Next segue com o automático.
import * as React from "react";
import {useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {getApiBaseUrl} from "@/lib/api";
import {navegarPara} from "../lib/nfe-navegacao";
import {ROTULO_CANCELAR,ROTULO_DESCARTAR_CONFIRMADO,descartarRascunho} from "../lib/nfe-devolucoes-abertas-ui";
import {ROTULO_CONFIRMAR_DESCARTE_NUMERO,acoesNumeracao,ajudaBloqueado,descartarNumeroBloqueado,podeConsultarSituacao,retomarEmissao,textoEstadoNumeracao,urlEmitirDeNovo,type NumeracaoView,type RespostaNumeracao} from "../lib/nfe-numeracao-ui";
export type {NumeracaoView} from "../lib/nfe-numeracao-ui";
// onChanged recebe a resposta da consulta: o wizard atualiza a tela por ela (GET /nfe/draft/:id dá 404 para SENDING/AUTHORIZED); lista e detalhe só recarregam.
// BLOQUEADO (só a linha com a chave `numeracao`): "Descartar o nº X e emitir com número novo" (POST .../numeracao/descartar-bloqueado) e "Excluir rascunho" (DELETE), os dois com a confirmação das devoluções.
// Depois do descarte a nota volta a rascunho: sem `onDescartado` (lista, ficha) ela abre no assistente; o wizard, que já está nela, passa o seu. `onExcluido` idem (sem ele, recarrega por onChanged).
// `retomavel` (B8, calculado no servidor): "Retomar emissão" chama POST /issue DIRETO — nunca o wizard, que daria 404 para VALIDATING e criaria outro rascunho calado.
export function NumeracaoActions({id,email,numeracao,onChanged,retomavel,compacto,onDescartado,onExcluido}:{id:string;email:string;numeracao?:NumeracaoView|null;onChanged?:(d:RespostaNumeracao)=>void;retomavel?:boolean;compacto?:boolean;onDescartado?:(r:{numeroDescartado:number;serie:number|null})=>void;onExcluido?:()=>void}) {
  const pending=useRef(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  // A pergunta aberta: descartar o nº (rota nova) ou excluir o rascunho (DELETE ?descartarNumero=true).
  const [confirmar,setConfirmar]=useState<{tipo:"NUMERO"|"RASCUNHO";mensagem:string}|null>(null);
  const acoes=acoesNumeracao(numeracao,retomavel);
  if(!numeracao && !acoes.retomar)return null;
  const consultar=async()=>{if(pending.current)return;pending.current=true;setBusy(true);try{const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/${id}/consultar-situacao`,{method:"POST",headers:{email}});const d=await r.json();setMessage(d.mensagem??d.error);onChanged?.(d);}catch{setMessage("Não foi possível consultar");}finally{pending.current=false;setBusy(false);}};
  const umPorVez=async(f:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setMessage("");try{await f();}finally{pending.current=false;setBusy(false);}};
  const descartarNumero=(confirmado:boolean)=>umPorVez(async()=>{
    const r=await descartarNumeroBloqueado({base:getApiBaseUrl(),email,nfeId:id,confirmar:confirmado});
    if(r.ok){setConfirmar(null);if(onDescartado)onDescartado({numeroDescartado:r.numeroDescartado,serie:r.serie});else navegarPara(urlEmitirDeNovo(id));return;}
    if(r.confirmar){setConfirmar({tipo:"NUMERO",mensagem:r.mensagem});return;}
    setConfirmar(null);setMessage(r.mensagem);
  });
  const excluir=(confirmado:boolean)=>umPorVez(async()=>{
    const r=await descartarRascunho({base:getApiBaseUrl(),email,draftId:id,descartarNumero:confirmado});
    if(r.ok){setConfirmar(null);if(onExcluido)onExcluido();else onChanged?.({});return;}
    if(r.confirmar){setConfirmar({tipo:"RASCUNHO",mensagem:r.mensagem});return;}
    setConfirmar(null);setMessage(r.mensagem);
  });
  const retomar=()=>umPorVez(async()=>{const r=await retomarEmissao({base:getApiBaseUrl(),email,nfeId:id});setMessage(r.mensagem);onChanged?.(r.corpo);});
  return <div className="space-y-1 text-xs">
    {numeracao&&<p>Nº {numeracao.numero}: {textoEstadoNumeracao(numeracao)}</p>}
    {acoes.descartarNumero&&!compacto&&<p className="text-muted-foreground">{ajudaBloqueado(numeracao!)}</p>}
    {podeConsultarSituacao(numeracao)&&<Button type="button" variant="outline" size="sm" disabled={busy} onClick={consultar}>Consultar situação</Button>}
    {confirmar
      ?<div role="alertdialog" aria-label="Confirmar descarte" className="space-y-2 rounded border border-destructive/40 bg-destructive/5 p-2">
        <p>{confirmar.mensagem}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={()=>void (confirmar.tipo==="NUMERO"?descartarNumero(true):excluir(true))}>{confirmar.tipo==="NUMERO"?ROTULO_CONFIRMAR_DESCARTE_NUMERO:ROTULO_DESCARTAR_CONFIRMADO}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>setConfirmar(null)}>{ROTULO_CANCELAR}</Button></div>
      </div>
      :(acoes.descartarNumero||acoes.excluirRascunho)&&<div className="flex flex-wrap gap-2">
        {acoes.descartarNumero&&<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void descartarNumero(false)}>{acoes.descartarNumero}</Button>}
        {acoes.excluirRascunho&&<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>void excluir(false)}>{acoes.excluirRascunho}</Button>}
      </div>}
    {acoes.retomar&&<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>void retomar()}>{acoes.retomar}</Button>}
    {message&&<p role="status">{message}</p>}
  </div>;
}
