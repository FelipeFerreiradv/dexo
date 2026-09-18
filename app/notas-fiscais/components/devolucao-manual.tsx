"use client";
import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {getApiBaseUrl} from "@/lib/api";
export function DevolucaoManual({email}:{email:string}) {
  const [config,setConfig]=useState<string|null>(null);const [open,setOpen]=useState(false);const [modo,setModo]=useState("XML");const [tipo,setTipo]=useState("COMPRA_SAIDA");const [xml,setXml]=useState("");const [chave,setChave]=useState("");const [confirmado,setConfirmado]=useState(false);const [nome,setNome]=useState("");const [doc,setDoc]=useState("");const [uf,setUf]=useState("");
  const [itens,setItens]=useState([{nItem:1,codigo:"",descricao:"",ncm:"",unidade:"UN",valorUnitario:0,quantidade:1,cfopOriginal:""}]);
  const pending=useRef(false);const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  useEffect(()=>{const ac=new AbortController();if(email)fetch(`${getApiBaseUrl()}/fiscal/nfe/devolucao/disponibilidade`,{headers:{email},signal:ac.signal}).then(async r=>{if(r.ok)setConfig((await r.json()).companyFiscalConfigId);}).catch(()=>{});return()=>ac.abort();},[email]);
  if(!config)return null;
  const criar=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError("");try{const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/devolucao/manual`,{method:"POST",headers:{email,"Content-Type":"application/json"},body:JSON.stringify({companyFiscalConfigId:config,tipo,...(modo==="XML"?{xmlOriginal:xml}:{chaveAcesso:chave,confirmarSemXml:confirmado,itens,destinatario:{tipoPessoa:doc.replace(/\D/g,"").length===11?"PF":"PJ",cpfCnpj:doc,nome,uf}})})});const d=await r.json();if(!r.ok)throw new Error(d.error);window.location.assign(`/notas-fiscais/nfe?draft=${encodeURIComponent(d.draftId)}`);}catch(e){setError(e instanceof Error?e.message:"Não foi possível criar a devolução");}finally{pending.current=false;setBusy(false);}};
  return <section className="space-y-3"><Button type="button" variant="outline" onClick={()=>setOpen(v=>!v)}>Devolução manual</Button>{open&&<div className="space-y-3 rounded border p-4">
    <p>Importe o XML autorizado ou informe a chave e os itens. Revise os dados no assistente antes de emitir.</p>
    <label>Operação <select value={tipo} onChange={e=>setTipo(e.target.value)}><option value="COMPRA_SAIDA">Devolução de compra</option><option value="VENDA_ENTRADA">Devolução de venda</option></select></label>
    <label className="block">Fonte <select value={modo} onChange={e=>setModo(e.target.value)}><option>XML</option><option value="CHAVE">Chave sem XML</option></select></label>
    {modo==="XML"?<label>XML autorizado<Input type="file" accept=".xml,text/xml" onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>1048576){setError("XML deve ter até 1 MiB");return;}setXml(await file.text());}}/></label>:<>
      <label>Chave de acesso<Input value={chave} maxLength={44} onChange={e=>setChave(e.target.value)}/></label>
      <label>Destinatário<Input value={nome} onChange={e=>setNome(e.target.value)}/></label><label>CPF/CNPJ<Input value={doc} onChange={e=>setDoc(e.target.value)}/></label><label>UF do destinatário<Input value={uf} maxLength={2} onChange={e=>setUf(e.target.value.toUpperCase())}/></label>
      {itens.map((i,index)=><div className="grid grid-cols-3 gap-2 rounded border p-2" key={index}>{(["nItem","codigo","descricao","ncm","unidade","cfopOriginal","valorUnitario","quantidade"] as const).map(k=><label key={k}>{({nItem:"Item na original",codigo:"Código",descricao:"Descrição",ncm:"NCM",unidade:"Unidade",cfopOriginal:"CFOP original",valorUnitario:"Valor unitário",quantidade:"Quantidade"})[k]}<Input value={i[k]} onChange={e=>setItens(old=>old.map((row,j)=>j===index?{...row,[k]:["nItem","valorUnitario","quantidade"].includes(k)?Number(e.target.value):e.target.value}:row))}/></label>)}</div>)}
      <Button type="button" variant="outline" onClick={()=>setItens(old=>[...old,{...old[0],nItem:old.length+1,codigo:"",descricao:""}])}>Adicionar item</Button>
      <label className="flex gap-2"><input type="checkbox" checked={confirmado} onChange={e=>setConfirmado(e.target.checked)}/>Confirmo a devolução sem XML e revisarei os tributos</label>
    </>}
    {error&&<p role="alert">{error}</p>}<Button type="button" disabled={busy} onClick={criar}>Criar rascunho de devolução</Button>
  </div>}</section>;
}
