# Bench / Fase 0 — medir antes de mexer

Ferramentas de **diagnóstico** do sidecar rembg. **Não tocam a qualidade nem o
comportamento** do serviço — só medem latência e congelam um *golden set* pra
servir de gate de regressão.

> **Regra da Fase 0:** nenhuma otimização entra antes de existir (a) a tabela
> estágio→ms apontando o gargalo real e (b) o golden set + gate de qualidade.
> Os números autoritativos saem **do KVM8** (o gargalo é banda de memória; medir
> em Windows/WSL **não** é representativo).

Conteúdo:

| Arquivo | Pra quê |
|---|---|
| `bench.py` | Benchmark do `/remove-bg`: modo **single** (service time, mediana/p95) e **batch** (wall-clock da fila de 1 worker). Lê o header `X-Rembg-Timing`. Só stdlib. |
| `golden.py` | `save` congela a saída atual (recorte + sombra) como golden; `compare` re-roda e mede SSIM + diff de alpha contra o golden. **Violação = exit ≠ 0.** |
| `gen_synthetic.py` | Gera imagens sintéticas cobrindo tamanho/forma/fundo (complementa as fotos reais difíceis). |
| `node-encode-bench.ts` | Micro-bench do custo acessório no Node (alvos A2/A4): re-encode de PNG vs passthrough e o decode redundante do input. |

---

## 1. Pré-requisito: instrumentação ligada

O breakdown por estágio só aparece com **`REMBG_PROFILE=true`** no sidecar (default
off → zero overhead, body/contrato inalterados). O container de bench abaixo já
sobe com isso ligado. A **live continua sem `REMBG_PROFILE`** — não mexemos nela.

---

## 2. Subir o container descartável no KVM8 (isolado da live)

Mesmo `Dockerfile` da live ⇒ **mesmo modelo, mesma qualidade**. Roda numa porta
separada (`8001`) e some ao parar. Pico ~8,5GB; com a live (~8,5GB) ainda cabe nos
32GB.

```bash
cd /var/www/dexo          # raiz do repo no KVM8 (ajuste se diferente)

# imagem dedicada de bench (idêntica à live)
docker build -t dexo-rembg-bench ./infra/rembg

# diretórios de trabalho no host (persistem golden e imagens)
mkdir -p /srv/dexo-bench/images /srv/dexo-bench/golden

# >>> copie aqui 5-10 FOTOS REAIS DIFÍCEIS suas <<<
#     (fundo complexo, peça fina tipo para-lama, peça cheia tipo cubo, etc.)
#     para /srv/dexo-bench/images/

docker run --rm -d --name dexo-rembg-bench \
  -p 127.0.0.1:8001:8000 \
  -e REMBG_PROFILE=true \
  --memory 12g \
  -v "$(pwd)/infra/rembg/bench:/bench" \
  -v /srv/dexo-bench/images:/images \
  -v /srv/dexo-bench/golden:/golden \
  dexo-rembg-bench

# o modelo carrega no startup (warmup); espere o health responder
sleep 20 && curl -s http://127.0.0.1:8001/health ; echo
```

> Dentro do container o sidecar é `http://127.0.0.1:8000` (porta interna). A
> `8001` é só o atalho do host pra `curl`/health. Os comandos abaixo rodam
> **dentro** do container via `docker exec`, então usam `:8000`.

---

## 3. Gerar imagens sintéticas (complementa as reais)

```bash
docker exec dexo-rembg-bench python /bench/gen_synthetic.py --out /images/synthetic
```

Isso cria 12 imagens (`syn_<tamanho>_<forma>_<fundo>.jpg`) em `/images/synthetic`.
Elas cobrem **tamanho/forma**; os casos **difíceis de verdade** vêm das suas fotos
reais em `/images`.

---

## 4. Benchmark (a tabela estágio→ms da Fase 0)

```bash
docker exec dexo-rembg-bench python /bench/bench.py \
  --url http://127.0.0.1:8000/remove-bg --images /images \
  --iters 12 --warmup 2 --concurrency 3 --batch 6
```

Roda **sem sombra e com sombra**, modo single (mediana/p95 por estágio + total +
bytes) e modo batch (wall-clock do lote + p95 por request). **Cole toda a saída
de volta** — é o coração do diagnóstico.

---

## 5. Congelar o golden e validar o gate

```bash
# congela a QUALIDADE ATUAL (baseline intocável)
docker exec dexo-rembg-bench python /bench/golden.py save \
  --url http://127.0.0.1:8000/remove-bg --images /images --out /golden

# sanidade: comparar o golden contra ele mesmo -> tem que dar VERDE
docker exec dexo-rembg-bench python /bench/golden.py compare \
  --url http://127.0.0.1:8000/remove-bg --golden /golden
```

`compare` imprime, por imagem/variante: `SSIM(white/black/alpha)` e
`alpha(Linf/MAE)`. Limiares default **SSIM ≥ 0.995**, **alpha Linf ≤ 2**,
**MAE ≤ 0.5**. Sai com código ≠ 0 se houver regressão (vira gate de cada
otimização das Camadas A/B mais tarde).

O golden salvo fica em `/srv/dexo-bench/golden` no host — **não commitar** (imagens
grandes; guardar fora do git).

---

## 6. Micro-bench do Node (custos A2/A4) — opcional, roda onde há `node_modules`

Quantifica o re-encode de PNG (A2) e o decode redundante do input (A4),
isoladamente. Rode na **raiz do repo** (onde o `sharp` está instalado), apontando
para um recorte real do sidecar e uma foto de produto:

```bash
npx tsx infra/rembg/bench/node-encode-bench.ts \
  --cutout /srv/dexo-bench/golden/<algum>.shadow.png \
  --input  /srv/dexo-bench/images/<alguma-foto>.jpg \
  --iters 20 --warmup 3
```

Compare os **bytes**: se o passthrough (PNG do sidecar/PIL) inflar muito vs o
`lvl9` atual, consideramos o meio-termo `lvl6` na hora de implementar A2.

---

## 7. Encerrar

```bash
docker rm -f dexo-rembg-bench      # para e remove o container de bench
# a live (porta 8000 / container dexo-rembg) nunca foi tocada
```

---

## O que me mandar de volta

1. Saída completa do **`bench.py`** (single + batch, com/sem sombra).
2. Saída do **`golden.py compare`** de sanidade (deve estar VERDE).
3. (Se rodar) saída do **`node-encode-bench.ts`**.
4. `nproc` e `lscpu | grep -E "Model name|Vendor"` do KVM8 (pra dimensionar a
   varredura de threads da Camada A e checar se a CPU é Intel p/ OpenVINO).

Com isso eu monto a tabela estágio→ms, aponto o gargalo real e **paro pra
alinhar** quais camadas seguir.
