# Fase 0 — Remoção de fundo UNIVERSAL (bench + golden + diagnóstico)

Roteiro copy-paste para rodar no **KVM8** (VPS de produção). Nenhum passo toca a
live: o bench roda num container descartável na porta **8001**. Tempo total de
compute estimado: **45–60 min** — rodar em janela de baixo tráfego e monitorar
`free -h` (a live pode picar ~12GiB; o bench usa até 12g; sobra apertada nos 32GB).

Este runbook complementa o `README.md` deste diretório com o que ele **não**
cobre: **paridade de env com a produção** (sem isso o golden congela um
comportamento que não é o da live) e o protocolo das **fotos difíceis** do
usuário (casos A e B do trabalho "remoção universal").

Cole **toda** a saída de cada bloco de volta na conversa — os números decidem
quais correções entram (H1 = custo pós-inferência explode; H5 = qualidade real
da segmentação sem pressão de tempo).

---

## 0. Preparar diretórios e fotos

```bash
mkdir -p /srv/dexo-bench/images/easy /srv/dexo-bench/images/hard \
         /srv/dexo-bench/images/synthetic \
         /srv/dexo-bench/golden/core /srv/dexo-bench/golden/hard \
         /srv/dexo-bench/h5
```

Da sua máquina (onde estão as fotos), enviar:

1. **As 2 fotos difíceis** (as mesmas anexadas na conversa — versão original de
   ~1600px que você tem no celular/WhatsApp):

```bash
scp foto_coxim_bancada.jpg  root@SEU_HOST:/srv/dexo-bench/images/hard/hard_A_coxim_bancada_preta.jpg
scp foto_barra_concreto.jpg root@SEU_HOST:/srv/dexo-bench/images/hard/hard_B_barra_concreto_sol.jpg
```

2. **4 a 8 fotos reais FÁCEIS** (fundo sólido que hoje sai perfeito — você
   escolhe as "padrão-ouro" do fluxo atual) para `/srv/dexo-bench/images/easy/`.
   São elas que definem a não-regressão dali pra frente.

⚠️ Restrições das fontes (senão o bench/golden aborta ou distorce):
- cada arquivo **< 9 MB** (o sidecar rejeita >10MB com 413);
- cada imagem **< 6 MP** (o cap `REMBG_MAX_INPUT_MP=6` faria downscale e o
  golden compararia coisas diferentes). Foto de celular ~1600px ≈ 2 MP = ok;
  **não** usar os `.orig` full-res do servidor.

## 1. Subir o container de bench com PARIDADE DE ENV DA PROD

```bash
cd /var/www/dexo
docker build -t dexo-rembg-bench ./infra/rembg
docker run --rm -d --name dexo-rembg-bench \
  -p 127.0.0.1:8001:8000 \
  -e REMBG_WORKERS=1 -e OMP_NUM_THREADS=8 \
  -e REMBG_ORT_TUNE=true -e REMBG_INTRA_OP_THREADS=6 \
  -e MALLOC_ARENA_MAX=2 \
  -e REMBG_ORT_DISABLE_ARENA=false \
  -e REMBG_ASYNC_OFFLOAD=false -e REMBG_MAX_PENDING=8 \
  -e REMBG_PROFILE=true \
  -e REMBG_SKIP_DISCONNECTED=true \
  -e REMBG_SHADOW_SIGMA_CAP=12 \
  -e REMBG_MAX_INPUT_MP=6 \
  --memory 12g \
  -v /var/www/dexo/infra/rembg/bench:/bench \
  -v /srv/dexo-bench/images:/images \
  -v /srv/dexo-bench/golden:/golden \
  dexo-rembg-bench
```

Aguardar o modelo carregar (~1–2 min) e **conferir a paridade** (os campos de
tunables têm que bater com a live):

```bash
sleep 90
echo "--- BENCH ---"; curl -s http://127.0.0.1:8001/health
echo; echo "--- LIVE ----"; curl -s http://127.0.0.1:8000/health
```

Sanidade das fontes (dimensões/peso — nada pode passar de 6 MP / 9 MB):

```bash
docker exec dexo-rembg-bench python - <<'EOF'
import glob, os
from PIL import Image
for p in sorted(glob.glob("/images/easy/*") + glob.glob("/images/hard/*")):
    im = Image.open(p); mp = im.width*im.height/1e6; mb = os.path.getsize(p)/1e6
    flag = "  <-- FORA DO LIMITE!" if mp > 6 or mb > 9 else ""
    print(f"{p}: {im.width}x{im.height} ({mp:.1f} MP, {mb:.1f} MB){flag}")
EOF
```

## 2. Tabela estágio→ms (H1)

