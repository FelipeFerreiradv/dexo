"use client";
// React explicito, como no `devolucao-editor.tsx` ao lado: o tsconfig usa jsx em
// modo preserve, entao o esbuild do vitest compila o JSX para o
// React.createElement classico e o componente so monta em jsdom com o React em
// escopo. Em producao o Next segue com o runtime automatico.
import * as React from "react";
import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {getApiBaseUrl} from "@/lib/api";
import type {TipoDevolucao} from "@/app/fiscal/devolucao/tipos";
// Do contrato (módulo puro), e não do caso de uso: a tela não puxa código de servidor.
import type {PreviaDevolucaoManual} from "@/app/fiscal/devolucao/contrato";
import {urlRascunhoDevolucao} from "../lib/nfe-devolucao-wizard-ui";
import {navegarPara} from "../lib/nfe-navegacao";
// A devolução está ligada? Em quais empresas? A MESMA pergunta do quadro
// "Devoluções em andamento" (dividida quando os dois montam juntos).
import {ESCOLHA_A_EMPRESA,ROTULO_EMPRESA,consultarDisponibilidade,precisaEscolherEmpresa,rotuloEmpresa,type DisponibilidadeLida} from "../lib/nfe-devolucao-disponibilidade-ui";
// Texto, números, chave e erros: tudo decidido no módulo puro ao lado (testado
// em node). Aqui só se desenha. Ver o cabeçalho dele para o que a DLS passou.
import {
  AJUDA_ORIGEM,
  AVISO_PELA_CHAVE_PREENCHIDA,
  CONFIRA_OS_CAMPOS,
  DESTINATARIO_TRAVADO_PELA_CHAVE,
  ESCOLHA_UMA_PECA,
  LINHA_VAZIA,
  OPCAO_COM_XML,
  OPCAO_SO_CHAVE,
  ORIGENS_MERCADORIA,
  PLACEHOLDER_ORIGEM,
  ROTULO_COMO_INFORMAR,
  ROTULO_ORIGEM,
  ROTULO_QUANTIDADE_ORIGINAL,
  avisoCfop,
  avisoRascunhoAberto,
  conferirChaveDigitada,
  descricaoSaldo,
  destinatarioPelaChave,
  errosDoCampo,
  errosDoItemXml,
  errosSemCampoNaTela,
  itensMarcados,
  lerErrosDaResposta,
  lerItensDigitados,
  linhasDaNota,
  notaParaDevolverPelaChave,
  selecaoInicial,
  semSaldo,
  type ErroCampoTela,
  type LinhaItemDigitado,
  type SelecaoItem,
} from "../lib/nfe-devolucao-manual-ui";

/** Teto do XML (1 MiB), o mesmo do servidor. */
const MAX_XML=1_048_576;
export const XML_GRANDE_DEMAIS="O XML precisa ter até 1 MB. Confira se escolheu o arquivo da nota (o .xml), e não um PDF ou um .zip.";
export const PREVIA_INDISPONIVEL="Não deu para listar as peças desta nota agora. Se criar assim, a devolução começa com as peças que ainda podem ser devolvidas, e você ajusta no passo Produtos.";

const CAMPOS_ITEM=["nItem","codigo","descricao","ncm","unidade","cfopOriginal","valorUnitario","quantidade","quantidadeOriginal"] as const;
const ROTULOS_ITEM:Record<(typeof CAMPOS_ITEM)[number],string>={nItem:"Item na nota original",codigo:"Código",descricao:"Descrição",ncm:"NCM",unidade:"Unidade",cfopOriginal:"CFOP na nota original",valorUnitario:"Valor unitário (R$)",quantidade:"Quantidade que volta",quantidadeOriginal:ROTULO_QUANTIDADE_ORIGINAL};
/** Texto de cima do quadro: o que cada caminho faz, sem "XML autorizado" sem explicação. */
export const INTRO_DEVOLUCAO_MANUAL="Com o arquivo XML da nota original, o Dexo lista as peças e confere o que ainda pode ser devolvido. Sem o XML, informe a chave de acesso e as peças à mão. Depois, confira tudo no assistente antes de emitir.";
export const CONFIRMA_SEM_XML="Entendo que, sem o XML, o Dexo não confere quanto desta nota ainda pode ser devolvido, e vou conferir os impostos no passo Impostos";

