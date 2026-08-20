"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiBaseUrl } from "@/lib/api";

type Channel = "OLX" | "FACEBOOK";

const CONFIG: Record<
  Channel,
  { rota: string; rotulo: string; placeholder: string; vazio: string }
> = {
  OLX: {
    rota: "olx",
    rotulo: "Categoria na OLX",
    placeholder: "Buscar categoria da OLX...",
    vazio: "Opcional — se vazio, a categoria é resolvida automaticamente na OLX.",
  },
  FACEBOOK: {
    rota: "facebook",
    rotulo: "Categoria no Facebook",
    placeholder: "Buscar categoria do Facebook...",
    vazio:
      "Opcional — se vazio, a categoria é resolvida automaticamente no Facebook.",
  },
};

export type ChannelCategoryOption = { id: string; value: string };

/** "Veículos / Peças / Rodas" → "Veículos > Peças > Rodas". */
export function formatarCaminho(v: string): string {
  return v
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" > ");
}

/**
 * 1 letra é ruído — não vale uma ida ao servidor. Termo vazio VALE: é ele que
 * carrega a lista inteira (as duas são pequenas) e resolve o rótulo legível de
 * um valor já salvo.
 */
export function deveBuscar(termo: string): boolean {
  return termo.trim().length !== 1;
}

/**
 * Cache de módulo por (canal, termo), mesmo padrão de `mlSuggestCache` e
 * `shopeeSuggestCache` no modal de edição. Sem ele, cada seleção disparava uma
 * busca nova só porque o campo de texto voltava a ficar vazio.
 */
const CACHE = new Map<string, ChannelCategoryOption[]>();
/** Teto defensivo: a sessão é longa e o cache não precisa crescer sem fim. */
const CACHE_MAX = 100;

function lerCache(chave: string) {
  return CACHE.get(chave) ?? null;
}
function gravarCache(chave: string, opcoes: ChannelCategoryOption[]) {
  if (CACHE.size >= CACHE_MAX) CACHE.clear();
  CACHE.set(chave, opcoes);
}

interface ChannelCategoryPickerProps {
  channel: Channel;
  /** Id cru da categoria (numérico na OLX, caminho da taxonomia no Facebook). */
  value: string;
  onChange: (next: string) => void;
  email?: string;
  disabled?: boolean;
}

/**
 * Seletor de categoria de OLX e Facebook — busca no servidor, igual ao fluxo de
 * criação.
 *
 * Antes disto, a edição de anúncio expunha um `<input>` de texto puro: o
 * operador digitava "roda" e a tela não respondia nada, porque o campo esperava
 * o id cru (`2101`) ou o caminho da taxonomia do Google. O mesmo campo, na
 * criação, sempre teve busca com sugestões. Aqui as duas telas passam a usar o
 * MESMO componente.
 *
 * Egress: as listas dos dois canais são pequenas e o endpoint responde com
 * `Cache-Control: private, max-age=600`. Somando o cache de módulo por termo, a
 * edição inteira de um anúncio custa tipicamente UMA requisição.
 */
