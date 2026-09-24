"use client";
import {useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {getApiBaseUrl} from "@/lib/api";
import {PendenciasDevolucao} from "./pendencias-devolucao";
import {viewPendenciasDoDetalhe} from "../lib/nfe-devolucao-pendencias-ui";
import type {DevolucaoDetalhe,AtualizarItemBody} from "@/app/fiscal/devolucao/contrato";

/** Explicit saves: this editor never mirrors server state into RHF through effects. */
export function DevolucaoEditor({value,email,onSaved,step}:{value:DevolucaoDetalhe;email:string;onSaved:(d:DevolucaoDetalhe)=>Promise<void>;step:number}) {
  const [itens,setItens]=useState<AtualizarItemBody[]>(()=>value.itens.map(i=>({chaveAcesso:i.chaveAcesso,nItem:i.nItem,quantidade:i.quantidade,cfop:i.cfop,confirmarTributacao:i.tributacao.confirmada})));
  const [entregue,setEntregue]=useState(value.devolvidaAposEntrega===true);
  const [escopo,setEscopo]=useState(value.escopo);
  const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);const pending=useRef(false);
  const save=async()=>{
    if(pending.current)return;pending.current=true;setBusy(true);setMessage("");
    try {
      const path=`${getApiBaseUrl()}/fiscal/nfe/draft/${value.draftId}/devolucao`;
      const res=await fetch(step===1?path:`${path}/itens`,{method:"PUT",headers:{email,"Content-Type":"application/json"},body:JSON.stringify(step===1?{devolvidaAposEntrega:entregue,escopo}:{itens:itens.filter(i=>i.quantidade>0)})});
      const data=await res.json();if(!res.ok)throw new Error(data.error??"Não foi possível salvar");
      await onSaved(data);setMessage("Devolução salva");
    }catch(e){setMessage(e instanceof Error?e.message:"Não foi possível salvar");}
    finally{pending.current=false;setBusy(false);}
  };
  const update=(index:number,patch:Partial<AtualizarItemBody>)=>setItens(old=>old.map((i,k)=>k===index?{...i,...patch}:i));
  return <section className="space-y-4 rounded-lg border p-4" aria-label="Devolução fiscal">
    <p className="font-medium">Devolução {value.tipo==="VENDA_ENTRADA"?"de venda (entrada)":"de compra (saída)"}</p>
    <p className="text-sm text-muted-foreground">Operação exclusivamente fiscal. O estoque não será alterado. Referência por {value.modoReferencia==="ITEM"?"item":"nota"}.</p>
    {value.originais.map(o=><p key={o.chaveAcesso} className="break-all text-xs">NF-e {o.numero}/{o.serie} — {o.chaveAcesso}</p>)}
    {step===1?<>
      <label className="block">Escopo <select className="rounded border p-2" value={escopo} onChange={e=>setEscopo(e.target.value as "TOTAL"|"PARCIAL")}><option value="TOTAL">Total</option><option value="PARCIAL">Parcial</option></select></label>
      <label className="flex gap-2"><input type="checkbox" checked={entregue} onChange={e=>setEntregue(e.target.checked)}/>A mercadoria foi entregue e está sendo devolvida</label>
    </>:itens.map((item,index)=>{const original=value.itens[index];return <div key={`${item.chaveAcesso}-${item.nItem}`} className="space-y-2 rounded border p-3">
      <p>{original.codigo} — {original.descricao}</p><p className="text-xs">Item original {item.nItem}. Disponível: {original.disponivel??"não informado"}. CFOP original: {original.cfopOriginal??"não informado"}</p>
      {step===3?<div className="flex gap-3"><label>Quantidade<Input type="number" min="0" step="0.0001" max={original.disponivel??undefined} value={item.quantidade} onChange={e=>update(index,{quantidade:Number(e.target.value),confirmarTributacao:false})}/></label><label>CFOP<Input value={item.cfop} maxLength={4} onChange={e=>update(index,{cfop:e.target.value})}/></label></div>:<>
        <p className="text-sm">ICMS: {original.tributacao.icms.csosn??original.tributacao.icms.cst}; PIS: {original.tributacao.pis.cst}; COFINS: {original.tributacao.cofins.cst}</p>
        <div className="grid grid-cols-3 gap-3">{(["icms","pis","cofins"] as const).map(tributo=><label key={tributo}>{tributo.toUpperCase()} CST<Input placeholder={tributo==="icms"?"CST ou CSOSN":"CST"} onChange={e=>{const v=e.target.value;update(index,{tributacao:{...item.tributacao,[tributo]:tributo==="icms"?(v.length===3?{csosn:v,cst:null}:{cst:v,csosn:null}):{cst:v}}});}}/></label>)}</div>
        <div className="grid grid-cols-3 gap-3">{(["icms","pis","cofins"] as const).map(tributo=><label key={tributo}>{tributo.toUpperCase()} alíquota (%)<Input type="number" min="0" max="100" step="0.01" defaultValue={tributo==="icms"?original.tributacao.icms.pICMS:original.tributacao[tributo].p} onChange={e=>update(index,{tributacao:{...item.tributacao,[tributo]:{...item.tributacao?.[tributo],...(tributo==="icms"?{pICMS:Number(e.target.value)}:{p:Number(e.target.value)})}}})}/></label>)}</div>
        <label className="flex gap-2"><input type="checkbox" checked={item.confirmarTributacao===true} onChange={e=>update(index,{confirmarTributacao:e.target.checked})}/>Revisei a tributação deste item</label>
      </>}
    </div>;})}
    {/* A prévia do MESMO `validarDevolucao` que recusa a emissão depois. Era
        uma pilha de <p> sem hierarquia, uma por item, em que "Item 1: revise e
        confirme a tributação." aparecia seis vezes quase igual; agora agrupa,
        diz em quais itens está e o que fazer (lib/nfe-devolucao-pendencias-ui). */}
    {value.issues.length>0 && <PendenciasDevolucao view={viewPendenciasDoDetalhe(value)}/>}
    <Button type="button" disabled={busy} onClick={save}>{busy?"Salvando…":"Salvar devolução"}</Button>
    {message && <p role="status">{message}</p>}
  </section>;
}
