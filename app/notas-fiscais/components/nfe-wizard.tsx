"use client";

// React explicito, como no `devolucao-editor.tsx` e no `step-finalizar.tsx`: o
// tsconfig usa jsx em modo preserve, entao o esbuild do vitest compila o JSX
// para o React.createElement classico e o wizard so monta em jsdom com o React
// em escopo (e a guarda da devolucao precisa ser testada MONTADA). Em producao
// o Next segue com o runtime automatico.
import * as React from "react";
import { useCallback, useEffect, useState, useRef } from "react";
import { DevolucaoEditor } from "./devolucao-editor";
import { NumeracaoActions } from "./numeracao-actions";
import type { NumeracaoView } from "./numeracao-actions";
import { desfechoConsulta, desfechoEmissao, type DesfechoTela } from "../lib/nfe-numeracao-ui";
import { PendenciasDevolucao } from "./pendencias-devolucao";
import {
  viewPendenciasDaResposta,
  type PendenciasDevolucaoView,
} from "../lib/nfe-devolucao-pendencias-ui";
import type { DevolucaoDetalhe } from "@/app/fiscal/devolucao/contrato";
// Devolução no wizard: a guarda de navegação (edição não salva), o rascunho
// feito à mão, o reaproveitado e o destino depois de autorizar. Decisões e
// textos no módulo puro, testado em node; aqui só a moldura.
import {
  ALTERACOES_NAO_SALVAS,
  AVISO_REAPROVEITADA,
  AVISO_SALVAR_DEVOLUCAO,
  GUARDA_DESCARTAR_E_SEGUIR,
  GUARDA_FICAR,
  GUARDA_NAO_DA_PARA_SALVAR,
  GUARDA_SALVANDO,
  GUARDA_SALVAR_E_SEGUIR,
  GUARDA_SALVE_NO_QUADRO,
  GUARDA_TITULO,
  PASSOS_COM_EDITOR_DEVOLUCAO,
  QUADRO_EXIGE_NUMERACAO_V2,
  TEXTO_DEVOLUCAO_SEM_COBRANCA,
  destinoAposAutorizar,
  guardaMensagem,
  lerEstadoDevolucaoDoRascunho,
  precisaConfirmarSaida,
  quadroDevolucaoAMao,
  ultimoSalvo,
  veioReaproveitada,
  type EstadoDevolucaoDoRascunho,
} from "../lib/nfe-devolucao-wizard-ui";
import { ROTULO_CANCELAR, ROTULO_DESCARTAR_CONFIRMADO, descartarRascunho } from "../lib/nfe-devolucoes-abertas-ui";
import { navegarPara } from "../lib/nfe-navegacao";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  FileText,
  User,
  Package,
  Truck,
  Box,
  Receipt,
  CreditCard,
  Calculator,
  CheckCircle,
  Loader2,
  Save,
  AlertTriangle,
} from "lucide-react";
import { getApiBaseUrl } from "@/lib/api";
import { useSession } from "next-auth/react";

import {
  StepperHeader,
  StepperStep,
} from "@/components/stepper/stepper-header";
import { StepperFooter } from "@/components/stepper/stepper-footer";
import { ToastViewport } from "@/components/ui/toast-viewport";

import {
  nfeDraftFormSchema,
  type NfeDraftFormData,
} from "../lib/nfe-form-schema";
import { DEFAULT_NFE_DRAFT } from "../lib/nfe-defaults";
import { useNfeDraft } from "../hooks/use-nfe-draft";

import { StepInformacoesGerais } from "./steps/step-informacoes-gerais";
import { StepDestinatario } from "./steps/step-destinatario";
import { StepProdutos } from "./steps/step-produtos";
import { StepFrete } from "./steps/step-frete";
import { StepVolumes } from "./steps/step-volumes";
import { StepDuplicatas } from "./steps/step-duplicatas";
import { StepPagamentos } from "./steps/step-pagamentos";
import { StepImpostos } from "./steps/step-impostos";
import { StepFinalizar } from "./steps/step-finalizar";

const STEPS: StepperStep[] = [
  { id: 1, title: "Informacoes", description: "Dados gerais da NF-e", icon: FileText },
  { id: 2, title: "Destinatario", description: "Dados do destinatario", icon: User },
  { id: 3, title: "Produtos", description: "Itens da nota", icon: Package },
  { id: 4, title: "Frete", description: "Dados do frete", icon: Truck },
  { id: 5, title: "Volumes", description: "Volumes da nota", icon: Box },
  { id: 6, title: "Duplicatas", description: "Cobranca", icon: Receipt },
  { id: 7, title: "Pagamentos", description: "Formas de pagamento", icon: CreditCard },
  { id: 8, title: "Impostos", description: "Calculos fiscais", icon: Calculator },
  { id: 9, title: "Finalizar", description: "Revisao e emissao", icon: CheckCircle },
];

const TOTAL_STEPS = 9;

// Feature flag: banner do motivo da rejeição ao reabrir uma nota REJECTED.
const REEMISSAO_REJEITADA_ENABLED =
  process.env.NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED === "true";

