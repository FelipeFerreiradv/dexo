"use client";
// React explicito, como no `pendencias-devolucao.tsx` e no `step-impostos.tsx`
// ao lado: o tsconfig usa jsx em modo preserve, entao o esbuild do vitest
// compila o JSX para o React.createElement classico e o componente so monta em
// jsdom com o React em escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import {useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {getApiBaseUrl} from "@/lib/api";
import {PendenciasDevolucao} from "./pendencias-devolucao";
import {viewPendenciasDoDetalhe} from "../lib/nfe-devolucao-pendencias-ui";
// O campo de ICMS conhece o regime da empresa (DevolucaoDetalhe.emitente) e
// recusa o codigo errado na hora. Quem decide texto, lista e veredito e o
// modulo puro ao lado — aqui so se desenha. Ver o cabecalho dele para o caso
// real da DLS AUTO PECAS (Simples Nacional digitando `00`, que e CST).
import {BLOQUEIO_CONFIRMAR,ESCOLHA_ANTES_DA_ALIQUOTA,SEM_ALIQUOTA,campoIcms,overrideComIcms,regimeDoDetalhe} from "../lib/nfe-devolucao-icms-campo";
import type {CrtEmitente} from "@/app/fiscal/devolucao/tipos";
import type {DevolucaoDetalhe,AtualizarItemBody} from "@/app/fiscal/devolucao/contrato";