export function ChannelCategoryPicker({
  channel,
  value,
  onChange,
  email,
  disabled,
}: ChannelCategoryPickerProps) {
  const cfg = CONFIG[channel];

  const [busca, setBusca] = useState("");
  const [opcoes, setOpcoes] = useState<ChannelCategoryOption[]>(
    () => lerCache(`${channel}|`) ?? [],
  );
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  /** Rótulo do que o usuário escolheu, amarrado ao id — se o `value` mudar por
   *  fora (trocar de anúncio no modal), o rótulo antigo não vaza. */
  const [escolhido, setEscolhido] = useState<ChannelCategoryOption | null>(null);

  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  useEffect(() => {
    const termo = busca.trim();
    if (!deveBuscar(termo)) return;

    const chave = `${channel}|${termo}`;
    const cacheado = lerCache(chave);
    if (cacheado) {
      setOpcoes(cacheado);
      return;
    }

    let cancelado = false;
    const handle = setTimeout(async () => {
      setCarregando(true);
      try {
        const resp = await fetch(
          `${getApiBaseUrl()}/marketplace/${cfg.rota}/categories?search=${encodeURIComponent(
            termo,
          )}`,
          { headers: email ? { email } : {} },
        );
        if (resp.ok) {
          const data = await resp.json();
          const lista: ChannelCategoryOption[] = Array.isArray(data?.categories)
            ? data.categories
            : [];
          gravarCache(chave, lista);
          if (!cancelado) setOpcoes(lista);
        }
      } catch (err) {
        console.error(`Erro ao buscar categorias ${channel}:`, err);
      } finally {
        if (!cancelado) setCarregando(false);
      }
    }, 400);

    return () => {
      cancelado = true;
      clearTimeout(handle);
    };
  }, [busca, cfg.rota, channel, email]);

  const rotulo = useMemo(() => {
    const cru =
      (escolhido && escolhido.id === value ? escolhido.value : null) ??
      opcoes.find((o) => o.id === value)?.value ??
      // Enquanto a lista não chega, mostra o valor cru: o campo nunca aparece
      // VAZIO segurando um valor salvo — foi assim que a versão anterior
      // enganava quem reabria um anúncio já categorizado.
      value ??
      "";
    return cru ? formatarCaminho(cru) : "";
  }, [escolhido, opcoes, value]);

  const termo = busca.trim();
  const mostrarLista = (aberto || termo.length > 0) && opcoes.length > 0;
  const idInput = `channel-category-${cfg.rota}`;

  return (
    <div className="space-y-1">
      <Label htmlFor={idInput}>{cfg.rotulo}</Label>

      <div className="relative">
        {rotulo && !aberto && (
          <button
            id={idInput}
            type="button"
            disabled={disabled}
            className="flex w-full cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              setAberto(true);
              setBusca("");
            }}
          >
            <span className="truncate">{rotulo}</span>
            <span className="ml-2 text-xs text-muted-foreground">Alterar</span>
          </button>
        )}

        {(aberto || !rotulo) && (
          <>
            <Input
              id={rotulo && !aberto ? undefined : idInput}
              placeholder={cfg.placeholder}
              value={busca}
              disabled={disabled}
              onFocus={() => setAberto(true)}
              onChange={(e) => setBusca(e.target.value)}
              onBlur={() => {
                // O clique numa opção usa onMouseDown, que corre antes do blur;
                // o atraso evita fechar a lista antes de o clique registrar.
                if (blurTimer.current) clearTimeout(blurTimer.current);
                blurTimer.current = setTimeout(() => setAberto(false), 200);
              }}
              autoFocus={aberto && !!rotulo}
            />

            {mostrarLista && (
              <div className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
                {opcoes.map((o) => (
                  <button
                    type="button"
                    key={o.id}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-accent ${
                      o.id === value ? "bg-accent font-medium" : ""
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(o.id);
                      setEscolhido(o);
                      setBusca("");
                      setAberto(false);
                    }}
                  >
                    {formatarCaminho(o.value)}
                  </button>
                ))}
              </div>
            )}

            {termo.length > 1 && !carregando && opcoes.length === 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                Nenhuma categoria encontrada
              </div>
            )}

            {carregando && (
              <div className="absolute z-50 mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground shadow-md">
                Buscando…
              </div>
            )}
          </>
        )}
      </div>

      {rotulo && !aberto && (
        <button
          type="button"
          disabled={disabled}
          className="text-xs text-muted-foreground underline underline-offset-2 disabled:opacity-60"
          onClick={() => {
            onChange("");
            setEscolhido(null);
            setBusca("");
          }}
        >
          Limpar categoria
        </button>
      )}

      <p className="text-xs text-muted-foreground">{cfg.vazio}</p>

      {channel === "FACEBOOK" && value ? (
        // O rótulo é tradução nossa; o valor é o caminho da taxonomia do Google.
        <p className="text-[11px] text-muted-foreground/80">
          Enviado à Meta: <span className="font-mono">{value}</span>
        </p>
      ) : null}
    </div>
  );
}

export default ChannelCategoryPicker;
