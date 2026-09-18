"use client";
import {useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {getApiBaseUrl} from "@/lib/api";
export interface NumeracaoView {estado:string;numero:number;serie?:number;reutilizavel?:boolean}
export function NumeracaoActions({id,email,numeracao,onChanged}:{id:string;email:string;numeracao?:NumeracaoView|null;onChanged?:()=>void}) {
  const pending=useRef(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  if(!numeracao)return null;
  const consultar=async()=>{if(pending.current)return;pending.current=true;setBusy(true);try{const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/${id}/consultar-situacao`,{method:"POST",headers:{email}});const d=await r.json();setMessage(d.mensagem??d.error);onChanged?.();}catch{setMessage("Não foi possível consultar");}finally{pending.current=false;setBusy(false);}};
  return <div className="space-y-1 text-xs"><p>Nº {numeracao.numero}: {numeracao.reutilizavel?"mantido para nova tentativa":numeracao.estado}</p>{["INCERTO","EM_TRANSMISSAO"].includes(numeracao.estado)&&<Button type="button" variant="outline" size="sm" disabled={busy} onClick={consultar}>Consultar situação</Button>}{message&&<p role="status">{message}</p>}</div>;
}