/** Explicit saves: this editor never mirrors server state into RHF through effects. */
export function DevolucaoEditor({value,email,onSaved,step}:{value:DevolucaoDetalhe;email:string;onSaved:(d:DevolucaoDetalhe)=>Promise<void>;step:number}) {
  const [itens,setItens]=useState<AtualizarItemBody[]>(()=>value.itens.map(i=>({chaveAcesso:i.chaveAcesso,nItem:i.nItem,quantidade:i.quantidade,cfop:i.cfop,confirmarTributacao:i.tributacao.confirmada})));
  // `null` = ela ainda nao mexeu no seletor de ICMS deste item; so entao o campo
  // julga o codigo que veio gravado — que e o do XML do FORNECEDOR.
  const [icmsEscolhido,setIcmsEscolhido]=useState<(string|null)[]>(()=>value.itens.map(()=>null));
  const [entregue,setEntregue]=useState(value.devolvidaAposEntrega===true);
  const [escopo,setEscopo]=useState(value.escopo);
  const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);const pending=useRef(false);
  const regime=regimeDoDetalhe(value.emitente);
  const campos=value.itens.map((i,k)=>campoIcms({emitente:value.emitente,icmsDoItem:i.tributacao.icms,escolhido:icmsEscolhido[k]}));
  // No passo de impostos, `confirmarTributacao` nunca viaja `true` num item cujo
  // codigo de ICMS ainda nao serve — e exatamente o que a caixinha mostra, e e o
  // que impede o ciclo "marco revisado, salvo, e a SEFAZ recusa com a 591".
  const corpoItens=()=>itens.map((i,k)=>step===3||campos[k]?.precisaEscolher!==true?i:{...i,confirmarTributacao:false}).filter(i=>i.quantidade>0);
  const save=async()=>{
    if(pending.current)return;pending.current=true;setBusy(true);setMessage("");
    try {
      const path=`${getApiBaseUrl()}/fiscal/nfe/draft/${value.draftId}/devolucao`;
      const res=await fetch(step===1?path:`${path}/itens`,{method:"PUT",headers:{email,"Content-Type":"application/json"},body:JSON.stringify(step===1?{devolvidaAposEntrega:entregue,escopo}:{itens:corpoItens()})});
      const data=await res.json();if(!res.ok)throw new Error(data.error??"Não foi possível salvar");
      await onSaved(data);setMessage("Devolução salva");
    }catch(e){setMessage(e instanceof Error?e.message:"Não foi possível salvar");}
    finally{pending.current=false;setBusy(false);}
  };
  const update=(index:number,patch:Partial<AtualizarItemBody>)=>setItens(old=>old.map((i,k)=>k===index?{...i,...patch}:i));
  // O codigo do ICMS viaja no override pelo juiz do servidor (`overrideComIcms`),
  // nunca mais pelo tamanho do texto digitado. Trocar o codigo desfaz a revisao.
  const escolherIcms=(index:number,codigo:string,crt:CrtEmitente|null)=>{
    setIcmsEscolhido(old=>old.map((c,k)=>k===index?codigo:c));
    setItens(old=>old.map((i,k)=>k===index?{...i,tributacao:overrideComIcms(i.tributacao,{codigo,crt}),confirmarTributacao:false}:i));
  };
  return <section className="space-y-4 rounded-lg border p-4" aria-label="Devolução fiscal">
    <p className="font-medium">Devolução {value.tipo==="VENDA_ENTRADA"?"de venda (entrada)":"de compra (saída)"}</p>
    <p className="text-sm text-muted-foreground">Operação exclusivamente fiscal. O estoque não será alterado. Referência por {value.modoReferencia==="ITEM"?"item":"nota"}.</p>
    {value.originais.map(o=><p key={o.chaveAcesso} className="break-all text-xs">NF-e {o.numero}/{o.serie} — {o.chaveAcesso}</p>)}
    {step===1?<>
      <label className="block">Escopo <select className="rounded border p-2" value={escopo} onChange={e=>setEscopo(e.target.value as "TOTAL"|"PARCIAL")}><option value="TOTAL">Total</option><option value="PARCIAL">Parcial</option></select></label>
      <label className="flex gap-2"><input type="checkbox" checked={entregue} onChange={e=>setEntregue(e.target.checked)}/>A mercadoria foi entregue e está sendo devolvida</label>
    </>:<>
      {/* O regime da empresa dito UMA vez, antes dos itens: e ele que decide se
          o codigo do ICMS aqui e CSOSN (3 digitos) ou CST (2). */}
      {step!==3 && <p className="text-sm text-muted-foreground">{regime.ajuda}</p>}
      {itens.map((item,index)=>{const original=value.itens[index];const campo=campos[index];return <div key={`${item.chaveAcesso}-${item.nItem}`} className="space-y-2 rounded border p-3">
      <p>{original.codigo} — {original.descricao}</p><p className="text-xs">Item original {item.nItem}. Disponível: {original.disponivel??"não informado"}. CFOP original: {original.cfopOriginal??"não informado"}</p>
      {step===3?<div className="flex gap-3"><label>Quantidade<Input type="number" min="0" step="0.0001" max={original.disponivel??undefined} value={item.quantidade} onChange={e=>update(index,{quantidade:Number(e.target.value),confirmarTributacao:false})}/></label><label>CFOP<Input value={item.cfop} maxLength={4} onChange={e=>update(index,{cfop:e.target.value})}/></label></div>:<>
        <p className="text-sm">ICMS: {original.tributacao.icms.csosn??original.tributacao.icms.cst}; PIS: {original.tributacao.pis.cst}; COFINS: {original.tributacao.cofins.cst}</p>
        {/* O valor que veio da nota original pode ser de OUTRO regime (foi o caso:
            CST de uma distribuidora do regime normal numa devolucao do Simples).
            A tela diz que nao serve e por que — e nao escolhe nada no lugar dela. */}
        {campo.precisaEscolher && <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800">
          {campo.titulo!=="" && <p className="text-sm font-semibold">{campo.titulo}</p>}
          {campo.motivo!=="" && <p className="text-sm">{campo.motivo}</p>}
          {campo.origem!=="" && <p className="text-xs">{campo.origem}</p>}
          <p className="text-sm">{campo.comoResolver}</p>
        </div>}
        <div className="grid grid-cols-3 gap-3">{(["icms","pis","cofins"] as const).map(tributo=>tributo==="icms"
          ?<label key={tributo} className="block">{campo.rotulo}<select className="w-full rounded border p-2" aria-label={campo.rotulo} value={campo.valor} onChange={e=>escolherIcms(index,e.target.value,campo.crt)}><option value="">{campo.placeholder}</option>{campo.opcoes.map(o=><option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}</select></label>
          :<label key={tributo}>{tributo.toUpperCase()} CST<Input placeholder="CST" onChange={e=>{const v=e.target.value;update(index,{tributacao:{...item.tributacao,[tributo]:{cst:v}}});}}/></label>)}</div>
        <div className="grid grid-cols-3 gap-3">{(["icms","pis","cofins"] as const).map(tributo=>tributo==="icms"
          ?<label key={tributo}>ICMS alíquota (%){campo.precisaEscolher
            ?<p className="text-xs text-muted-foreground">{ESCOLHA_ANTES_DA_ALIQUOTA}</p>
            :campo.exigeAliquota
              ?<Input type="number" min="0" max="100" step="0.01" defaultValue={original.tributacao.icms.pICMS} onChange={e=>update(index,{tributacao:overrideComIcms(item.tributacao,{codigo:campo.valor,crt:campo.crt,pICMS:Number(e.target.value)})})}/>
              :<p className="text-xs text-muted-foreground">{SEM_ALIQUOTA}</p>}</label>
          :<label key={tributo}>{tributo.toUpperCase()} alíquota (%)<Input type="number" min="0" max="100" step="0.01" defaultValue={original.tributacao[tributo].p} onChange={e=>update(index,{tributacao:{...item.tributacao,[tributo]:{...item.tributacao?.[tributo],p:Number(e.target.value)}}})}/></label>)}</div>
        <label className="flex gap-2"><input type="checkbox" disabled={campo.precisaEscolher} checked={item.confirmarTributacao===true && !campo.precisaEscolher} onChange={e=>update(index,{confirmarTributacao:e.target.checked})}/>Revisei a tributação deste item</label>
        {campo.precisaEscolher && <p className="text-xs text-amber-800">{BLOQUEIO_CONFIRMAR}</p>}
      </>}
    </div>;})}
    </>}
    {/* A prévia do MESMO `validarDevolucao` que recusa a emissão depois. Era
        uma pilha de <p> sem hierarquia, uma por item, em que "Item 1: revise e
        confirme a tributação." aparecia seis vezes quase igual; agora agrupa,
        diz em quais itens está e o que fazer (lib/nfe-devolucao-pendencias-ui). */}
    {value.issues.length>0 && <PendenciasDevolucao view={viewPendenciasDoDetalhe(value)}/>}
    <Button type="button" disabled={busy} onClick={save}>{busy?"Salvando…":"Salvar devolução"}</Button>
    {message && <p role="status">{message}</p>}
  </section>;
}
