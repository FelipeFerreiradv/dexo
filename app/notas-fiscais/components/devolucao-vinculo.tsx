"use client";
// React explicito, como no `devolucao-editor.tsx` ao lado: o tsconfig usa jsx em
// modo preserve, entao o esbuild do vitest compila o JSX para o
// React.createElement classico e o componente so monta em jsdom com o React em
// escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import {useEffect,useState} from "react";
import {getApiBaseUrl} from "@/lib/api";
import type {DevolucaoDetalhe,SaldoResposta} from "@/app/fiscal/devolucao/contrato";
import {textoOriginaisDaDevolucao,viewDevolucoesDaNota,type DevolucoesDaNotaView} from "../lib/nfe-devolucao-vinculo-ui";

/**
 * O vínculo nota original ↔ devolução, na ficha da nota.
 *
 * - Nota de VENDA com a devolução do Dexo (`devolucaoDisponivel`): lê o saldo
 *   (GET /fiscal/nfe/:id/devolucao/saldo, que já existia e ninguém chamava) e
 *   mostra as devoluções dela e o que ainda dá para devolver. Avisa o pai se não
 *   há mais nada a devolver (`onElegivel(false)`), para o "Devolver" sumir.
 * - Nota de DEVOLUÇÃO: lê o detalhe da devolução e diz de qual nota ela é.
 *
 * Qualquer falha (feature desligada, nota sem XML, rede) = não mostra nada:
 * a ficha fica exatamente como era.
 */
export function DevolucaoVinculo({nota,email,onElegivel}:{nota:{id:string;status:string;finalidade:string;tipoOperacao:string;devolucaoDisponivel?:boolean;numeracao?:unknown};email:string;onElegivel?:(elegivel:boolean)=>void}) {
  const [saldo,setSaldo]=useState<DevolucoesDaNotaView|null>(null);
  const [originais,setOriginais]=useState<string[]>([]);
  const ehVendaComDevolucao=nota.devolucaoDisponivel===true && nota.status==="AUTHORIZED" && nota.finalidade!=="DEVOLUCAO" && nota.tipoOperacao==="SAIDA";
  // Devolução gerenciada só existe com a numeração nova, e a linha dela traz a
  // chave `numeracao`: sem ela (empresa fora da devolução nova) nem pergunta.
  const ehDevolucao=nota.finalidade==="DEVOLUCAO" && nota.numeracao!==undefined;
  useEffect(()=>{
    if(!email || (!ehVendaComDevolucao && !ehDevolucao))return;
    let cancelado=false;
    (async()=>{try{
      if(ehVendaComDevolucao) {
        const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/${encodeURIComponent(nota.id)}/devolucao/saldo`,{headers:{email}});
        if(!r.ok || cancelado)return;
        const s=(await r.json()) as SaldoResposta;if(cancelado || !s || !Array.isArray(s.devolucoes))return;
        const v=viewDevolucoesDaNota(s);setSaldo(v);onElegivel?.(!v.totalmenteDevolvida);
      } else {
        const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft/${encodeURIComponent(nota.id)}/devolucao`,{headers:{email}});
        if(!r.ok || cancelado)return;
        const d=(await r.json()) as DevolucaoDetalhe;if(cancelado || !d || !Array.isArray(d.originais))return;
        setOriginais(textoOriginaisDaDevolucao(d));
      }
    }catch{/* silencioso: a ficha segue como era */}})();
    return()=>{cancelado=true;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[nota.id,email,ehVendaComDevolucao,ehDevolucao]);

  if(originais.length)return <section aria-label="Nota original" className="rounded-2xl border border-border/60 bg-card/80 p-4 text-sm shadow-sm">
    {originais.map((t,k)=><p key={k}>{t}</p>)}
  </section>;
  if(!saldo || (!saldo.devolucoes.length && !saldo.aviso))return null;
  return <section aria-label={saldo.titulo} className="space-y-2 rounded-2xl border border-border/60 bg-card/80 p-4 text-sm shadow-sm">
    <p className="font-medium">{saldo.titulo}</p>
    {saldo.aviso && <p className="text-amber-800">{saldo.aviso}</p>}
    {saldo.devolucoes.length>0 && <ul className="list-disc space-y-1 pl-5">{saldo.devolucoes.map(d=><li key={d.nfeId}>{d.texto}</li>)}</ul>}
    {saldo.saldo.length>0 && <div className="space-y-1 text-xs text-muted-foreground">{saldo.saldo.map((t,k)=><p key={k}>{t}</p>)}</div>}
  </section>;
}
