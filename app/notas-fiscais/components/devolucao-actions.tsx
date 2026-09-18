"use client";
import {useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {getApiBaseUrl} from "@/lib/api";
export function DevolucaoActions({nota,email}:{nota:{id:string;status:string;finalidade:string;tipoOperacao:string;devolucaoDisponivel?:boolean};email:string}) {
  const pending=useRef(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  if(!nota.devolucaoDisponivel || nota.status!=="AUTHORIZED" || nota.finalidade==="DEVOLUCAO" || nota.tipoOperacao!=="SAIDA")return null;
  const criar=async(escopo:"TOTAL"|"PARCIAL")=>{if(pending.current)return;pending.current=true;setBusy(true);try{const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/${nota.id}/devolucao`,{method:"POST",headers:{email,"Content-Type":"application/json"},body:JSON.stringify({escopo})});const d=await r.json();if(!r.ok)throw new Error(d.error);window.location.assign(`/notas-fiscais/nfe?draft=${encodeURIComponent(d.draftId)}`);}catch(e){setMessage(e instanceof Error?e.message:"Não foi possível criar devolução");}finally{pending.current=false;setBusy(false);}};
  return <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>criar("TOTAL")}>Devolver total</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>criar("PARCIAL")}>Devolver parcial</Button>{message&&<p role="alert">{message}</p>}</div>;
}
