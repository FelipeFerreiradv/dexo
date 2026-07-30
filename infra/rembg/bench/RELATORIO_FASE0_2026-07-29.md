# Fase 0 — Relatório (29/07/2026, COMPLETO após a rodada das 20h)

Executado via SSH (`claude-deploy-assuncao`) no KVM8, com o Felipe autorizando a
execução direta. Container de bench na porta 8001 com **paridade de env
byte-idêntica** à live (conferida via `/health` dos dois lados).

## Respostas ao §12 do prompt

### §12.3 — O recorte das fotos difíceis, SEM restrição de tempo, sai bom?

**SIM — excelente nas duas.** (PNGs em `/srv/dexo-bench/h5/`, inspecionados
visualmente em 29/07:)

- **Foto A (coxim, bancada preta riscada):** bancada, parede, saco plástico e
  peças ao fundo 100% removidos; a **base preta sobre bancada preta foi
  preservada inteira** (furos abertos, solda visível); sem fragmentos.
- **Foto B (barra, concreto ao sol):** concreto, rachaduras, musgo, **sombra
  dura do sol** e **pés do fotógrafo** todos removidos; barra íntegra, furos
  preservados.
- Variante `REMBG_REFINE_EDGES=false`: saída ~igual (744KB vs 753KB em A) — o
  refine não estraga nem salva esses casos.
- Sombra sintética aplicada corretamente nas duas (sem incluir a sombra real
  do sol na máscara).

**Consequência:** a Frente 2 (qualidade universal) é REFINAMENTO, não
emergência. O problema do usuário é **tempo/capacidade** — a resposta
estrutural é o **PR 4 (recorte assíncrono)**.

### §12.2 — Composição das falhas em produção

pm2 `dexo-api-error.log` (janela acumulada, inclui o incidente de 21-24/07):

| Classe | Linhas | Nota |
|---|---|---|
| `fila do sidecar esgotados` (gate/orçamento, sem chamar o sidecar) | **1.032** | design: degrada antes de enfileirar |
| `sidecar rembg falhou` (total) | **4.655** | quebra abaixo |
| — das quais `timeout of` (axios) | **2.462 (53%)** | inferência não coube no orçamento restante |
| — das quais ECONNRESET / socket hang up / ECONNREFUSED | **2.191 (47%)** | morte de conexão — ver abaixo: é HISTÓRICO |
| — das quais HTTP 4xx/5xx | **0** | o sidecar nunca respondeu erro |

**A classe "conexão morta" é do incidente antigo, não do estado atual:**

- Container live atual: `RestartCount=0` desde 24/07 17:33; `dmesg` com **0**
  OOM kills desde o reboot (23/07).
- Logs do container (24→29/07): **15.656 requisições `POST /remove-bg`, TODAS
  200** — zero 499/503/5xx no lado do sidecar em 5 dias.
- Residual pós-fix: 478 linhas de `retry único após backoff` (blips de socket
  com processo vivo — o retry de #200 absorve; ~96/dia, correlacionar com o
  creep de PIDs abaixo).

**Leitura:** no estado atual, ~100% das degradações são por TEMPO (fila +
timeout), repartidas ≈ 30% gate-antes-de-chamar / 70% timeout-durante. É a
assinatura de H2 (fila de 1 worker × lote) amplificada por H1 (fotos caras).

### §12.1 — Qual hipótese a medição confirmou?

- **H5 refutada como emergência** (recorte perfeito com tempo).
- **H2 confirmada** como mecanismo dominante (números acima).
- **H4 (OOM) encerrada para o estado atual** (0 kills, 0 restarts pós-24/07) —
  os fixes de 24/07 seguram.
- **H1 REFUTADA para as fotos do usuário** (rodada limpa das 20h, abaixo):
  as difíceis custam ~5-15% a mais que as fáceis — nada de explosão
  pós-inferência, porque (como o H5 mostrou) a máscara delas sai LIMPA.
  A "imagem-veneno" do incidente 24/07 continua existindo como CLASSE
  (máscara suja → bbox de quadro inteiro → sombra cara), mas não é o caso
  destas fotos. (A medição diurna foi abortada: contenção com a live —
  o MESMO recorte oscilou 16,9s → 55,9s com a live a ~440% de CPU.)

## Profile da live (n=16.039 inferências, 24→29/07) — sinais além do plano

| Estágio | mediana | p95 | max |
|---|---|---|---|
| remove | 9.069 ms | 13.102 ms | **122.321 ms** |
| refine | 106 ms | 231 ms | 804 ms |
| shadow | 556 ms | 1.205 ms | **48.613 ms** |
| encode | 155 ms | 280 ms | 1.301 ms |

1. **A cauda da sombra NÃO morreu com o sigma-cap**: piores casos 17,0s /
   17,4s / 20,6s / 22,5s / **48,6s** pós-cap. O cap limita o BLUR; o
   `warpAffine` + `_alpha_over` em canvas float expandido continuam O(MP).
   Vira insumo do PR 2/PR 9 (colapsar o bbox via pós-processamento de máscara
   resolve na raiz).
2. **remove com max 122s** — outliers de contenção de CPU (não de imagem).
3. **PIDs do container live = 3.154** (creep anômalo; era ~100 no incidente de
   24/07). Sem OOM e sem restart, mas é precursor a investigar — provável
   relação com os 478 blips de conexão.

