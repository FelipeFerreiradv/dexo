"use client";
// React explicito, como no `devolucao-editor.tsx` ao lado: o tsconfig usa jsx em
// modo preserve, entao o esbuild do vitest compila o JSX para o
// React.createElement classico e o componente so monta em jsdom com o React em
// escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import {useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {getApiBaseUrl} from "@/lib/api";
import {urlRascunhoDevolucao} from "../lib/nfe-devolucao-wizard-ui";
import {urlDevolverPelaChave} from "../lib/nfe-devolucao-manual-ui";
import {navegarPara} from "../lib/nfe-navegacao";

export const ROTULO_DEVOLVER_PELA_CHAVE = "Devolver pela chave";
/** Por que esta venda devolve pela chave: o Dexo não guarda o XML dela (histórico importado). */
export const EXPLICA_DEVOLVER_PELA_CHAVE =
  "O Dexo não tem o XML autorizado desta nota (histórico importado), então a devolução sai pela chave de acesso — o quadro \"Devolução manual\" abre já preenchido com as peças desta venda.";

/**
 * Botões de devolução de uma nota de VENDA autorizada.
 *
 * - `devolucaoDisponivel`: o Dexo monta a devolução do XML autorizado ("Devolver
 *   total"/"Devolver parcial"). Quando já havia uma devolução desta nota em
 *   andamento, o servidor reabre ELA (`reutilizado: true`) — e agora a tela avisa,
 *   em vez de cair calada no rascunho antigo.
 * - `devolucaoPelaChave`: venda sem XML guardado (447 notas da DLS, histórico
 *   importado). O "Devolver" prometia e só respondia "use a devolução manual";
 *   agora o botão leva à devolução pela chave, já preenchida.
 * - `elegivel === false` (ficha da nota, pelo saldo): nada mais a devolver — os
 *   botões somem, e a ficha diz por quê.
 */
export function DevolucaoActions({nota,email,elegivel}:{nota:{id:string;status:string;finalidade:string;tipoOperacao:string;devolucaoDisponivel?:boolean;devolucaoPelaChave?:boolean};email:string;elegivel?:boolean}) {
  const pending=useRef(false);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
  if(nota.status!=="AUTHORIZED" || nota.finalidade==="DEVOLUCAO" || nota.tipoOperacao!=="SAIDA")return null;
  if(!nota.devolucaoDisponivel && nota.devolucaoPelaChave) {
    return <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" title={EXPLICA_DEVOLVER_PELA_CHAVE} onClick={()=>navegarPara(urlDevolverPelaChave(nota.id))}>{ROTULO_DEVOLVER_PELA_CHAVE}</Button></div>;
  }
  if(!nota.devolucaoDisponivel || elegivel===false)return null;
  const criar=async(escopo:"TOTAL"|"PARCIAL")=>{if(pending.current)return;pending.current=true;setBusy(true);setMessage("");try{const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/${nota.id}/devolucao`,{method:"POST",headers:{email,"Content-Type":"application/json"},body:JSON.stringify({escopo})});const d=await r.json();if(!r.ok)throw new Error(d.error);navegarPara(urlRascunhoDevolucao(d.draftId,d.reutilizado===true));}catch(e){setMessage(e instanceof Error && e.message?e.message:"Não foi possível criar devolução");}finally{pending.current=false;setBusy(false);}};
  return <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>criar("TOTAL")}>Devolver total</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>criar("PARCIAL")}>Devolver parcial</Button>{message&&<p role="alert">{message}</p>}</div>;
}