```bash
# sintéticas (determinísticas, seed fixa):
docker exec dexo-rembg-bench python /bench/gen_synthetic.py --out /images/synthetic

# fáceis — referência de custo (~10-12 min):
docker exec dexo-rembg-bench python /bench/bench.py \
  --url http://127.0.0.1:8000/remove-bg --images /images/easy \
  --iters 5 --warmup 1 --skip-batch

# difíceis, UMA POR VEZ (o estágio→ms POR IMAGEM é o que interessa; ~3 min cada):
docker exec dexo-rembg-bench python /bench/bench.py \
  --url http://127.0.0.1:8000/remove-bg \
  --images /images/hard/hard_A_coxim_bancada_preta.jpg \
  --iters 6 --warmup 1 --skip-batch

docker exec dexo-rembg-bench python /bench/bench.py \
  --url http://127.0.0.1:8000/remove-bg \
  --images /images/hard/hard_B_barra_concreto_sol.jpg \
  --iters 6 --warmup 1 --skip-batch

# fila (critério de aceite fala em lote de 10 com concorrência 2 = front atual):
docker exec dexo-rembg-bench python /bench/bench.py \
  --url http://127.0.0.1:8000/remove-bg --images /images/hard \
  --skip-single --batch 10 --concurrency 2 --repeats 2 --timeout 300
```

O que vamos ler na saída: `refine`, `shadow`, `encode` e `bytes de saida` das
difíceis vs fáceis. H1 confirmada = difíceis com refine/encode 2–3×+ e/ou
out_bytes ~2×+ (alpha espalhado comprime mal).

## 3. H5 — qualidade real, SEM orçamento

```bash
for f in /srv/dexo-bench/images/hard/*.jpg; do
  n=$(basename "$f" .jpg)
  curl -sS -m 300 -X POST http://127.0.0.1:8001/remove-bg \
    -F file=@"$f" -o /srv/dexo-bench/h5/${n}.cutout.png
  curl -sS -m 300 -X POST http://127.0.0.1:8001/remove-bg \
    -F file=@"$f" -F add_shadow=true -o /srv/dexo-bench/h5/${n}.shadow.png
done
ls -la /srv/dexo-bench/h5/
```