// Kill-switch da entrega de frete/medidas (ver step-frete.tsx).
const FRETE_MEDIDAS_ENABLED =
  process.env.NEXT_PUBLIC_NFE_FRETE_MEDIDAS_ENABLED === "true";

// Multi-CNPJ: gate do fetch de empresas (mesmo padrão do PDV) — com a flag
// desligada o wizard nem pergunta (egress zero) e o seletor não existe.
const MULTI_CNPJ_ENABLED =
  process.env.NEXT_PUBLIC_MULTI_CNPJ_ENABLED === "true";

type ToastType = "success" | "error" | "warning" | "info";

interface RejeicaoInfo {
  serie: number;
  numero: number;
  motivo: string;
  reaproveitavel: boolean;
}

// Multi-CNPJ: opção de emitente do seletor (payload sanitizado de
// GET /fiscal/companies). O seletor SÓ aparece com 2+ empresas — tenant de
// 1 CNPJ tem DOM idêntico ao anterior.
export interface CompanyOption {
  id: string;
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  isDefault?: boolean;
  serieNfe?: number;
}

export function NfeWizard() {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";

  const [currentStep, setCurrentStep] = useState(1);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [devolucao,setDevolucao]=useState<DevolucaoDetalhe|null>(null);
  // Pendencias que impediram a emissao (422 DEVOLUCAO_INVALIDA). O toast diz
  // que falhou; a LISTA do que falta nao cabe num toast e vinha sendo jogada
  // fora — `issues` ja chega no corpo do erro (fiscal.routes.ts). Null = a
  // ultima emissao nao foi esse bloqueio: a tela segue exatamente como antes.
  const [pendenciasEmissao,setPendenciasEmissao]=useState<PendenciasDevolucaoView|null>(null);
  // Ambiente da linha do rascunho (draft.ambiente), repassado ao ultimo passo
  // para o aviso dizer o ambiente REAL. Nao entra no formulario: e leitura, nao
  // e campo editavel, e nao pode viajar de volta no PUT do autosave.
  const [ambienteRascunho,setAmbienteRascunho]=useState<string|null>(null);
  const [numeracao,setNumeracao]=useState<NumeracaoView|null>(null);
  // ── Devolução: edição não salva no editor (DevolucaoEditor.onDirtyChange) ──
  // Nos passos 1, 3 e 8 da devolução só "Salvar devolução" grava; trocar de
  // passo jogava fora, calado, o que ela tinha mexido. `guarda` = a pergunta
  // aberta (para qual passo ela queria ir). `navPendenteRef` = o passo para
  // onde seguir quando o "Salvar e seguir" terminar de salvar (onSaved).
  const [devolucaoSuja,setDevolucaoSuja]=useState(false);
  const [guarda,setGuarda]=useState<{destino:number;estado:"PERGUNTA"|"SALVANDO"|"SEM_BOTAO"|"BLOQUEADO"}|null>(null);
  const navPendenteRef=useRef<number|null>(null);
  const editorRef=useRef<HTMLDivElement|null>(null);
  // O save da devolução também é "salvo": o selo do rodapé só via o do rascunho comum.
  const [devolucaoSalvaEm,setDevolucaoSalvaEm]=useState<Date|null>(null);
  // ── Devolução: rascunho que NÃO é devolução do Dexo (feito à mão) ──
  // null = não se aplica / não perguntado. `finalidadeSalva` diz se o rascunho
  // já está gravado como devolução (quadro "não vai emitir", com descarte) ou
  // se ela só escolheu agora no passo 1 (quadro "não se faz por aqui").
  const [estadoDevolucao,setEstadoDevolucao]=useState<EstadoDevolucaoDoRascunho|null>(null);
  const [finalidadeSalva,setFinalidadeSalva]=useState<string|null>(null);
  const [descarte,setDescarte]=useState<{confirmar:string|null;erro:string|null;ocupado:boolean}>({confirmar:null,erro:null,ocupado:false});
  const [reaproveitada,setReaproveitada]=useState(false);
  const emitindoRef=useRef(false);
  const [confirmarDescarte,setConfirmarDescarte]=useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rejeicaoInfo, setRejeicaoInfo] = useState<RejeicaoInfo | null>(null);
  // Multi-CNPJ: empresas do tenant + emitente do draft atual.
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [draftCompanyId, setDraftCompanyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: ToastType } | null>(
    null,
  );

  const form = useForm<NfeDraftFormData>({
    resolver: zodResolver(nfeDraftFormSchema) as any,
    mode: "onChange",
    defaultValues: DEFAULT_NFE_DRAFT,
  });

  const {
    control,
    trigger,
    getValues,
    setValue,
    reset,
    formState: { errors },
  } = form;
  // Só para o quadro do rascunho feito à mão: a finalidade escolhida no passo 1.
  const finalidadeAtual = useWatch({ control, name: "finalidade" });

  const showToast = (msg: string, type: ToastType) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const { saving, lastSavedAt, createDraft, loadDraft, saveDraft, debouncedSave } =
    useNfeDraft({
      email,
      draftId,
      onSaved: () => showToast("Rascunho salvo", "info"),
    });

  // Multi-CNPJ: lista de empresas do tenant (best-effort — sem ela o wizard
  // funciona exatamente como antes, só sem o seletor). `view=summary`: só os
  // campos que o seletor usa (egress ~6 campos vs ~30, mesmos valores).
  useEffect(() => {
    if (!email || !MULTI_CNPJ_ENABLED) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/companies?view=summary`,
          { headers: { email } },
        );
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (!cancelled && Array.isArray(data?.companies)) {
          setCompanies(data.companies);
        }
      } catch {
        // silencioso — seletor simplesmente não aparece
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  // Create or load draft on mount
  useEffect(() => {
    if (!email) return;
    let cancelled = false;

    const init = async () => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams(window.location.search);
        const existingId = params.get("draft");

        if (existingId) {
          const draft = await loadDraft(existingId);
          if (cancelled) return;
          if (draft) {
            setDraftId(existingId);
            setDraftCompanyId(draft.companyFiscalConfigId ?? null);
            setAmbienteRascunho(draft.ambiente ?? null);
            populateFormFromDraft(draft);
            setNumeracao(draft.numeracao??null);
            setFinalidadeSalva(draft.finalidade??null);
            setReaproveitada(veioReaproveitada(window.location.search));
            if(draft.finalidade==="DEVOLUCAO") {
              const res=await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft/${existingId}/devolucao`,{headers:{email}});
              if(res.ok && !cancelled)setDevolucao(await res.json());
              // O 404 DEVOLUCAO_NAO_GERENCIADA (rascunho feito à mão) e o 422
              // EXIGE_NUMERACAO_V2 eram engolidos: ela preenchia 7 passos e
              // batia no muro no 8. 404 sem código (devolução desligada) segue mudo.
              else if(!res.ok && !cancelled)setEstadoDevolucao(lerEstadoDevolucaoDoRascunho(res.status,await res.json().catch(()=>null)));
            }
            // Reabrindo uma nota REJEITADA: guarda os dados para o banner do
            // motivo (gated). Nao altera o formulario nem o fluxo de emissao.
            if (
              REEMISSAO_REJEITADA_ENABLED &&
              draft.status === "REJECTED" &&
              draft.motivoRejeicao
            ) {
              setRejeicaoInfo({
                serie: draft.serie,
                numero: draft.numero,
                motivo: draft.motivoRejeicao,
                reaproveitavel: draft.numeracao!==undefined?draft.numeracao?.reutilizavel===true:draft.reaproveitavel === true,
              });
            } else {
              setRejeicaoInfo(null);
            }
            return;
          }
        }

        const newDraft = await createDraft();
        if (cancelled) return;
        if (newDraft) {
          setDraftId(newDraft.id);
          setDraftCompanyId(newDraft.companyFiscalConfigId ?? null);
          setAmbienteRascunho(newDraft.ambiente ?? null);
          // A série padrão vem da configuração fiscal (CompanyFiscalConfig.
          // serieNfe), já resolvida pelo backend ao criar o draft. Sem isto o
          // form ficaria preso no default hardcoded (série 1). Toca SÓ a série;
          // os demais campos seguem em DEFAULT_NFE_DRAFT.
          setValue("serie", newDraft.serie ?? DEFAULT_NFE_DRAFT.serie);
        } else {
          showToast(
            "Configure o emissor antes de criar uma NF-e.",
            "warning",
          );
        }
      } catch {
        if (!cancelled) showToast("Erro ao inicializar rascunho", "error");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // Escolheu "Devolução" na Finalidade de uma NF-e comum: pergunta ao servidor
  // se a devolução do Dexo está ligada para a empresa DESTE rascunho (é o GET
  // da devolução dele que sabe, não a disponibilidade da empresa padrão). Se
  // estiver, o quadro do passo 1 mostra o caminho certo antes de ela preencher
  // tudo. Uma vez por rascunho; empresa sem a devolução nova = nada muda.
  useEffect(()=>{
    // Rascunho que JÁ veio como devolução: quem pergunta é o init, acima.
    if(!email || !draftId || devolucao || estadoDevolucao!==null || finalidadeSalva==="DEVOLUCAO" || finalidadeAtual!=="DEVOLUCAO")return;
    let cancelado=false;
    (async()=>{try{
      const res=await fetch(`${getApiBaseUrl()}/fiscal/nfe/draft/${draftId}/devolucao`,{headers:{email}});
      if(cancelado)return;
      if(res.ok){setEstadoDevolucao("GERENCIADA");return;}
      setEstadoDevolucao(lerEstadoDevolucaoDoRascunho(res.status,await res.json().catch(()=>null)));
    }catch{/* rede: não afirma nada */}})();
    return()=>{cancelado=true;};
  },[email,draftId,devolucao,estadoDevolucao,finalidadeSalva,finalidadeAtual]);

  // Recarregar ou fechar a aba com edição não salva na devolução perde tudo do
  // mesmo jeito: o navegador pergunta antes. Só com edição pendente.
  useEffect(()=>{
    if(!devolucao || !devolucaoSuja)return;
    const segurar=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};
    window.addEventListener("beforeunload",segurar);
    return()=>window.removeEventListener("beforeunload",segurar);
  },[devolucao,devolucaoSuja]);

  const populateFormFromDraft = (draft: any) => {
    const dest = draft.destinatarioJson ?? {};
    const transp = draft.transportadoraJson ?? {};
    const volumes = draft.volumesJson ?? [];
    const duplicatas = draft.duplicatasJson ?? [];
    const pagamentos = draft.pagamentosJson ?? [{ meio: "DINHEIRO", valor: 0 }];

    reset({
      // Step 1
      serie: draft.serie ?? 1,
      tipoOperacao: draft.tipoOperacao ?? "SAIDA",
      finalidade: draft.finalidade ?? "NORMAL",
      destinoOperacao: draft.destinoOperacao ?? "INTERNA",
      naturezaOperacao: draft.naturezaOperacao ?? "VENDA DE MERCADORIA",
      indPresenca: draft.indPresenca ?? "NAO_SE_APLICA",
      intermediador: draft.intermediador,
      numeroPedido: draft.numeroPedido,
      informacoesComplementares: draft.informacoesComplementares,
      dataEmissao: draft.dataEmissao
        ? new Date(draft.dataEmissao).toISOString().slice(0, 16)
        : null,
      dataSaida: draft.dataSaida
        ? new Date(draft.dataSaida).toISOString().slice(0, 16)
        : null,
      // Step 2
      customerId: draft.customerId,
      destinatario: {
        tipoPessoa: dest.tipoPessoa ?? "PF",
        cpfCnpj: dest.cpfCnpj ?? "",
        nome: dest.nome ?? "",
        inscricaoEstadual: dest.inscricaoEstadual ?? null,
        indicadorIE: dest.indicadorIE ?? "9",
        email: dest.email ?? null,
        telefone: dest.telefone ?? null,
        cep: dest.cep ?? null,
        logradouro: dest.logradouro ?? null,
        numero: dest.numero ?? null,
        complemento: dest.complemento ?? null,
        bairro: dest.bairro ?? null,
        municipio: dest.municipio ?? null,
        codMunicipio: dest.codMunicipio ?? null,
        uf: dest.uf ?? null,
        codPais: dest.codPais ?? "1058",
        pais: dest.pais ?? "BRASIL",
      },
      // Step 3
      itens: (draft.itens ?? []).map((item: any) => ({
        productId: item.productId,
        numero: item.numero,
        codigo: item.codigo,
        descricao: item.descricao,
        ncm: item.ncm,
        cfop: item.cfop,
        cest: item.cest,
        origem: item.origem ?? 0,
        unidade: item.unidade,
        quantidade: item.quantidade,
        valorUnitario: item.valorUnitario,
        valorTotal: item.valorTotal,
        desconto: item.desconto,
        observacoes: item.observacoes,
      })),
      // Step 4
      modalidadeFrete: draft.modalidadeFrete ?? "SEM_FRETE",
      valorFrete: (draft as any).valorFrete ?? null,
      transportadora: {
        cpfCnpj: transp.cpfCnpj ?? null,
        nome: transp.nome ?? null,
        inscricaoEstadual: transp.inscricaoEstadual ?? null,
        endereco: transp.endereco ?? null,
        municipio: transp.municipio ?? null,
        uf: transp.uf ?? null,
      },
      // Step 5
      volumes: Array.isArray(volumes) ? volumes : [],
      // Step 6
      duplicatas: Array.isArray(duplicatas) ? duplicatas : [],
      // Step 7
      pagamentos: Array.isArray(pagamentos) && pagamentos.length > 0
        ? pagamentos
        : [{ meio: "DINHEIRO", valor: 0 }],
    });
  };

  // Step-level validation
  const validateCurrentStep = async (): Promise<boolean> => {
    if (currentStep === 1) {
      return trigger([
        "serie",
        "tipoOperacao",
        "finalidade",
        "destinoOperacao",
        "naturezaOperacao",
        "indPresenca",
      ]);
    }
    if (currentStep === 2) {
      return trigger(["destinatario.cpfCnpj", "destinatario.nome"]);
    }
    if (currentStep === 3) {
      return trigger(["itens"]);
    }
    if (currentStep === 4) {
      return trigger(
        FRETE_MEDIDAS_ENABLED
          ? ["modalidadeFrete", "valorFrete"]
          : ["modalidadeFrete"],
      );
    }
    // Volumes seguem OPCIONAIS: nenhum campo e obrigatorio. Com a flag ligada
    // o trigger so reprova o que foi digitado ERRADO (peso/medida negativos,
    // medida fracionaria) — array vazio continua valido.
    if (currentStep === 5) {
      return FRETE_MEDIDAS_ENABLED ? trigger(["volumes"]) : true;
    }
    // Step 6 (duplicatas) is optional — always valid
    if (currentStep === 6) {
      return true;
    }
    if (currentStep === 7) {
      return trigger(["pagamentos"]);
    }
    // Steps 8 (impostos) and 9 (finalizar) — read-only, always valid
    return true;
  };

  const [isEmitting, setIsEmitting] = useState(false);

  // saveCurrentStep e async e RETORNA a promise do saveDraft, para que a
  // emissao possa aguardar (await) o PUT do rascunho terminar ANTES do POST
  // /issue — sem isso o save do ultimo passo corria com a emissao e podia
  // aterrissar depois da autorizacao, rebaixando a nota para DRAFT. A guarda
  // de status no servidor (updateDraft) e a defesa real; aqui so tornamos o
  // cliente deterministico. Tambem nao salva enquanto isEmitting.
  const saveCurrentStep = useCallback(async () => {
    if (!draftId || isEmitting) return;
    const data = getValues();
    if(devolucao && [1,3,6,7,8].includes(currentStep))return;

    if (currentStep === 1) {
      setFinalidadeSalva(data.finalidade);
      return saveDraft(draftId, {
        serie: data.serie,
        tipoOperacao: data.tipoOperacao,
        finalidade: data.finalidade,
        destinoOperacao: data.destinoOperacao,
        naturezaOperacao: data.naturezaOperacao,
        indPresenca: data.indPresenca,
        intermediador: data.intermediador,
        numeroPedido: data.numeroPedido,
        informacoesComplementares: data.informacoesComplementares,
        dataEmissao: data.dataEmissao,
        dataSaida: data.dataSaida,
      });
    } else if (currentStep === 2) {
      return saveDraft(draftId, {
        customerId: data.customerId,
        destinatario: data.destinatario,
      } as any);
    } else if (currentStep === 3) {
      return saveDraft(draftId, {
        itens: data.itens,
      } as any);
    } else if (currentStep === 4) {
      return saveDraft(draftId, {
        modalidadeFrete: data.modalidadeFrete,
        transportadora: data.transportadora,
        ...(FRETE_MEDIDAS_ENABLED
          ? { valorFrete: data.valorFrete ?? null }
          : {}),
      } as any);
    } else if (currentStep === 5) {
      return saveDraft(draftId, {
        volumes: data.volumes,
      } as any);
    } else if (currentStep === 6) {
      return saveDraft(draftId, {
        duplicatas: data.duplicatas,
      } as any);
    } else if (currentStep === 7) {
      return saveDraft(draftId, {
        pagamentos: data.pagamentos,
      } as any);
    }
    // Steps 8 and 9 are read-only — no save needed
  }, [draftId, currentStep, getValues, saveDraft, isEmitting,devolucao]);

  // Troca de passo de fato. Zera a guarda: o editor do passo novo nasce limpo
  // (a key muda), então a edição do passo anterior foi salva ou descartada.
  const irParaPasso = (destino: number) => {
    navPendenteRef.current = null;
    setGuarda(null);
    setDevolucaoSuja(false);
    setCurrentStep(destino);
  };

  // Próximo, Voltar e o clique num passo passam por aqui. Na devolução com
  // edição não salva, pergunta antes (a guarda nunca prende: há sempre salvar
  // e seguir, descartar e seguir, ou ficar). Fora disso — e em TODA NF-e
  // comum —, exatamente o de antes: salva o passo e troca.
  const navegar = (destino: number) => {
    if (precisaConfirmarSaida({ devolucao: !!devolucao, editorSujo: devolucaoSuja, passoAtual: currentStep, destino })) {
      setGuarda({ destino, estado: "PERGUNTA" });
      return;
    }
    saveCurrentStep();
    setCurrentStep(destino);
  };

  const handleNext = async () => {
    const ok = await validateCurrentStep();
    if (!ok) {
      showToast("Corrija os campos obrigatorios antes de avancar", "warning");
      return;
    }
    if (currentStep < TOTAL_STEPS) {
      navegar(currentStep + 1);
    } else {
      saveCurrentStep();
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      navegar(currentStep - 1);
    }
  };

  const goToStep = (step: number) => {
    if (step < currentStep && step >= 1) {
      navegar(step);
    }
  };

  // "Salvar e seguir": aciona o MESMO botão "Salvar devolução" do quadro (o
  // save é do editor, com as regras dele) e segue quando o servidor aceitar
  // (onSaved). Recusado, o motivo aparece no quadro e a guarda continua com
  // "Descartar e seguir" e "Ficar" — nunca prende.
  const salvarESeguir = () => {
    if (!guarda) return;
    navPendenteRef.current = guarda.destino;
    const botao = Array.from(editorRef.current?.querySelectorAll("button") ?? []).find((b) =>
      /^\s*salvar/i.test(b.textContent ?? ""),
    );
    if (!botao) {
      setGuarda({ ...guarda, estado: "SEM_BOTAO" });
      return;
    }
    // Botão travado: o quadro ainda aponta algo a resolver (ou já está salvando;
    // nesse caso, quando o servidor aceitar, o assistente segue do mesmo jeito).
    if (botao.disabled) {
      setGuarda({ ...guarda, estado: "BLOQUEADO" });
      return;
    }
    setGuarda({ ...guarda, estado: "SALVANDO" });
    botao.click();
  };

  // Descarte do rascunho feito à mão (quadro do passo 1). Com número fiscal
  // preso em produção, o servidor pede confirmação (409) e a tela explica o
  // que isso significa antes de repetir com `descartarNumero`.
  const descartarRascunhoAtual = async (descartarNumero: boolean) => {
    if (!draftId || descarte.ocupado) return;
    setDescarte({ confirmar: null, erro: null, ocupado: true });
    const r = await descartarRascunho({ base: getApiBaseUrl(), email, draftId, descartarNumero });
    if (r.ok) {
      navegarPara("/notas-fiscais/emitidas");
      return;
    }
    setDescarte({ confirmar: r.confirmar ? r.mensagem : null, erro: r.confirmar ? null : r.mensagem, ocupado: false });
  };

  // Multi-CNPJ: troca de emitente no passo 1. Salva no draft (posse validada
  // no backend) e alinha a série com a padrão da empresa escolhida.
  const handleCompanyChange = useCallback(
    async (companyId: string) => {
      if (!draftId || isEmitting || companyId === draftCompanyId) return;
      const company = companies.find((c) => c.id === companyId);
      if (!company) return;
      setDraftCompanyId(companyId);
      setValue("serie", company.serieNfe ?? 1);
      await saveDraft(draftId, {
        companyFiscalConfigId: companyId,
        serie: company.serieNfe ?? 1,
      } as any);
    },
    [draftId, isEmitting, draftCompanyId, companies, setValue, saveDraft],
  );

  // Aplica o desfecho de /issue ou /consultar-situacao. `numeracao` undefined
  // (resposta sem a chave, V1) não mexe no estado; null limpa (nº consumido).
  const aplicarDesfecho = (x: DesfechoTela) => {
    if (x.numeracao !== undefined) setNumeracao(x.numeracao);
    if (x.pedirConfirmacaoDescarte) setConfirmarDescarte(true);
    if (x.toast) showToast(x.toast.msg, x.toast.type);
    if (x.redirecionar) {
      // Redirect after short delay
      // Para a nota que acabou de sair (lista de Notas Emitidas com ela aberta:
      // XML, DANFE, e-mail) — "Emitir NF-e" reabria um rascunho qualquer.
      setTimeout(() => {
        navegarPara(destinoAposAutorizar(draftId));
      }, 2000);
    }
  };

  const handleEmitir = async () => {
    if (!draftId || isEmitting || emitindoRef.current) return;
    emitindoRef.current=true;
    // Lista velha some antes de tentar de novo: mostrar pendencia ja resolvida
    // seria mandar a operadora consertar o que ela acabou de consertar.
    setPendenciasEmissao(null);

    // Aguarda o save do passo atual TERMINAR antes de emitir. saveCurrentStep
    // agora retorna a promise do PUT /draft/:id — assim o rascunho e gravado
    // ANTES do POST /issue, eliminando a corrida cliente-side em que o save
    // aterrissava depois da autorizacao e rebaixava a nota para DRAFT.
    await saveCurrentStep();

    setIsEmitting(true);
    try {
      const res = await fetch(`${getApiBaseUrl()}/fiscal/nfe/${draftId}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", email },
        body: JSON.stringify({confirmarDescarteNumero:confirmarDescarte}),
      });

      const data = await res.json();
      // ADITIVO: o toast continua sendo exatamente o de antes. Isto aqui só
      // aproveita as `issues` que já vinham no corpo do 422 e eram descartadas.
      // Fora do DEVOLUCAO_INVALIDA devolve null e nada muda na tela.
      if (!res.ok) setPendenciasEmissao(viewPendenciasDaResposta(data));
      // Decisão em lib/nfe-numeracao-ui (testada em node): resposta V1 segue o
      // caminho de sempre; V2 em andamento (202/INCERTO, claim perdido) é info.
      aplicarDesfecho(desfechoEmissao(res.ok, data));
    } catch {
      showToast("Erro de conexao ao emitir NF-e", "error");
    } finally {
      setIsEmitting(false);
      emitindoRef.current=false;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Carregando rascunho...
      </div>
    );
  }

  if (!draftId) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-6 text-center">
        <p className="text-sm text-amber-700">
          Configure o emissor fiscal antes de criar uma NF-e.
        </p>
        <a
          href="/notas-fiscais/configuracao"
          className="mt-2 inline-block text-sm font-medium text-primary underline"
        >
          Ir para configuracao
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-2xl border border-border/60 bg-card/80 p-6 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
      {REEMISSAO_REJEITADA_ENABLED && rejeicaoInfo && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            <span className="text-sm font-medium text-destructive">
              Esta nota foi rejeitada pela SEFAZ
            </span>
          </div>
          <p className="mt-1 text-sm">«{rejeicaoInfo.motivo}»</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {rejeicaoInfo.reaproveitavel
              ? `Corrija o que deu errado e emita novamente — o número ${rejeicaoInfo.serie}/${rejeicaoInfo.numero} será reaproveitado.`
              : "Corrija o que deu errado e emita novamente."}
          </p>
        </div>
      )}

      <StepperHeader
        steps={STEPS}
        currentStep={currentStep}
        onGoToStep={goToStep}
      />

      <div className="min-h-[300px]">
        {numeracao && <NumeracaoActions id={draftId} email={email} numeracao={numeracao} onChanged={d=>aplicarDesfecho(desfechoConsulta(d))}/>}
        {confirmarDescarte && <p role="alert">Ao clicar em emitir novamente, você confirma o descarte do número anterior. Em produção ele precisará ser inutilizado.</p>}
        {/* Rascunho reaproveitado: "Devolver"/"Devolução manual" abriram a
            devolução que já existia desta nota, em vez de criar outra. */}
        {devolucao && reaproveitada && currentStep === 1 && (
          <p role="status" className="mb-3 rounded-lg border border-blue-500/40 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300">{AVISO_REAPROVEITADA}</p>
        )}
        {devolucao && PASSOS_COM_EDITOR_DEVOLUCAO.includes(currentStep) && (
          <p className="mb-3 text-xs text-muted-foreground">{AVISO_SALVAR_DEVOLUCAO}</p>
        )}
        {devolucao && PASSOS_COM_EDITOR_DEVOLUCAO.includes(currentStep) && <div ref={editorRef}><DevolucaoEditor key={`${devolucao.draftId}-${currentStep}`} step={currentStep} value={devolucao} email={email} onDirtyChange={setDevolucaoSuja} onSaved={async d=>{setDevolucao(d);setPendenciasEmissao(null);const fresh=await loadDraft(d.draftId);if(fresh)populateFormFromDraft(fresh);setDevolucaoSalvaEm(new Date());
          // (O "sujo" volta a false pelo próprio editor — onDirtyChange —, que é
          // quem sabe se o que está na tela é o que foi salvo.)
          // "Salvar e seguir" da guarda: o servidor aceitou, então segue. (O
          // editor já refez os campos com a resposta — não precisa remontar, e
          // remontar perderia as peças tiradas nesta visita, que ele mantém
          // na tela para poderem voltar.)
          const destino=navPendenteRef.current;if(destino!==null)irParaPasso(destino);}}/></div>}
        {/* Rascunho que não é devolução do Dexo: o aviso sai JÁ no passo 1 (no 8
            o StepImpostos tem o quadro dele, com o mesmo caminho). */}
        {!devolucao && finalidadeAtual === "DEVOLUCAO" && estadoDevolucao === "EXIGE_NUMERACAO_V2" && (
          <div role="alert" className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
            <p className="font-semibold">{QUADRO_EXIGE_NUMERACAO_V2.titulo}</p>
            <p className="mt-1">{QUADRO_EXIGE_NUMERACAO_V2.mensagem}</p>
          </div>
        )}
        {!devolucao && finalidadeAtual === "DEVOLUCAO" && estadoDevolucao === "NAO_GERENCIADA" && (finalidadeSalva === "DEVOLUCAO" ? currentStep !== 8 : currentStep === 1) && (() => {
          const quadro = quadroDevolucaoAMao(finalidadeSalva === "DEVOLUCAO" ? "ABERTO" : "ESCOLHENDO");
          return (
            <div role="alert" aria-label={quadro.titulo} className="mb-4 space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
              <p className="font-semibold">{quadro.titulo}</p>
              <p>{quadro.mensagem}</p>
              <ul className="list-disc space-y-1 pl-5">{quadro.caminhos.map((c) => <li key={c}>{c}</li>)}</ul>
              <p>{quadro.aproveitar}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <a href="/notas-fiscais/emitidas" className="font-medium underline">Ir para Notas Emitidas</a>
                {quadro.descartar && !descarte.confirmar && (
                  <button type="button" className="font-medium underline" disabled={descarte.ocupado} onClick={() => void descartarRascunhoAtual(false)}>
                    {descarte.ocupado ? "Descartando…" : quadro.descartar}
                  </button>
                )}
              </div>
              {descarte.confirmar && (
                <div role="alertdialog" aria-label="Confirmar descarte" className="space-y-2 rounded border border-destructive/40 bg-destructive/5 p-2 text-foreground">
                  <p>{descarte.confirmar}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="font-medium underline" disabled={descarte.ocupado} onClick={() => void descartarRascunhoAtual(true)}>{ROTULO_DESCARTAR_CONFIRMADO}</button>
                    <button type="button" className="underline" onClick={() => setDescarte({ confirmar: null, erro: null, ocupado: false })}>{ROTULO_CANCELAR}</button>
                  </div>
                </div>
              )}
              {descarte.erro && <p className="text-destructive">{descarte.erro}</p>}
            </div>
          );
        })()}
        {currentStep === 1 && !devolucao && (
          <StepInformacoesGerais
            control={control}
            errors={errors}
            companies={companies}
            selectedCompanyId={draftCompanyId}
            onCompanyChange={handleCompanyChange}
          />
        )}
        {currentStep === 2 && (
          <StepDestinatario
            control={control}
            errors={errors}
            setValue={setValue}
            email={email}
          />
        )}
        {currentStep === 3 && !devolucao && (
          <StepProdutos
            control={control}
            errors={errors}
            setValue={setValue}
            getValues={getValues}
            email={email}
          />
        )}
        {currentStep === 4 && (
          <StepFrete control={control} errors={errors} />
        )}
        {currentStep === 5 && (
          <StepVolumes control={control} errors={errors} />
        )}
        {devolucao && [6,7].includes(currentStep) && <p>{TEXTO_DEVOLUCAO_SEM_COBRANCA}</p>}
        {currentStep === 6 && !devolucao && (
          <StepDuplicatas
            control={control}
            errors={errors}
            getValues={getValues}
          />
        )}
        {currentStep === 7 && !devolucao && (
          <StepPagamentos
            control={control}
            errors={errors}
            getValues={getValues}
          />
        )}
        {currentStep === 8 && draftId && !devolucao && (
          <StepImpostos
            getValues={getValues}
            draftId={draftId}
            email={email}
          />
        )}
        {currentStep === 9 && (
          <StepFinalizar
            getValues={getValues}
            ambienteRascunho={ambienteRascunho}
            email={email}
            companyFiscalConfigId={companies.length > 1 ? draftCompanyId : null}
            totaisDevolucao={devolucao?.totais ?? null}
          />
        )}
        {/* O que impediu a emissao, logo acima do proprio botao "Emitir NF-e".
            O toast continua aparecendo — ele avisa que falhou; este quadro diz
            QUAL pendencia, em QUAL item e o que fazer, que e o que nao cabe
            num toast e era a informacao que a cliente passou o dia caçando. */}
        {currentStep === 9 && pendenciasEmissao && (
          <PendenciasDevolucao view={pendenciasEmissao} />
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {saving && (
          <>
            <Save className="h-3 w-3 animate-pulse" />
            Salvando...
          </>
        )}
        {/* O "Salvo HH:MM" só via o save do rascunho comum: na devolução ficava
            mostrando o de outro passo. Agora é o mais recente dos dois — e,
            com edição pendente no quadro da devolução, diz isso. */}
        {!saving && devolucao && devolucaoSuja && (
          <span className="text-amber-700 dark:text-amber-300">{ALTERACOES_NAO_SALVAS}</span>
        )}
        {!saving && !(devolucao && devolucaoSuja) && ultimoSalvo(lastSavedAt, devolucaoSalvaEm) && (
          <>
            <Save className="h-3 w-3" />
            Salvo {ultimoSalvo(lastSavedAt, devolucaoSalvaEm)!.toLocaleTimeString("pt-BR")}
          </>
        )}
      </div>

      {/* A guarda: ela tentou sair do passo com edição não salva na devolução.
          Pergunta e oferece as três saídas — nunca prende. */}
      {guarda && (
        <div role="alertdialog" aria-label={GUARDA_TITULO} className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          <p className="font-semibold">{GUARDA_TITULO}</p>
          <p>{guardaMensagem(guarda.destino, STEPS.find((s) => s.id === guarda.destino)?.title ?? "")}</p>
          {guarda.estado === "SALVANDO" && <p role="status">{GUARDA_SALVANDO}</p>}
          {guarda.estado === "SEM_BOTAO" && <p role="status">{GUARDA_SALVE_NO_QUADRO}</p>}
          {guarda.estado === "BLOQUEADO" && <p role="status">{GUARDA_NAO_DA_PARA_SALVAR}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground" onClick={salvarESeguir}>{GUARDA_SALVAR_E_SEGUIR}</button>
            <button type="button" className="rounded-md border px-3 py-1.5" onClick={() => irParaPasso(guarda.destino)}>{GUARDA_DESCARTAR_E_SEGUIR}</button>
            <button type="button" className="rounded-md px-3 py-1.5 underline" onClick={() => { navPendenteRef.current = null; setGuarda(null); }}>{GUARDA_FICAR}</button>
          </div>
        </div>
      )}

      <StepperFooter
        currentStep={currentStep}
        totalSteps={TOTAL_STEPS}
        onBack={handleBack}
        onNext={handleNext}
        onSubmit={handleEmitir}
        submitLabel={isEmitting ? "Emitindo..." : confirmarDescarte ? "Confirmar descarte e emitir" : "Emitir NF-e"}
        isSubmitting={isEmitting}
      />

      {toast && (
        <ToastViewport
          className={
            "fixed bottom-6 right-6 z-[100] rounded-xl border px-4 py-3 text-sm shadow-lg " +
            (toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : toast.type === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : toast.type === "warning"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700"
                  : "border-blue-500/40 bg-blue-500/10 text-blue-600")
          }
        >
          {toast.msg}
        </ToastViewport>
      )}
    </div>
  );
}
