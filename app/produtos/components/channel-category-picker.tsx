"use client";

import { useEffect, useMemo, useState } from "react";

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

/** "Veículos / Peças / Rodas" → "Veículos > Peças > Rodas". */
function formatarCaminho(v: string): string {
  return v
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" > ");
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
 * Detalhes que vieram do fluxo de criação e valem manter:
 *  - As listas são pequenas (a OLX tem poucas categorias; o Facebook algumas
 *    dezenas), e o endpoint responde com `Cache-Control` de 10 minutos. Por isso
 *    a busca com termo VAZIO carrega tudo: é barata e é o que resolve o rótulo
 *    de um valor já salvo — sem ela, reabrir um anúncio mostrava o id cru.
 *  - 1 letra é ruído e não dispara busca; a partir de 2 sim, com 400 ms de
 *    debounce.
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
  const [opcoes, setOpcoes] = useState<Array<{ id: string; value: string }>>([]);
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [rotuloEscolhido, setRotuloEscolhido] = useState("");

  useEffect(() => {
    const termo = busca.trim();
    if (termo.length === 1) return;

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
          if (!cancelado) {
            setOpcoes(Array.isArray(data?.categories) ? data.categories : []);
          }
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
      rotuloEscolhido || opcoes.find((o) => o.id === value)?.value || "";
    return cru ? formatarCaminho(cru) : "";
  }, [rotuloEscolhido, opcoes, value]);

  const termo = busca.trim();
  const mostrarLista = (aberto || termo.length > 0) && opcoes.length > 0;

  return (
    <div className="space-y-1">
      <Label htmlFor={`channel-category-${cfg.rota}`}>{cfg.rotulo}</Label>

      <div className="relative">
        {rotulo && !aberto && (
          <button
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
              id={`channel-category-${cfg.rota}`}
              placeholder={cfg.placeholder}
              value={busca}
              disabled={disabled}
              onFocus={() => setAberto(true)}
              onChange={(e) => setBusca(e.target.value)}
              onBlur={() => {
                // O clique numa opção usa onMouseDown, que corre antes do blur;
                // o atraso evita fechar a lista antes de o clique registrar.
                setTimeout(() => setAberto(false), 200);
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
                      setRotuloEscolhido(o.value);
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
            setRotuloEscolhido("");
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
