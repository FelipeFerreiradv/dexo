"use client";
// React explicito, como no `pendencias-devolucao.tsx` e no `step-impostos.tsx`
// ao lado: o tsconfig usa jsx em modo preserve, entao o esbuild do vitest
// compila o JSX para o React.createElement classico e o componente so monta em
// jsdom com o React em escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {getApiBaseUrl} from "@/lib/api";
import {PendenciasDevolucao} from "./pendencias-devolucao";
import {viewPendenciasDoDetalhe} from "../lib/nfe-devolucao-pendencias-ui";
// O campo de ICMS conhece o regime da empresa (DevolucaoDetalhe.emitente) e
// recusa o codigo errado na hora. Quem decide texto, lista e veredito e o
// modulo puro ao lado — aqui so se desenha. Ver o cabecalho dele para o caso
// real da DLS AUTO PECAS (Simples Nacional digitando `00`, que e CST).
import {ESCOLHA_ANTES_DA_ALIQUOTA,SEM_ALIQUOTA,regimeDoDetalhe} from "../lib/nfe-devolucao-icms-campo";
// PIS/COFINS, CFOP e quantidade seguem o mesmo desenho: modulo puro decide,
// este arquivo desenha. O que o editor inteiro decide (linhas, corpo do PUT,
// recusa do servidor, pergunta da entrega, valores e totais) mora em
// `nfe-devolucao-editor-ui.ts` — ver o cabecalho dele para os casos da DLS.
import {ajudaPisCofinsDoDetalhe,escolhaAntesDaAliquotaPisCofins,recusasPisCofins,rotuloAliquotaPisCofins,semAliquotaPisCofins,type CampoPisCofinsView,type RecusaPisCofins} from "../lib/nfe-devolucao-pis-cofins-campo";
import {GRUPO_OUTROS,GRUPO_SUGERIDOS,campoCfop,idDestDaOriginal} from "../lib/nfe-devolucao-cfop-campo";
import {
  CFOP_FALTA_NO_PASSO_3,DESFAZER_TIRAR,DEVOLVER_TAMBEM,DICA_ALIQUOTA_COMPRA,FORA_DA_DEVOLUCAO,IPI_NAO_DEVOLVER,IPI_NAO_DEVOLVER_AVISO,NENHUMA_PECA,SAI_AO_SALVAR,
  SEM_REFERENCIA_ORIGINAL,TIRAR_DA_DEVOLUCAO,TRAVADO_IMPOSTOS,TRAVADO_PRODUTOS,VALORES_DO_ULTIMO_SALVAMENTO,
  chaveDaLinha,corpoDoItemImpostos,falhaDoSalvar,impostosDaLinha,linhaDoItem,linhaForaDaDevolucao,linhasDoDetalhe,perguntaEntrega,produtoDaLinha,
  quadroTotais,textoEscopo,tituloDaLinha,valoresDaTributacao,type FalhaSalvar,type LinhaEditor,
} from "../lib/nfe-devolucao-editor-ui";
import type {DevolucaoDetalhe,DevolucaoItemDetalhe,AtualizarItemBody} from "@/app/fiscal/devolucao/contrato";

/**
 * Explicit saves: this editor never mirrors server state into RHF through effects.
 *
 * As linhas do estado sao casadas com as do servidor pela CHAVE (nota + item da
 * nota original), nunca pela posicao: zerar uma peca e salvar derrubava a tela
 * inteira (`value.itens[index]` indefinido — DLS, 24/09, cinco vezes). Depois de
 * salvar, o estado e refeito a partir da resposta ANTES de avisar o wizard, no
 * mesmo tick; a peca que saiu continua na tela, com como voltar.
 */
