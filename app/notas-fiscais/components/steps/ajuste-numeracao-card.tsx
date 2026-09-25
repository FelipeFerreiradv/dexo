"use client";

// Ajuste manual do próximo número da série — a saída do 409
// SEQUENCIA_ATRAS_DA_SEFAZ.
//
// POR QUE AQUI: o contador é um atributo da SÉRIE, e a série do emitente se
// configura neste passo ("Ambiente & Provedor"), dois campos acima. O card
// herda o `companyId` do formulário aberto, então o escopo do ajuste é sempre
// o mesmo CNPJ que o operador está editando — não existe um seletor de
// emitente próprio para errar, que é o pior erro possível nesta operação.
//
// Fica FECHADO por padrão: quem abre a configuração para mexer na série da
// NF-e não pode esbarrar num campo que pula numeração. O botão abre o
// formulário, e aplicar ainda exige o diálogo de confirmação.

// `import * as React` porque a suíte compila JSX no transform CLÁSSICO
// (`React.createElement`), e sem isto o card não pode ser MONTADO num teste —
// só lido. Mesmo padrão de `scrap-link-section.tsx` e de `components/ui/*`. Em
// produção o Next usa o transform automático e este import é inerte.
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Hash, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getApiBaseUrl } from "@/lib/api";

import {
  AMBIENTE_LABEL,
  MODELO_LABEL,
  MOTIVO_MAX,
  MOTIVO_MIN,
  avisoInutilizacao,
  corpoAjuste,
  corpoConfirmacao,
  desfechoAjuste,
  errosDoForm,
  inteiroDoCampo,
  linhasDaConfirmacao,
  numeroAtualDoPreview,
  numerosPulados,
  podeRevisar,
  type AmbienteAjuste,
  type CorpoAjuste,
  type DetalhesConfirmacao,
  type FormAjuste,
  type ModeloAjuste,
  type TipoToast,
} from "../../lib/nfe-ajuste-numeracao-ui";
import { avisoPisoSugerido } from "../../lib/nfe-numeracao-ui";

// Kill-switch no padrão dos vizinhos (NEXT_PUBLIC_*_DISABLED): o caminho nasce
// visível — a razão da tarefa é que hoje só existe SQL em produção —, mas dá
// para escondê-lo sem deploy se algum tenant precisar.
const AJUSTE_DISABLED =
  process.env.NEXT_PUBLIC_NFE_AJUSTE_NUMERACAO_DISABLED === "true";

interface Props {
  userEmail: string | null | undefined;
  /** true quando a empresa já foi salva — sem config não há contador. */
  configExists: boolean;
  /** Multi-CNPJ: emitente dono da série. Ausente/null = CNPJ padrão do tenant. */
  companyId?: string | null;
  /** Ambiente que o formulário está mostrando (só pré-seleciona o campo). */
  ambientePadrao?: string | null;
  /** Série padrão da NF-e do formulário (só pré-preenche o campo). */
  seriePadrao?: number | null;
  /** Série padrão da NFC-e do formulário. A nota do PDV numera separado da
   *  NF-e: sem isso, trocar o tipo de nota manteria a série errada no campo. */
  serieNfcePadrao?: number | null;
  /** Nasce aberto: o wizard mostra o card DEPOIS do 409 SEQUENCIA_ATRAS_DA_SEFAZ,
   *  quando abrir já é a intenção. Ausente = fechado, como na configuração. */
  abertoInicial?: boolean;
  /** Mínimo que o 409 indicou (`detalhes.proximoNumeroMinimo`). Só TEXTO de
   *  apoio: o campo do número continua em branco — o número certo é o que a
   *  pessoa conferiu no portal, e o ajuste não pode ser desfeito. */
  pisoSugerido?: number | null;
}