function Erros({mensagens}:{mensagens:string[]}) {
  if(!mensagens.length)return null;
  return <>{mensagens.map((m,k)=><p key={k} role="alert" className="text-xs text-destructive">{m}</p>)}</>;
}

export function DevolucaoManual({email}:{email:string}) {
  // `disp` = a devolução está ligada e em quais empresas; `config` = a empresa
  // que emite ESTA devolução (a padrão ligada, a única ligada, ou a que ela
  // escolher no seletor quando há mais de uma).
  const [disp,setDisp]=useState<DisponibilidadeLida|null>(null);
  const [config,setConfig]=useState<string|null>(null);const [open,setOpen]=useState(false);
  const [modo,setModo]=useState<"XML"|"CHAVE">("XML");const [tipo,setTipo]=useState<TipoDevolucao>("COMPRA_SAIDA");
  const [xml,setXml]=useState("");const [previa,setPrevia]=useState<PreviaDevolucaoManual|null>(null);const [previaFalhou,setPreviaFalhou]=useState(false);const [lendo,setLendo]=useState(false);
  const [selecao,setSelecao]=useState<Record<number,SelecaoItem>>({});const [errosSelecao,setErrosSelecao]=useState<Record<number,string>>({});
  const [chave,setChave]=useState("");const [confirmado,setConfirmado]=useState(false);const [nome,setNome]=useState("");const [doc,setDoc]=useState("");const [uf,setUf]=useState("");
  const [linhas,setLinhas]=useState<LinhaItemDigitado[]>([{...LINHA_VAZIA}]);const [preenchida,setPreenchida]=useState(false);
  const pending=useRef(false);const [busy,setBusy]=useState(false);
  const [erroGeral,setErroGeral]=useState("");const [erros,setErros]=useState<ErroCampoTela[]>([]);
  const seqPrevia=useRef(0);const prefillFeito=useRef(false);
  useEffect(()=>{
    let cancelado=false;
    if(email)void consultarDisponibilidade({base:getApiBaseUrl(),email}).then(d=>{if(cancelado)return;setDisp(d);setConfig(d.companyFiscalConfigId);});
    return()=>{cancelado=true;};
  },[email]);
  // "Devolver pela chave" numa venda sem XML guardado: a lista abre com
  // ?devolverPelaChave=<id> e o quadro já vem preenchido com a chave, o cliente
  // e as peças dessa venda (nItem = número do item na nota) — e, com mais de um
  // CNPJ, com a empresa que emitiu essa venda.
  const ligada=disp?.ligada===true;
  useEffect(()=>{
    if(!ligada || !email || prefillFeito.current || typeof window==="undefined")return;
    const id=notaParaDevolverPelaChave(window.location.search);if(!id)return;
    prefillFeito.current=true;
    (async()=>{try{
      const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/${encodeURIComponent(id)}`,{headers:{email}});if(!r.ok)return;
      const nfe=(await r.json())?.nfe;if(!nfe)return;
      const dest=nfe.destinatarioJson??{};
      // A empresa da venda, se a devolução estiver ligada nela: a devolução de
      // venda sai do MESMO CNPJ que vendeu.
      if(typeof nfe.companyFiscalConfigId==="string" && disp?.empresas.some(e=>e.companyFiscalConfigId===nfe.companyFiscalConfigId))setConfig(nfe.companyFiscalConfigId);
      setOpen(true);setModo("CHAVE");setTipo("VENDA_ENTRADA");setChave(nfe.chaveAcesso??"");
      setNome(dest.nome??"");setDoc(dest.cpfCnpj??"");setUf((dest.uf??"").toUpperCase());
      if(Array.isArray(nfe.itens) && nfe.itens.length)setLinhas(linhasDaNota(nfe.itens));
      setPreenchida(true);
    }catch{/* sem prefill: o quadro segue vazio, como antes */}})();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[ligada,email]);
  if(!disp || !ligada)return null;
  const escolherEmpresa=precisaEscolherEmpresa(disp);

  const limparErros=()=>{setErroGeral("");setErros([]);setErrosSelecao({});};
  const carregarPrevia=async(texto:string,t:TipoDevolucao,empresa:string|null=config)=>{
    const seq=++seqPrevia.current;setLendo(true);setPrevia(null);setPreviaFalhou(false);setSelecao({});
    try{
      const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/devolucao/manual/previa`,{method:"POST",headers:{email,"Content-Type":"application/json"},body:JSON.stringify({companyFiscalConfigId:empresa,tipo:t,xmlOriginal:texto})});
      const d=await r.json().catch(()=>({}));if(seq!==seqPrevia.current)return;
      if(r.ok && Array.isArray(d?.itens)){setPrevia(d);setSelecao(selecaoInicial(d));return;}
      // 400/422 dizem o que está errado no arquivo: mesma tela de erro da criação.
      if(r.status===400 || r.status===409 || r.status===422){const e=lerErrosDaResposta(d,"Não foi possível ler este XML.");setErroGeral(e.geral);setErros(e.campos);return;}
      setPreviaFalhou(true);
    }catch{if(seq===seqPrevia.current)setPreviaFalhou(true);}
    finally{if(seq===seqPrevia.current)setLendo(false);}
  };
  const escolherArquivo=async(file:File|undefined)=>{
    limparErros();setPrevia(null);setPreviaFalhou(false);setSelecao({});
    if(!file){setXml("");return;}
    if(file.size>MAX_XML){setXml("");setErroGeral(XML_GRANDE_DEMAIS);return;}
    const texto=await file.text();setXml(texto);await carregarPrevia(texto,tipo);
  };
  const trocarTipo=(t:TipoDevolucao)=>{setTipo(t);limparErros();if(modo==="XML" && xml)void carregarPrevia(xml,t);};
  // Outra empresa: a prévia muda (o rascunho aberto e o saldo são por empresa).
  const trocarEmpresa=(id:string|null)=>{setConfig(id);limparErros();if(id && modo==="XML" && xml)void carregarPrevia(xml,tipo,id);else{setPrevia(null);setSelecao({});}};

  const chaveView=conferirChaveDigitada(chave);
  // Devolução de COMPRA: o destinatário é o fornecedor que emitiu a nota — CNPJ
  // e UF saem da chave e ficam travados (digitar outro dava Rejeição 1194).
  const travadoPelaChave=tipo==="COMPRA_SAIDA";
  const pelaChave=travadoPelaChave?destinatarioPelaChave(chave):null;
  const docTela=travadoPelaChave?(pelaChave?.cpfCnpj??""):doc;const ufTela=travadoPelaChave?(pelaChave?.uf??""):uf;

  const enviar=async(corpo:Record<string,unknown>)=>{
    const r=await fetch(`${getApiBaseUrl()}/fiscal/nfe/devolucao/manual`,{method:"POST",headers:{email,"Content-Type":"application/json"},body:JSON.stringify(corpo)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok || typeof d?.draftId!=="string"){const e=lerErrosDaResposta(d);setErroGeral(e.geral);setErros(e.campos);return;}
    navegarPara(urlRascunhoDevolucao(d.draftId,d.reutilizado===true));
  };
  const criar=async()=>{
    if(pending.current)return;limparErros();
    let corpo:Record<string,unknown>;
    if(modo==="XML") {
      if(!xml){setErroGeral("Escolha o arquivo XML da nota.");return;}
      corpo={companyFiscalConfigId:config,tipo,xmlOriginal:xml};
      if(previa) {
        const sel=itensMarcados(previa,selecao);
        if(!sel.ok){if(sel.nenhum)setErroGeral(sel.mensagem);else{setErrosSelecao(sel.porItem);setErroGeral(CONFIRA_OS_CAMPOS);}return;}
        corpo.itens=sel.itens;
      }
    } else {
      const lidos=lerItensDigitados(linhas);const locais:ErroCampoTela[]=[...lidos.erros];
      if(!chaveView.ok)locais.push({campo:"chaveAcesso",mensagem:chaveView.mensagem||"Informe a chave de acesso."});
      if(nome.trim()==="")locais.push({campo:"destinatario.nome",mensagem:"Informe o nome de quem recebe a devolução."});
      if(!travadoPelaChave && doc.replace(/\D/g,"")==="")locais.push({campo:"destinatario.cpfCnpj",mensagem:"Informe o CPF ou o CNPJ do cliente."});
      if(!confirmado)locais.push({campo:"confirmarSemXml",mensagem:"Marque a confirmação: sem o XML, o Dexo não confere o saldo da nota original."});
      if(locais.length){setErros(locais);setErroGeral(CONFIRA_OS_CAMPOS);return;}
      const docEnvio=travadoPelaChave?(pelaChave?.cpfCnpj??""):doc;
      const tipoPessoa=travadoPelaChave?(pelaChave?.tipoPessoa??"PJ"):(docEnvio.replace(/\D/g,"").length===11?"PF":"PJ");
      corpo={companyFiscalConfigId:config,tipo,chaveAcesso:chaveView.chave,confirmarSemXml:confirmado,itens:lidos.itens,
        destinatario:{tipoPessoa,cpfCnpj:docEnvio,nome:nome.trim(),uf:(travadoPelaChave?(pelaChave?.uf??""):uf).trim().toUpperCase()||null}};
    }
    pending.current=true;setBusy(true);
    try{await enviar(corpo);}catch{setErroGeral("Não foi possível criar a devolução. Confira a conexão e tente de novo.");}
    finally{pending.current=false;setBusy(false);}
  };

  // Tudo o que o servidor apontar e não tiver um campo na tela vai para a lista
  // geral — nenhum motivo se perde (era o "Dados da requisição inválidos." mudo).
  const campoNaTela=(campo:string)=>modo==="XML"
    ?campo==="xmlOriginal" || /^itens\[\d+\]/.test(campo)
    :["chaveAcesso","destinatario","destinatario.nome","destinatario.cpfCnpj","destinatario.uf","confirmarSemXml","itens"].includes(campo) || /^itens\[\d+\]/.test(campo);
  const soltos=errosSemCampoNaTela(erros,campoNaTela);
  const podeCriarXml=!!xml && !lendo && (previa?(previa.rascunhoAberto===null):true);

  return <section className="space-y-3"><Button type="button" variant="outline" onClick={()=>setOpen(v=>!v)}>Devolução manual</Button>{open&&<div className="space-y-3 rounded border p-4" aria-label="Devolução manual">
    <p>{INTRO_DEVOLUCAO_MANUAL}</p>
    {/* Mais de um CNPJ com a devolução ligada: ela diz qual empresa emite (o
        Dexo não escolhe). Com um só, o seletor nem aparece. */}
    {escolherEmpresa && <label className="block">{ROTULO_EMPRESA} <select value={config??""} onChange={e=>trocarEmpresa(e.target.value||null)}>
      <option value="">{ESCOLHA_A_EMPRESA}</option>
      {disp.empresas.map(e=><option key={e.companyFiscalConfigId} value={e.companyFiscalConfigId}>{rotuloEmpresa(e)}</option>)}
    </select></label>}
    {!config?<p className="text-sm text-amber-800">Escolha acima a empresa que emite esta devolução: o resto do quadro aparece em seguida.</p>:<>
    <label>Operação <select value={tipo} onChange={e=>trocarTipo(e.target.value as TipoDevolucao)}><option value="COMPRA_SAIDA">Devolução de compra (a peça volta para o fornecedor)</option><option value="VENDA_ENTRADA">Devolução de venda (o cliente devolveu a peça)</option></select></label>
    <label className="block">{ROTULO_COMO_INFORMAR} <select value={modo} onChange={e=>{setModo(e.target.value as "XML"|"CHAVE");limparErros();}}><option value="XML">{OPCAO_COM_XML}</option><option value="CHAVE">{OPCAO_SO_CHAVE}</option></select></label>
    {modo==="XML"?<>
      <label>Arquivo XML da nota (o .xml, não o PDF)<Input type="file" accept=".xml,text/xml" onChange={e=>void escolherArquivo(e.target.files?.[0])}/></label>
      <Erros mensagens={errosDoCampo(erros,"xmlOriginal")}/>
      {lendo && <p role="status" className="text-sm text-muted-foreground">Lendo as peças da nota…</p>}
      {previaFalhou && <p className="text-sm text-amber-800">{PREVIA_INDISPONIVEL}</p>}
      {previa && previa.rascunhoAberto!==null && <div role="alert" className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
        <p>{avisoRascunhoAberto(tipo)}</p>
        <a className="font-medium underline" href={urlRascunhoDevolucao(previa.rascunhoAberto,true)}>Abrir a devolução em andamento</a>
      </div>}
      {previa && previa.rascunhoAberto===null && <fieldset className="space-y-2">
        <legend className="text-sm font-medium">NF-e {previa.numero} (série {previa.serie}){previa.destinatarioNome?` — devolução para ${previa.destinatarioNome}`:""}. Marque as peças que estão voltando:</legend>
        {previa.itens.map(i=>{const s=selecao[i.nItem]??{marcado:false,quantidade:""};const esgotada=semSaldo(i);const cfop=avisoCfop(i);
          const errosItem=[...(errosSelecao[i.nItem]?[errosSelecao[i.nItem]]:[]),...errosDoItemXml(erros,i.nItem,previa.itens.filter(x=>selecao[x.nItem]?.marcado).findIndex(x=>x.nItem===i.nItem))];
          return <div key={i.nItem} className="space-y-1 rounded border p-2">
            <label className="flex gap-2"><input type="checkbox" aria-label={`Devolver o item ${i.nItem}`} disabled={esgotada} checked={s.marcado && !esgotada} onChange={e=>setSelecao(old=>({...old,[i.nItem]:{...s,marcado:e.target.checked}}))}/>Item {i.nItem} — {i.codigo} — {i.descricao}</label>
            <p className="text-xs text-muted-foreground">{descricaoSaldo(i)}{esgotada?" — nada mais a devolver desta peça.":""}</p>
            {s.marcado && !esgotada && <label className="block text-sm">Quantidade que volta<Input inputMode="decimal" aria-label={`Quantidade do item ${i.nItem}`} value={s.quantidade} onChange={e=>setSelecao(old=>({...old,[i.nItem]:{...s,quantidade:e.target.value}}))}/></label>}
            {cfop && s.marcado && <p className="text-xs text-amber-800">{cfop}</p>}
            <Erros mensagens={errosItem}/>
          </div>;})}
      </fieldset>}
    </>:<>
      {preenchida && <p role="status" className="text-sm text-muted-foreground">{AVISO_PELA_CHAVE_PREENCHIDA}</p>}
      <label className="block">Chave de acesso<Input value={chave} maxLength={60} inputMode="numeric" placeholder="Cole a chave do DANFE (pode ser com espaços)" onChange={e=>setChave(e.target.value)}/></label>
      {!chaveView.vazia && <p role="status" className={chaveView.ok?"text-xs text-emerald-700":"text-xs text-amber-800"}>{chaveView.mensagem}</p>}
      <Erros mensagens={errosDoCampo(erros,"chaveAcesso")}/>
      <label className="block">{tipo==="COMPRA_SAIDA"?"Destinatário (o fornecedor que emitiu a nota)":"Destinatário (o cliente que devolveu)"}<Input value={nome} onChange={e=>setNome(e.target.value)}/></label>
      <Erros mensagens={[...errosDoCampo(erros,"destinatario.nome"),...errosDoCampo(erros,"destinatario")]}/>
      <label className="block">CPF/CNPJ<Input value={docTela} readOnly={travadoPelaChave} onChange={e=>{if(!travadoPelaChave)setDoc(e.target.value);}}/></label>
      <Erros mensagens={errosDoCampo(erros,"destinatario.cpfCnpj")}/>
      <label className="block">UF do destinatário<Input value={ufTela} maxLength={2} readOnly={travadoPelaChave} onChange={e=>{if(!travadoPelaChave)setUf(e.target.value.toUpperCase());}}/></label>
      <Erros mensagens={errosDoCampo(erros,"destinatario.uf")}/>
      {travadoPelaChave && <p className="text-xs text-muted-foreground">{pelaChave?DESTINATARIO_TRAVADO_PELA_CHAVE:"Cole a chave primeiro: na devolução de compra, o CNPJ e a UF do fornecedor saem dela."}</p>}
      {linhas.map((linha,index)=><div className="space-y-1 rounded border p-2" key={index} aria-label={`Peça ${index+1}`}>
        <div className="grid grid-cols-3 gap-2">{CAMPOS_ITEM.map(k=><div key={k}><label>{ROTULOS_ITEM[k]}<Input value={linha[k]??""} inputMode={k==="nItem"?"numeric":k==="valorUnitario" || k==="quantidade" || k==="quantidadeOriginal"?"decimal":undefined} onChange={e=>{const v=e.target.value;setLinhas(old=>old.map((row,j)=>j===index?{...row,[k]:k==="nItem"?v.replace(/\D/g,""):v}:row));}}/></label><Erros mensagens={errosDoCampo(erros,`itens[${index}].${k}`)}/></div>)}
          {/* Origem: SEM valor escolhido de saída, mas obrigatória para criar — vazio seria "não informada"
              (o Dexo não inventa). Na venda do Dexo, vem da própria nota. */}
          <div><label>{ROTULO_ORIGEM}<select className="w-full rounded border p-2" value={linha.origem??""} onChange={e=>{const v=e.target.value;setLinhas(old=>old.map((row,j)=>j===index?{...row,origem:v}:row));}}>
            <option value="">{PLACEHOLDER_ORIGEM}</option>
            {ORIGENS_MERCADORIA.map(o=><option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}
          </select></label><Erros mensagens={errosDoCampo(erros,`itens[${index}].origem`)}/></div>
        </div>
        {index===0 && <p className="text-xs text-muted-foreground">{AJUDA_ORIGEM}</p>}
        <Erros mensagens={errosDoCampo(erros,`itens[${index}]`)}/>
        {linhas.length>1 && <Button type="button" size="sm" variant="ghost" onClick={()=>setLinhas(old=>old.filter((_,j)=>j!==index))}>Tirar esta peça</Button>}
      </div>)}
      <Erros mensagens={errosDoCampo(erros,"itens")}/>
      {/* Peça nova: origem e quantidade da nota original NÃO são copiadas da primeira. */}
      <Button type="button" variant="outline" onClick={()=>setLinhas(old=>[...old,{...(old[0]??LINHA_VAZIA),nItem:String(old.length+1),codigo:"",descricao:"",origem:undefined,quantidadeOriginal:undefined}])}>Adicionar peça</Button>
      <label className="flex gap-2"><input type="checkbox" checked={confirmado} onChange={e=>setConfirmado(e.target.checked)}/>{CONFIRMA_SEM_XML}</label>
      <Erros mensagens={errosDoCampo(erros,"confirmarSemXml")}/>
    </>}
    {erroGeral&&<p role="alert">{erroGeral}</p>}
    {soltos.length>0 && <ul className="list-disc pl-5 text-sm text-destructive">{soltos.map((m,k)=><li key={k}>{m}</li>)}</ul>}
    {modo==="XML" && previa && previa.rascunhoAberto===null && !previa.itens.some(i=>selecao[i.nItem]?.marcado) && <p className="text-xs text-muted-foreground">{ESCOLHA_UMA_PECA}</p>}
    <Button type="button" disabled={busy || (modo==="XML" && !podeCriarXml)} onClick={criar}>{busy?"Criando…":"Criar rascunho de devolução"}</Button>
    </>}
  </div>}</section>;
}