## Tabela estágio→ms (rodada LIMPA, 20:00-20:45 de 29/07 — sem clientes)

Medianas single (sequencial); sombra entre parênteses quando difere:

| Estágio | Fáceis (7 reais) | Hard A (coxim) | Hard B (barra) |
|---|---|---|---|
| decode | 10,6 | 20,7 | 31,8 |
| **remove** | **10.271 (10.186)** | **10.693 (10.807)** | **10.845 (11.696)** |
| to_rgba | 2,9 | 3,7 | 2,8 |
| refine | 148 (129) | 156 | 144 |
| shadow | — (729) | — (645) | — (640) |
| encode | 98 (130) | 189 (199) | 112 (107) |
| **TOTAL** | **10.452 (10.843)** | **11.069 (11.983)** | **11.130 (12.488)** |

- `remove` domina ~95% em TODOS os casos; difíceis ≈ fáceis (+5-15%).
- p95 do total: 13,5-14,8s; outlier isolado de 48s numa fácil (evento único,
  possivelmente um upload real concorrendo — mediana sólida).
- out_bytes das difíceis normais (300-745KB) — sem explosão de encode.

**Fila (lote de 10, concorrência 2 = front atual):**

| | sem sombra | com sombra |
|---|---|---|
| wall-clock do lote | 109,4s | 116,3s |
| por request: mediana | 21,3s | 22,4s |
| por request: p95 / max | 24,6s / 24,8s | 27,0s / **37,1s** |

**Leitura (H2 confirmada como mecanismo dominante):** já em condição IDEAL
(noite, sem contenção), o último request de um lote de 10 chega a **37s** —
a centímetros do orçamento útil (~42s). De dia, com a live a 400%+ de CPU
(remove vira 15-55s) e o tráfego público na mesma fila, os últimos do lote
estouram o orçamento TODA vez. É a assinatura exata da reclamação do usuário
(lotes de fotos → últimas degradam). **PR 4 (assíncrono) é a correção.**

## Golden congelado (20h de 29/07)

- `/golden/core`: 19 fontes × 2 variantes (7 fáceis reais + 12 sintéticas) —
  gate BLOQUEANTE. Sanidade pós-save: **38/38 VERDE** (SSIM 1,0000).
- `/golden/hard`: as 2 fotos do usuário × 2 variantes — referência
  informacional.

## Gate do PR 2 (#212) com REMBG_MASK_POSTPROCESS=true — REPROVADO (26/38)

As 24 sintéticas passaram; as 12 falhas são todas em fotos REAIS e todas com
o MESMO padrão: **SSIM 0,9991-1,0000 e MAE ≤0,053 (visualmente idênticas),
mas alpha Linf 63-252** — de 75 a 520 pixels alterados por foto (de ~2M).
Diffs visuais (`/srv/dexo-bench/golden/DIFF_*.png`) mostram que TODAS as
mudanças são furos-ruído selados DENTRO da peça e specks/névoa de borda
removidos — ou seja, o módulo fazendo exatamente o que promete, sobre ruído
invisível. Nenhum pixel de peça real foi removido.

**Conclusão:** o critério de IDENTIDADE (Linf ≤2) é por construção
incompatível com um estágio cujo trabalho é corrigir esses pixels. Decisão
registrada para o Felipe no PR #212: (1) adotar critério visual
(SSIM+MAE) para o gate com flag ON — recomendado; ou (2) manter Linf
estrito e aposentar a flag. **Nada foi mergeado/deployado** (conforme a
condição combinada de "gate 100% verde").

## Estado da execução

- [x] Fotos A/B enviadas (`/srv/dexo-bench/images/hard/`, 1,9 MP cada).
- [x] 7 fáceis reais selecionadas dos uploads de prod (pares `.orig`+`.png`
  cujo recorte FUNCIONOU; 3 candidatas de 12 MP descartadas) + 12 sintéticas.
- [x] H5 completo (cutout/shadow/norefine × A/B) — veredito acima.
- [x] Tabela estágio→ms + fila (lote 10×2) + golden core/hard congelado —
  rodada das **20:00-20:45 de 29/07** (janela sem clientes, a pedido do
  Felipe); log preservado em `/srv/dexo-bench/night_fase0.log`. Cron
  one-shot removido após a coleta; script fica em
  `/srv/dexo-bench/run_fase0_night.sh` para reuso.
- [x] Gate do PR #212 rodado (reprovado por Linf — análise acima).

## Decisões que este relatório já sustenta

1. **PR 4 (assíncrono) é prioridade máxima** — ataca 100% do problema atual.
2. **PR 2 (pós-processamento de máscara)** continua valendo, reenquadrado:
   menos "salvar a qualidade" (o modelo já acerta) e mais **matar a cauda da
   sombra na raiz** (alpha espalhado → bbox de quadro inteiro) + robustez.
3. **PR 5/9**: sem urgência de capacidade bruta — o sidecar atual dá conta
   quando o tempo deixa de ser inimigo; provedor externo fica como resiliência
   (sidecar fora do ar), não como qualidade.
4. Investigar o creep de PIDs do container live (item novo, fora do plano).