function seriePara(
  modelo: ModeloAjuste,
  seriePadrao?: number | null,
  serieNfcePadrao?: number | null,
): string {
  const padrao = modelo === "65" ? serieNfcePadrao : seriePadrao;
  return String(padrao ?? 1);
}

function formAtual(
  ambientePadrao?: string | null,
  seriePadrao?: number | null,
  serieNfcePadrao?: number | null,
): FormAjuste {
  return {
    ambiente:
      ambientePadrao === "PRODUCAO" || ambientePadrao === "HOMOLOGACAO"
        ? ambientePadrao
        : "HOMOLOGACAO",
    modelo: "55",
    serie: seriePara("55", seriePadrao, serieNfcePadrao),
    proximoNumero: "",
    motivo: "",
  };
}

export function AjusteNumeracaoCard({
  userEmail,
  configExists,
  companyId,
  ambientePadrao,
  seriePadrao,
  serieNfcePadrao,
  abertoInicial,
  pisoSugerido,
}: Props) {
  const [aberto, setAberto] = useState(abertoInicial === true);
  const avisoPiso = avisoPisoSugerido(pisoSugerido);
  const [form, setForm] = useState<FormAjuste>(() =>
    formAtual(ambientePadrao, seriePadrao, serieNfcePadrao),
  );
  const [numeroAtual, setNumeroAtual] = useState<number | null>(null);
  const [lendoAtual, setLendoAtual] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [mensagem, setMensagem] = useState<{
    msg: string;
    type: TipoToast;
  } | null>(null);
  // Corpo CONGELADO no 409: editar o formulário por trás do diálogo não pode
  // trocar o que será aplicado.
  const [pendente, setPendente] = useState<{
    corpo: CorpoAjuste;
    mensagem: string;
    detalhes: DetalhesConfirmacao;
  } | null>(null);

  const campo = <K extends keyof FormAjuste>(chave: K, valor: FormAjuste[K]) =>
    setForm((prev) => ({ ...prev, [chave]: valor }));

  // Leitura do contador atual. O GET /fiscal/nfe/proximo-numero é do modelo 55
  // no ambiente SALVO da config — `numeroAtualDoPreview` só aceita a resposta
  // quando ela casa com o que está na tela; fora disso o número fica
  // desconhecido até a revisão, e é o servidor que diz qual é.
  const { ambiente, modelo, serie: serieCampo } = form;
  useEffect(() => {
    if (!aberto || !userEmail) return;
    const serie = inteiroDoCampo(serieCampo);
    if (serie === null || serie > 999) {
      setNumeroAtual(null);
      return;
    }
    let cancelado = false;
    // Limpa ANTES de reler: trocar de ambiente/modelo/série não pode deixar o
    // contador anterior na tela nem por um instante — é dele que sai o "quantos
    // números ficam sem uso".
    setNumeroAtual(null);
    setLendoAtual(true);
    const timer = setTimeout(async () => {
      try {
        const companyQs = companyId
          ? `&companyId=${encodeURIComponent(companyId)}`
          : "";
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/nfe/proximo-numero?serie=${serie}${companyQs}`,
          { headers: { email: userEmail } },
        );
        const data = await res.json().catch(() => ({}));
        if (!cancelado) {
          const alvo = { ambiente, modelo, serie: serieCampo };
          setNumeroAtual(res.ok ? numeroAtualDoPreview(data, alvo) : null);
        }
      } catch {
        if (!cancelado) setNumeroAtual(null);
      } finally {
        if (!cancelado) setLendoAtual(false);
      }
    }, 350);
    return () => {
      cancelado = true;
      clearTimeout(timer);
    };
  }, [aberto, userEmail, companyId, ambiente, modelo, serieCampo]);

  const enviar = useCallback(
    async (corpo: CorpoAjuste) => {
      if (!userEmail) return;
      setEnviando(true);
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/nfe/proximo-numero/ajuste`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", email: userEmail },
            body: JSON.stringify(corpo),
          },
        );
        const data = await res.json().catch(() => ({}));
        const desfecho = desfechoAjuste(res.ok, data);

        if (desfecho.numeroAtual !== null) setNumeroAtual(desfecho.numeroAtual);
        if (desfecho.toast) setMensagem(desfecho.toast);

        if (desfecho.confirmacao) {
          setPendente({
            corpo,
            mensagem: desfecho.confirmacao.mensagem,
            detalhes: desfecho.confirmacao.detalhes,
          });
          return;
        }
        setPendente(null);
        if (desfecho.aplicado) {
          // Contador movido: o formulário volta ao zero para ninguém reaplicar
          // por engano (cada reaplicação pula mais números).
          setForm((prev) => ({ ...prev, proximoNumero: "", motivo: "" }));
        }
      } catch {
        setPendente(null);
        setMensagem({ msg: "Erro de conexão.", type: "error" });
      } finally {
        setEnviando(false);
      }
    },
    [userEmail],
  );

  if (AJUSTE_DISABLED || !configExists) return null;

  const erros = errosDoForm(form);
  const podeEnviar = podeRevisar(form) && !enviando;
  const pulados = numerosPulados(
    numeroAtual,
    inteiroDoCampo(form.proximoNumero),
  );
  const motivoDigitado = form.motivo.trim().length;

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
      <div className="flex items-start gap-2">
        <Hash className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Ajustar o próximo número de uma série
          </p>
          <p className="text-xs text-muted-foreground">
            Use quando a SEFAZ recusar suas notas dizendo que o número já foi
            usado — o que acontece quando a empresa já emitia por outro sistema
            e o Dexo começou a contar de um número mais baixo. O contador só
            avança: nunca dá para voltar a um número já emitido.
          </p>
        </div>
      </div>

      {!aberto ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            // Pré-seleção no momento do clique: o ambiente e a série que o
            // operador está vendo dois campos acima, mesmo se ele acabou de
            // trocá-los sem salvar.
            setForm(formAtual(ambientePadrao, seriePadrao, serieNfcePadrao));
            setMensagem(null);
            setAberto(true);
          }}
        >
          Ajustar próximo número
        </Button>
      ) : (
        <>
          {avisoPiso && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              {avisoPiso}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ajuste-ambiente">Ambiente</Label>
              <Select
                value={form.ambiente}
                onValueChange={(v) => campo("ambiente", v as AmbienteAjuste)}
              >
                <SelectTrigger id="ajuste-ambiente">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.keys(AMBIENTE_LABEL) as AmbienteAjuste[]
                  ).map((a) => (
                    <SelectItem key={a} value={a}>
                      {AMBIENTE_LABEL[a]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Produção e teste contam separado — ajustar um não mexe no outro.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ajuste-modelo">Tipo de nota</Label>
              <Select
                value={form.modelo}
                onValueChange={(v) => {
                  // Trocar o tipo de nota troca a série junto: NF-e e NFC-e têm
                  // contadores e séries próprios, e deixar a série da NF-e no
                  // campo faria o ajuste cair na série errada da NFC-e.
                  const m = v as ModeloAjuste;
                  setForm((prev) => ({
                    ...prev,
                    modelo: m,
                    serie: seriePara(m, seriePadrao, serieNfcePadrao),
                  }));
                }}
              >
                <SelectTrigger id="ajuste-modelo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MODELO_LABEL) as ModeloAjuste[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODELO_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A NF-e e a nota do PDV também contam separado.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ajuste-serie">Série</Label>
              <Input
                id="ajuste-serie"
                type="number"
                min={0}
                max={999}
                value={form.serie}
                onChange={(e) => campo("serie", e.target.value)}
              />
              {erros.serie && (
                <p className="text-xs text-destructive">{erros.serie}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="ajuste-proximo">Novo próximo número</Label>
              <Input
                id="ajuste-proximo"
                type="number"
                min={1}
                placeholder="Ex.: 5000"
                value={form.proximoNumero}
                onChange={(e) => campo("proximoNumero", e.target.value)}
              />
              {/* Só depois de digitar: campo recém-aberto não nasce em vermelho. */}
              {erros.proximoNumero && form.proximoNumero.trim() !== "" && (
                <p className="text-xs text-destructive">
                  {erros.proximoNumero}
                </p>
              )}
            </div>
          </div>

          {/* De → para. Enquanto o número atual não for conhecido com certeza,
              a tela DIZ que não sabe em vez de mostrar o contador de outro
              ambiente/modelo. */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Hoje esta série emite o nº</span>
            <span className="font-medium text-foreground">
              {lendoAtual ? (
                <Loader2 className="inline h-3 w-3 animate-spin" />
              ) : (
                (numeroAtual ?? "—")
              )}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">passa a emitir o nº</span>
            <span className="font-medium text-foreground">
              {inteiroDoCampo(form.proximoNumero) ?? "—"}
            </span>
            {pulados !== null && (
              <span className="text-amber-700">
                · {pulados} número(s) ficam sem uso
              </span>
            )}
            {numeroAtual === null && !lendoAtual && (
              <span className="text-muted-foreground">
                · o número de hoje aparece na confirmação
              </span>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="ajuste-motivo">
              Motivo (mínimo {MOTIVO_MIN} caracteres)
            </Label>
            <Textarea
              id="ajuste-motivo"
              rows={3}
              maxLength={MOTIVO_MAX}
              placeholder="Ex.: migração do sistema antigo — última NF-e emitida pelo CNPJ foi a 4999"
              value={form.motivo}
              onChange={(e) => campo("motivo", e.target.value)}
              className="resize-none"
            />
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Fica registrado com o seu nome, a data e o número de antes e o
                de depois.
              </p>
              <p className="shrink-0 text-xs text-muted-foreground">
                {motivoDigitado}/{MOTIVO_MIN}
              </p>
            </div>
            {erros.motivo && motivoDigitado > 0 && (
              <p className="text-xs text-destructive">{erros.motivo}</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={enviando}
              onClick={() => {
                setAberto(false);
                setForm(formAtual(ambientePadrao, seriePadrao, serieNfcePadrao));
                setMensagem(null);
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!podeEnviar}
              onClick={() => {
                setMensagem(null);
                enviar(corpoAjuste(form, companyId ?? null));
              }}
            >
              {enviando ? "Verificando..." : "Revisar ajuste"}
            </Button>
          </div>
        </>
      )}

      {mensagem && (
        <p
          role="status"
          className={
            "rounded-lg border px-3 py-2 text-xs " +
            (mensagem.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : mensagem.type === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700")
          }
        >
          {mensagem.msg}
        </p>
      )}

      {/* Confirmação — o servidor já recusou a primeira chamada e NADA foi
          escrito. O texto dele é mostrado inteiro: é ele que diz o número de
          hoje, quantos pulam e que não dá para desfazer. */}
      <AlertDialog
        open={pendente !== null}
        onOpenChange={(open) => {
          if (!open && !enviando) setPendente(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              Confirmar o ajuste da numeração
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendente?.mensagem}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pendente && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                {linhasDaConfirmacao(pendente.detalhes).map((linha) => (
                  <div key={linha.rotulo} className="contents">
                    <dt className="text-muted-foreground">{linha.rotulo}</dt>
                    <dd className="text-right font-medium text-foreground">
                      {linha.valor}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-amber-700">
                {avisoInutilizacao(pendente.detalhes)}
              </p>
            </>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={enviando}>Voltar</AlertDialogCancel>
            <Button
              type="button"
              disabled={enviando}
              onClick={() => {
                if (pendente) enviar(corpoConfirmacao(pendente.corpo));
              }}
            >
              {enviando ? "Aplicando..." : "Confirmar e avançar o contador"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
