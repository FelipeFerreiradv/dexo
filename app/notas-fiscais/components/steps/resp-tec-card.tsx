"use client";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import { respTecBody, respTecEndpoint } from "../../lib/resp-tec-card";
import type { RespTecPublico } from "../../lib/resp-tec-card";

const LABELS = {PADRAO:"Padrão do sistema",PROVEDOR:"Provedor",PERSONALIZADO:"Personalizado",NENHUM:"Nenhum"};
export function RespTecCard({companyId,userEmail,configExists,providerName}:{companyId?:string|null;userEmail?:string|null;configExists:boolean;providerName?:string|null}) {
  const [row,setRow] = useState<RespTecPublico|null>(null);
  const [token,setToken] = useState("");
  const [remover,setRemover] = useState(false);
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const inflight = useRef(false);
  const endpoint = `${getApiBaseUrl()}${respTecEndpoint(companyId)}`;
  useEffect(() => {
    const abort = new AbortController();
    setRow(null); setToken(""); setRemover(false); setMessage("");
    if (!configExists || !userEmail) return;
    fetch(endpoint,{headers:{email:userEmail},signal:abort.signal}).then(async res => {
      if (res.status === 404) return;
      if (!res.ok) throw new Error("Não foi possível carregar o responsável técnico");
      const data = await res.json(); if (!abort.signal.aborted) setRow(data.respTec);
    }).catch(error => { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Falha ao carregar"); });
    return () => abort.abort();
  },[configExists,endpoint,userEmail]);
  if (!row && !message) return null;
  const save = async () => {
    if (!row || inflight.current) return;
    inflight.current = true; setBusy(true); setMessage("");
    try {
      const res = await fetch(endpoint,{method:"PUT",headers:{email:userEmail ?? "","Content-Type":"application/json"},body:JSON.stringify(respTecBody(row,token,remover))});
      const data = await res.json();
      if (!res.ok) throw new Error(data.detalhes?.campos ? Object.values(data.detalhes.campos).join(" ") : data.error ?? "Não foi possível salvar");
      setRow(data.respTec); setToken(""); setRemover(false); setMessage("Responsável técnico salvo.");
    } catch(error) { setMessage(error instanceof Error ? error.message : "Falha ao salvar"); }
    finally {inflight.current=false;setBusy(false);}
  };
  return <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-label="Responsável técnico">
    <h3 className="text-sm font-medium">Responsável técnico</h3>
    <p className="text-xs text-muted-foreground">Salve os dados da empresa, ambiente e provedor antes de configurar o responsável técnico.</p>
    {row && <>
      <Select value={row.modo} disabled={busy} onValueChange={modo => setRow({...row,modo})}><SelectTrigger aria-label="Modo do responsável técnico"><SelectValue/></SelectTrigger><SelectContent>{row.modosPermitidos.map(m => <SelectItem key={m} value={m}>{LABELS[m]}</SelectItem>)}</SelectContent></Select>
      {row.modo === "PERSONALIZADO" && <div className="grid gap-3 md:grid-cols-2">
        {([ ["cnpj","CNPJ"],["xContato","Contato"],["email","E-mail"],["fone","Telefone"] ] as const).map(([field,label]) => <label key={field} className="space-y-1 text-sm">{label}<Input disabled={busy} value={row[field] ?? ""} maxLength={60} onChange={e => setRow({...row,[field]:e.target.value})}/></label>)}
        {providerName === "SEFAZ_DIRECT" && <>
          <label className="space-y-1 text-sm">Identificador CSRT<Input disabled={busy} maxLength={2} value={row.idCsrt ?? ""} onChange={e => setRow({...row,idCsrt:e.target.value})}/></label>
          <label className="space-y-1 text-sm">CSRT<Input type="password" autoComplete="new-password" disabled={busy || remover} value={token} maxLength={128} placeholder={row.csrtConfigurado ? "Configurado — deixe vazio para manter" : "Informe o CSRT"} onChange={e => setToken(e.target.value)}/></label>
          {row.csrtConfigurado && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={remover} onChange={e => {setRemover(e.target.checked);setToken("");}}/>Remover CSRT salvo</label>}
        </>}
      </div>}
      {row.avisos.map(a => <p key={a.codigo} className="text-xs text-muted-foreground">{a.mensagem}</p>)}
      <Button type="button" disabled={busy} onClick={save}>{busy ? "Salvando…" : "Salvar responsável técnico"}</Button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