**Variante de controle** (separa "o modelo erra" de "o refine piora o que o
modelo acertou" — importante para peça preta sobre fundo preto):

```bash
docker rm -f dexo-rembg-bench
# sobe de novo com REFINE OFF (única diferença):
docker run --rm -d --name dexo-rembg-bench \
  -p 127.0.0.1:8001:8000 \
  -e REMBG_WORKERS=1 -e OMP_NUM_THREADS=8 \
  -e REMBG_ORT_TUNE=true -e REMBG_INTRA_OP_THREADS=6 \
  -e MALLOC_ARENA_MAX=2 -e REMBG_ORT_DISABLE_ARENA=false \
  -e REMBG_ASYNC_OFFLOAD=false -e REMBG_MAX_PENDING=8 \
  -e REMBG_PROFILE=true -e REMBG_SKIP_DISCONNECTED=true \
  -e REMBG_SHADOW_SIGMA_CAP=12 -e REMBG_MAX_INPUT_MP=6 \
  -e REMBG_REFINE_EDGES=false \
  --memory 12g \
  -v /var/www/dexo/infra/rembg/bench:/bench \
  -v /srv/dexo-bench/images:/images \
  -v /srv/dexo-bench/golden:/golden \
  dexo-rembg-bench
sleep 90
for f in /srv/dexo-bench/images/hard/*.jpg; do
  n=$(basename "$f" .jpg)
  curl -sS -m 300 -X POST http://127.0.0.1:8001/remove-bg \
    -F file=@"$f" -o /srv/dexo-bench/h5/${n}.norefine.png
done
```

Depois, baixar os PNGs para inspecionar visualmente (da sua máquina):

```bash
scp "root@SEU_HOST:/srv/dexo-bench/h5/*.png" .
```

Anexe os PNGs (ou screenshots deles sobre fundo claro E escuro) na conversa.

## 4. Congelar o golden — RECRIAR o container com env de paridade ANTES

⚠️ O passo 3 deixou o container com `REMBG_REFINE_EDGES=false`. O golden tem que
ser congelado com o env **idêntico ao da live** — recriar primeiro:

```bash
docker rm -f dexo-rembg-bench
docker run --rm -d --name dexo-rembg-bench \
  -p 127.0.0.1:8001:8000 \
  -e REMBG_WORKERS=1 -e OMP_NUM_THREADS=8 \
  -e REMBG_ORT_TUNE=true -e REMBG_INTRA_OP_THREADS=6 \
  -e MALLOC_ARENA_MAX=2 -e REMBG_ORT_DISABLE_ARENA=false \
  -e REMBG_ASYNC_OFFLOAD=false -e REMBG_MAX_PENDING=8 \
  -e REMBG_PROFILE=true -e REMBG_SKIP_DISCONNECTED=true \
  -e REMBG_SHADOW_SIGMA_CAP=12 -e REMBG_MAX_INPUT_MP=6 \
  --memory 12g \
  -v /var/www/dexo/infra/rembg/bench:/bench \
  -v /srv/dexo-bench/images:/images \
  -v /srv/dexo-bench/golden:/golden \
  dexo-rembg-bench
sleep 90 && curl -s http://127.0.0.1:8001/health
```

```bash
# CORE = fáceis + sintéticas -> gate BLOQUEANTE de toda mudança futura (~7 min):
docker exec dexo-rembg-bench python /bench/golden.py save \
  --url http://127.0.0.1:8000/remove-bg --images /images/easy --out /golden/core
docker exec dexo-rembg-bench python /bench/golden.py save \
  --url http://127.0.0.1:8000/remove-bg --images /images/synthetic --out /golden/core

# HARD = as 2 difíceis -> referência informacional (FAIL futuro aqui = progresso):
docker exec dexo-rembg-bench python /bench/golden.py save \
  --url http://127.0.0.1:8000/remove-bg --images /images/hard --out /golden/hard

# Sanidade: comparar contra ele mesmo TEM que dar verde:
docker exec dexo-rembg-bench python /bench/golden.py compare \
  --url http://127.0.0.1:8000/remove-bg --golden /golden/core
```

## 5. Quantificar as falhas de PRODUÇÃO (últimos dias)

```bash
ls -la ~/.pm2/logs/ | grep dexo-api
L=~/.pm2/logs/dexo-api-error.log     # ajustar se o ls mostrar outro nome

echo "gate/orçamento esgotado : $(grep -cF 'fila do sidecar esgotados' $L)"
echo "sidecar falhou (total)  : $(grep -cF 'sidecar rembg falhou' $L)"
echo "  dos quais timeout     : $(grep -cF 'timeout of' $L)"
echo "  dos quais conexão     : $(grep -cE 'ECONNREFUSED|ECONNRESET|socket hang up' $L)"
echo "retries de conexão      : $(grep -cF 'retry único após backoff' $L)"

# distribuição real de estágios na live (profile já está ligado em prod):
docker logs dexo-rembg --since 168h 2>&1 | grep -cF "[rembg-profile]"
echo "--- top 10 piores 'remove' ---"
docker logs dexo-rembg --since 168h 2>&1 | grep -F "[rembg-profile]" | \
  grep -oE "remove=[0-9.]+" | sort -t= -k2 -n | tail -10
echo "--- top 10 piores 'shadow' ---"
docker logs dexo-rembg --since 168h 2>&1 | grep -F "[rembg-profile]" | \
  grep -oE "shadow=[0-9.]+" | sort -t= -k2 -n | tail -10
echo "--- top 10 piores 'refine' ---"
docker logs dexo-rembg --since 168h 2>&1 | grep -F "[rembg-profile]" | \
  grep -oE "refine=[0-9.]+" | sort -t= -k2 -n | tail -10
```

(Nota: os contadores do pm2 são "desde a última rotação de log" — o cron de
retenção roda aos domingos. Diga há quantos dias o log atual começa se souber.)

## 6. Encerrar

```bash
docker rm -f dexo-rembg-bench
free -h && docker stats --no-stream dexo-rembg
```

O golden fica em `/srv/dexo-bench/golden/{core,hard}` — **não commitar**; é o
gate local de todas as mudanças do sidecar deste trabalho.

---

## O que decide o quê (para leitura do relatório)

| Evidência | Decisão |
|---|---|
| `refine+shadow+encode` das difíceis ≫ fáceis (H1) | PR 2 (pós-processamento de máscara) ataca o custo E a qualidade juntos |
| H5: recorte sem orçamento sai BOM | problema é 100% tempo/capacidade → PR 4 (assíncrono) resolve sozinho os casos A/B |
| H5: recorte sai RUIM (fundo/pés/sombra na máscara) | PR 2 vira emergência; PR 3/roteamento forte ganham prioridade |
| H5: `norefine` melhor que `cutout` (peça preta) | tunables do refine entram no escopo do PR 2 |
| Prod: maioria `fila do sidecar esgotados` | fila/orçamento → PR 4 é a resposta certa |
| Prod: maioria `ECONNREFUSED/ECONNRESET` | sidecar morrendo (OOM) → prioridade vai para infra/PR 5 |