export function DevolucaoEditor({value,email,onSaved,step,onDirtyChange}:{value:DevolucaoDetalhe;email:string;onSaved:(d:DevolucaoDetalhe)=>Promise<void>;step:number;
  /** true = ha edicao nao salva neste passo; false depois de salvar ou desfazer (e ao sair do passo). O wizard usa para nao descartar edicao sem perguntar. */
  onDirtyChange?:(sujo:boolean)=>void}) {
  const [linhas,setLinhas]=useState<Record<string,LinhaEditor>>(()=>linhasDoDetalhe(value));
  // Pecas que sairam da devolucao ao salvar NESTA visita: o detalhe do servidor
  // nao as traz mais, e sem elas a peca tirada nao tinha como voltar.
  const [fora,setFora]=useState<DevolucaoItemDetalhe[]>([]);
  // Tres estados: sim, nao e SEM RESPOSTA (null). A caixinha de antes
  // transformava "nao respondi" em "nao" — e isso trava a emissao como recusa.
  const [entregue,setEntregue]=useState<boolean|null>(value.devolvidaAposEntrega??null);
  const [message,setMessage]=useState("");const [falha,setFalha]=useState<FalhaSalvar|null>(null);
  const [busy,setBusy]=useState(false);const pending=useRef(false);
  const modo=step===1?"entrega":step===3?"produtos":"impostos";
  const regime=regimeDoDetalhe(value.emitente);
  const itens=Array.isArray(value.itens)?value.itens:[];
  const chaves=new Set(itens.map(i=>chaveDaLinha(i.chaveAcesso,i.nItem)));
  const foraVisiveis=fora.filter(i=>!chaves.has(chaveDaLinha(i.chaveAcesso,i.nItem)));

  const produtos=[...itens.map(item=>({item,naDevolucao:true})),...foraVisiveis.map(item=>({item,naDevolucao:false}))].map(({item,naDevolucao})=>{
    const k=chaveDaLinha(item.chaveAcesso,item.nItem);
    const linha=linhas[k]??(naDevolucao?linhaDoItem(item):linhaForaDaDevolucao(item));
    return {k,item,naDevolucao,linha,produto:produtoDaLinha({linha,item,naDevolucao})};
  });
  const impostos=itens.map(item=>{
    const k=chaveDaLinha(item.chaveAcesso,item.nItem);const linha=linhas[k]??linhaDoItem(item);
    return {k,item,linha,imp:impostosDaLinha({linha,item,emitente:value.emitente,tipo:value.tipo})};
  });
  const corposProdutos=produtos.map(p=>p.produto.corpo).filter((c):c is AtualizarItemBody=>c!==null);
  const nenhumaPeca=modo==="produtos" && corposProdutos.length===0 && !produtos.some(p=>p.produto.bloqueia);
  const travado=modo==="produtos"?nenhumaPeca || produtos.some(p=>p.produto.bloqueia):modo==="impostos"?impostos.some(x=>x.imp.bloqueiaSalvar):false;
  const sujo=modo==="entrega"?entregue!==(value.devolvidaAposEntrega??null):modo==="produtos"?produtos.some(p=>p.produto.mudou):impostos.some(x=>x.imp.mudou);

  // O wizard fica sabendo quando ha edicao nao salva (e quando deixa de haver),
  // para Proximo, Voltar e o clique num passo nao a descartarem sem perguntar.
  const avisar=useRef(onDirtyChange);avisar.current=onDirtyChange;
  const avisado=useRef(false);
  useEffect(()=>{if(avisado.current!==sujo){avisado.current=sujo;avisar.current?.(sujo);}},[sujo]);
  useEffect(()=>()=>{if(avisado.current){avisado.current=false;avisar.current?.(false);}},[]);

  const mudar=(item:DevolucaoItemDetalhe,naDevolucao:boolean,patch:Partial<LinhaEditor>)=>{
    const k=chaveDaLinha(item.chaveAcesso,item.nItem);
    setLinhas(old=>({...old,[k]:{...(old[k]??(naDevolucao?linhaDoItem(item):linhaForaDaDevolucao(item))),...patch}}));
  };
  // Mexer em qualquer imposto desfaz a revisao: ela confirmou OUTRO valor.
  const mudarImposto=(item:DevolucaoItemDetalhe,patch:Partial<LinhaEditor>)=>mudar(item,true,{...patch,confirmar:false});

  const pecas=(modo==="produtos"?produtos.map(p=>p.item):itens).map(i=>({chaveAcesso:i.chaveAcesso,nItem:i.nItem,ordem:chaves.has(chaveDaLinha(i.chaveAcesso,i.nItem))?i.ordem:null,codigo:i.codigo}));
  const save=async()=>{
    if(pending.current||travado)return;pending.current=true;setBusy(true);setMessage("");setFalha(null);
    // O corpo sai do que a TELA mostra, montado agora: codigo e aliquota juntos.
    const enviado:AtualizarItemBody[]=modo==="produtos"?corposProdutos:modo==="impostos"?impostos.map(x=>corpoDoItemImpostos({linha:x.linha,item:x.item,impostos:x.imp})):[];
    const antes=[...itens,...foraVisiveis];
    try {
      const path=`${getApiBaseUrl()}/fiscal/nfe/draft/${value.draftId}/devolucao`;
      // Sem resposta, o campo NAO vai: o servidor mantem o que esta gravado.
      const corpo=modo==="entrega"?(entregue===null?{}:{devolvidaAposEntrega:entregue}):{itens:enviado};
      const res=await fetch(modo==="entrega"?path:`${path}/itens`,{method:"PUT",headers:{email,"Content-Type":"application/json"},body:JSON.stringify(corpo)});
      const data:unknown=await res.json().catch(()=>null);
      // A recusa com a frase do servidor por peca e por campo (antes: so `data.error`).
      if(!res.ok){setFalha(falhaDoSalvar({corpo:data,enviado,pecas,passo:step}));return;}
      const d=data as DevolucaoDetalhe;
      if(!d || !Array.isArray(d.itens))throw new Error("Não foi possível salvar");
      // Ressincroniza ANTES do `onSaved`, sem `await` no meio: o React junta com o
      // `setDevolucao` do wizard numa renderizacao so.
      const novas=linhasDoDetalhe(d);
      const sairam=antes.filter(i=>!(chaveDaLinha(i.chaveAcesso,i.nItem) in novas));
      for(const i of sairam)novas[chaveDaLinha(i.chaveAcesso,i.nItem)]=linhaForaDaDevolucao(i);
      setLinhas(novas);setFora(sairam);setEntregue(d.devolvidaAposEntrega??null);setMessage("Devolução salva");
      await onSaved(d);
    }catch(e){setMessage(e instanceof Error?e.message:"Não foi possível salvar");}
    finally{pending.current=false;setBusy(false);}
  };
  const desfazer=()=>{
    const novas=linhasDoDetalhe(value);for(const i of foraVisiveis)novas[chaveDaLinha(i.chaveAcesso,i.nItem)]=linhaForaDaDevolucao(i);
    setLinhas(novas);setEntregue(value.devolvidaAposEntrega??null);setFalha(null);setMessage("");
  };
  const pergunta=perguntaEntrega(value.tipo);
  const totais=modo==="entrega"?null:quadroTotais(value.totais);
  const idDestDe=(i:DevolucaoItemDetalhe)=>idDestDaOriginal(value.originais,i.chaveAcesso,i.cfopOpcoes??[]);

  return <section className="space-y-4 rounded-lg border p-4" aria-label="Devolução fiscal">
    <p className="font-medium">Devolução {value.tipo==="VENDA_ENTRADA"?"de venda (entrada)":"de compra (saída)"}</p>
    <p className="text-sm text-muted-foreground">Operação exclusivamente fiscal. O estoque não será alterado.</p>
    {value.originais.map(o=><p key={o.chaveAcesso} className="break-all text-xs">NF-e {o.numero}/{o.serie} — {o.chaveAcesso}</p>)}
    {modo==="entrega"?<>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{pergunta.pergunta}</legend>
        <label className="flex gap-2"><input type="radio" name={`entrega-${value.draftId}`} checked={entregue===true} onChange={()=>setEntregue(true)}/>{pergunta.sim}</label>
        <label className="flex gap-2"><input type="radio" name={`entrega-${value.draftId}`} checked={entregue===false} onChange={()=>setEntregue(false)}/>{pergunta.nao}</label>
        {entregue===null && <p className="text-xs text-amber-800">{pergunta.semResposta}</p>}
        {entregue===false && <p className="text-xs text-amber-800">{pergunta.seNao}</p>}
      </fieldset>
      <p className="text-sm text-muted-foreground">{textoEscopo(value.escopo)}</p>
    </>:modo==="produtos"?<>
      {produtos.map(({k,item,naDevolucao,linha,produto})=>{
        const {titulo,origem}=tituloDaLinha({ordem:naDevolucao?item.ordem:null,codigo:item.codigo,descricao:item.descricao,nItem:item.nItem});
        const cfop=campoCfop({tipo:value.tipo,crt:regime.crt,idDest:idDestDe(item),sugeridos:item.cfopOpcoes,cfop:linha.cfop,cfopOriginal:item.cfopOriginal});
        return <div key={k} data-linha={k} className="space-y-2 rounded border p-3">
          <p className="font-medium">{titulo}</p><p className="text-xs text-muted-foreground">{origem}</p>
          <p className="text-xs">Disponível para devolver: {item.disponivel??"não informado"}</p>
          {cfop.referencia!=="" && <p className="text-xs">{cfop.referencia}</p>}
          {linha.tirada?<div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">{naDevolucao?SAI_AO_SALVAR:FORA_DA_DEVOLUCAO}</p>
            <Button type="button" variant="outline" size="sm" onClick={()=>mudar(item,naDevolucao,{tirada:false,quantidadeTexto:linha.quantidadeTexto.trim()!==""&&linha.quantidadeTexto.trim()!=="0"?linha.quantidadeTexto:linhaDoItem(item).quantidadeTexto})}>{naDevolucao?DESFAZER_TIRAR:DEVOLVER_TAMBEM}</Button>
          </div>:<div className="flex flex-wrap items-end gap-3">
            <label>Quantidade<Input type="text" inputMode="decimal" aria-label="Quantidade" aria-invalid={produto.quantidade.bloqueia} value={linha.quantidadeTexto} onChange={e=>mudar(item,naDevolucao,{quantidadeTexto:e.target.value})}/></label>
            <label>CFOP<select className="w-full rounded border p-2" aria-label="CFOP de devolução" aria-invalid={produto.erroCfop!==""} value={cfop.valor} onChange={e=>mudar(item,naDevolucao,{cfop:e.target.value})}>
              <option value="">{cfop.placeholder}</option>
              {cfop.gravadoForaDaLista && <option value={cfop.gravadoForaDaLista.codigo}>{cfop.gravadoForaDaLista.rotulo}</option>}
              {cfop.sugeridos.length>0 && <optgroup label={GRUPO_SUGERIDOS}>{cfop.sugeridos.map(o=><option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}</optgroup>}
              {cfop.outros.length>0 && <optgroup label={GRUPO_OUTROS}>{cfop.outros.map(o=><option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}</optgroup>}
            </select></label>
            <Button type="button" variant="ghost" size="sm" onClick={()=>mudar(item,naDevolucao,{tirada:true})}>{TIRAR_DA_DEVOLUCAO}</Button>
          </div>}
          {!linha.tirada && produto.quantidade.mensagem!=="" && <p className={`text-xs ${produto.quantidade.bloqueia?"text-red-700":"text-amber-800"}`}>{produto.quantidade.mensagem}</p>}
          {!linha.tirada && produto.erroCfop!=="" && <p className="text-xs text-red-700">{produto.erroCfop}</p>}
          <FrasesDoServidor frases={falha?.porLinha[k]}/>
        </div>;
      })}
      {nenhumaPeca && <p className="text-sm text-red-700">{NENHUMA_PECA}</p>}
    </>:<>
      {/* O regime da empresa dito UMA vez, antes dos itens: e ele que decide se
          o codigo do ICMS aqui e CSOSN (3 digitos) ou CST (2) — e se o PIS/COFINS
          pode usar os codigos 01/02, do regime normal. */}
      <p className="text-sm text-muted-foreground">{regime.ajuda}</p>
      {ajudaPisCofinsDoDetalhe(value.emitente)!=="" && <p className="text-sm text-muted-foreground">{ajudaPisCofinsDoDetalhe(value.emitente)}</p>}
      {impostos.map(({k,item,linha,imp})=>{
        const campo=imp.icms;
        const {titulo,origem}=tituloDaLinha({ordem:item.ordem,codigo:item.codigo,descricao:item.descricao,nItem:item.nItem});
        const ref=item.referenciaOriginal;
        return <div key={k} data-linha={k} className="space-y-2 rounded border p-3">
          <p className="font-medium">{titulo}</p><p className="text-xs text-muted-foreground">{origem}</p>
          {(linha.cfop||item.cfop||"").trim()==="" && <p className="text-xs text-amber-800">{CFOP_FALTA_NO_PASSO_3}</p>}
          {/* O imposto da nota original, na proporcao devolvida: o numero herdado
              deixa de ser implicito ("Na nota do fornecedor: CST 00 · base … · 12%"). */}
          {ref!==undefined && <div className="space-y-0.5 text-xs text-muted-foreground" aria-label="Imposto da nota original">
            {ref?[ref.frases.icms,ref.frases.pis,ref.frases.cofins,ref.frases.ipi].filter(f=>typeof f==="string" && f!=="").map(f=><p key={f}>{f}</p>):<p>{SEM_REFERENCIA_ORIGINAL}</p>}
          </div>}
          {/* O valor que veio da nota original pode ser de OUTRO regime (foi o caso:
              CST de uma distribuidora do regime normal numa devolucao do Simples).
              A tela diz que nao serve e por que — e nao escolhe nada no lugar dela. */}
          {campo.precisaEscolher && <Recusa titulo={campo.titulo} motivo={campo.motivo} origem={campo.origem} comoResolver={campo.comoResolver}/>}
          {recusasPisCofins(imp.pis,imp.cofins).map((r,i)=><Recusa key={i} {...r}/>)}
          <div className="grid grid-cols-3 gap-3">
            <label className="block">{campo.rotulo}<select className="w-full rounded border p-2" aria-label={campo.rotulo} value={campo.valor} onChange={e=>mudarImposto(item,{icms:e.target.value})}><option value="">{campo.placeholder}</option>{campo.opcoes.map(o=><option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}</select></label>
            <SeletorPisCofins campo={imp.pis} aoEscolher={v=>mudarImposto(item,{pis:v})}/>
            <SeletorPisCofins campo={imp.cofins} aoEscolher={v=>mudarImposto(item,{cofins:v})}/>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">ICMS alíquota (%){campo.precisaEscolher
              ?<p className="text-xs text-muted-foreground">{ESCOLHA_ANTES_DA_ALIQUOTA}</p>
              :campo.exigeAliquota
                ?<><Input type="number" min="0" max="100" step="0.01" aria-label="ICMS alíquota (%)" aria-invalid={imp.erros.icms!==""} value={imp.pIcmsTexto} onChange={e=>mudarImposto(item,{pIcms:e.target.value})}/>
                  {value.tipo==="COMPRA_SAIDA" && <span className="block text-xs text-muted-foreground">{DICA_ALIQUOTA_COMPRA}</span>}</>
                :<p className="text-xs text-muted-foreground">{SEM_ALIQUOTA}</p>}
              {imp.erros.icms!=="" && <span className="block text-xs text-red-700">{imp.erros.icms}</span>}</label>
            <AliquotaPisCofins campo={imp.pis} texto={imp.pPisTexto} erro={imp.erros.pis} aoMudar={v=>mudarImposto(item,{pPis:v})}/>
            <AliquotaPisCofins campo={imp.cofins} texto={imp.pCofinsTexto} erro={imp.erros.cofins} aoMudar={v=>mudarImposto(item,{pCofins:v})}/>
          </div>
          {imp.ipi.tem && <div className="space-y-0.5">
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={imp.ipi.retirado} onChange={e=>mudarImposto(item,{ipiRetirar:e.target.checked})}/>{IPI_NAO_DEVOLVER}</label>
            <p className="text-xs text-amber-800">{IPI_NAO_DEVOLVER_AVISO}</p>
          </div>}
          {/* Os valores que vao sair na nota, do ULTIMO salvamento (quem calcula e
              o servidor). "Revisei" confirmava numeros que ela nunca via. */}
          <div className="rounded bg-muted/40 p-2 text-xs" aria-label="Valores deste item na nota">
            <p className="font-medium">Como este item vai sair na nota</p>
            <ul>{valoresDaTributacao(item.tributacao).map(v=><li key={v.tributo}>{v.tributo}: {v.texto}</li>)}</ul>
            {imp.mudou && <p className="text-amber-800">{VALORES_DO_ULTIMO_SALVAMENTO}</p>}
          </div>
          <label className="flex gap-2"><input type="checkbox" disabled={imp.bloqueioRevisao!==""} checked={imp.confirmar} onChange={e=>mudar(item,true,{confirmar:e.target.checked})}/>Revisei a tributação deste item</label>
          {imp.bloqueioRevisao!=="" && <p className="text-xs text-amber-800">{imp.bloqueioRevisao}</p>}
          <FrasesDoServidor frases={falha?.porLinha[k]}/>
        </div>;
      })}
    </>}
    {totais && <div className="space-y-1 rounded border p-3 text-sm" aria-label={totais.titulo}>
      <p className="font-medium">{totais.titulo}</p>
      {totais.previa!=="" && <p className="text-xs text-amber-800">{totais.previa}</p>}
      {sujo && <p className="text-xs text-muted-foreground">Valores do último salvamento: salve para atualizar.</p>}
      <dl className="grid grid-cols-[auto_auto] justify-between gap-x-6">{totais.nota.map(l=><React.Fragment key={l.rotulo}><dt className={l.destaque?"font-semibold":""}>{l.rotulo}</dt><dd className={`text-right ${l.destaque?"font-semibold":""}`}>{l.valor}</dd></React.Fragment>)}</dl>
      <p className="pt-1 text-xs text-muted-foreground">Impostos destacados (não somam de novo ao valor da nota):</p>
      <dl className="grid grid-cols-[auto_auto] justify-between gap-x-6 text-xs">{totais.impostos.map(l=><React.Fragment key={l.rotulo}><dt>{l.rotulo}</dt><dd className="text-right">{l.valor}</dd></React.Fragment>)}</dl>
    </div>}
    {/* A prévia do MESMO `validarDevolucao` que recusa a emissão depois. Era
        uma pilha de <p> sem hierarquia, uma por item, em que "Item 1: revise e
        confirme a tributação." aparecia seis vezes quase igual; agora agrupa,
        diz em quais itens está e o que fazer (lib/nfe-devolucao-pendencias-ui). */}
    {value.issues.length>0 && <PendenciasDevolucao view={viewPendenciasDoDetalhe(value)}/>}
    {falha && <div role="alert" aria-label="Não foi possível salvar" className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-800">
      <p className="font-semibold">{falha.mensagem}</p>
      {falha.gerais.map(g=><p key={g}>{g}</p>)}
      {Object.keys(falha.porLinha).length>0 && <p className="text-xs">O que o Dexo recusou está escrito embaixo de cada peça.</p>}
    </div>}
    {falha?.pendencias && <PendenciasDevolucao view={falha.pendencias}/>}
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" disabled={busy || travado} onClick={save}>{busy?"Salvando…":"Salvar devolução"}</Button>
      {sujo && !busy && <Button type="button" variant="outline" onClick={desfazer}>Desfazer alterações</Button>}
    </div>
    {travado && modo==="produtos" && !nenhumaPeca && <p className="text-xs text-red-700">{TRAVADO_PRODUTOS}</p>}
    {travado && modo==="impostos" && <p className="text-xs text-red-700">{TRAVADO_IMPOSTOS}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function Recusa({titulo,motivo,origem,comoResolver}:RecusaPisCofins) {
  return <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800">
    {titulo!=="" && <p className="text-sm font-semibold">{titulo}</p>}
    {motivo!=="" && <p className="text-sm">{motivo}</p>}
    {origem!=="" && <p className="text-xs">{origem}</p>}
    <p className="text-sm">{comoResolver}</p>
  </div>;
}

function SeletorPisCofins({campo,aoEscolher}:{campo:CampoPisCofinsView;aoEscolher:(v:string)=>void}) {
  return <label className="block">{campo.rotulo}
    <select className="w-full rounded border p-2" aria-label={campo.rotulo} value={campo.valor} onChange={e=>aoEscolher(e.target.value)}>
      <option value="">{campo.placeholder}</option>
      {campo.grupos.map(g=><optgroup key={g.rotulo} label={g.rotulo}>{g.opcoes.map(o=><option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}</optgroup>)}
    </select>
    {/* Sentido trocado (CST de entrada numa nota de saída) não impede: avisa junto do campo. */}
    {campo.avisoTexto!=="" && <span className="block text-xs text-blue-700">{campo.avisoTexto}</span>}
  </label>;
}

function AliquotaPisCofins({campo,texto,erro,aoMudar}:{campo:CampoPisCofinsView;texto:string;erro:string;aoMudar:(v:string)=>void}) {
  const rotulo=rotuloAliquotaPisCofins(campo.tributo);
  return <label className="block">{rotulo}{campo.precisaEscolher
    ?<p className="text-xs text-muted-foreground">{escolhaAntesDaAliquotaPisCofins(campo.tributo)}</p>
    :campo.exigeAliquota
      // Controlada: mostra EXATAMENTE o que vai no corpo (era `defaultValue`, e a tela mostrava 1,65% com 0% gravado).
      ?<Input type="number" min="0" max="100" step="0.01" aria-label={rotulo} aria-invalid={erro!==""} value={texto} onChange={e=>aoMudar(e.target.value)}/>
      :<p className="text-xs text-muted-foreground">{semAliquotaPisCofins(campo.tributo)}</p>}
    {erro!=="" && <span className="block text-xs text-red-700">{erro}</span>}
  </label>;
}

function FrasesDoServidor({frases}:{frases?:string[]}) {
  if(!frases || frases.length===0)return null;
  return <ul className="list-disc space-y-0.5 pl-5 text-xs text-red-700" aria-label="Recusado pelo Dexo">{frases.map(f=><li key={f}>{f}</li>)}</ul>;
}
