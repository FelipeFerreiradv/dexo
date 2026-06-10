# Sidecar rembg

Servico Python (FastAPI + rembg/BiRefNet-lite) que remove o fundo de
imagens. O backend do Dexo o consome via `POST /remove-bg`. Killswitch por
env `REMBG_ENABLED=false` no app principal (sidecar nem precisa estar de pe
nesse caso).

Apos o recorte, faz um **refino de borda** (despill da cor do fundo antigo +
shaping do alpha) pra borda nitida sem halo borrado nem serrilhado. E'
conservador: nao regride o recorte de fundo solido, que ja sai perfeito.

Opcionalmente adiciona uma **sombra projetada direcional** (drop shadow) atras
da peca (campo de form `add_shadow=true`, default `false`). Derivada da
silhueta (alpha): deslocada + inclinada na direcao da luz (default de cima-
esquerda => sombra p/ baixo-direita) + blur — estilo foto de produto. Sem o
campo, o comportamento e' identico ao de hoje.

## Endpoints

- `GET /health` — liveness. Devolve
  `{"status":"ok","model":"birefnet-general-lite","refine":true,"shadow":true}`.
- `POST /remove-bg` — multipart `file=<image>` + opcional `add_shadow=true|false`
  (default `false`). Retorna `image/png` transparente. Limite 10 MB de entrada.

## Subir local

```bash
docker compose up rembg --build
```

A primeira build pre-baixa o modelo (~224 MB p/ o `birefnet-general-lite`).
Em seguida o servico responde em `http://localhost:8000`.

## Smoke test

```bash
curl -fsS http://localhost:8000/health
# {"status":"ok","model":"birefnet-general-lite","refine":true,"shadow":true}

curl -fsS -X POST http://localhost:8000/remove-bg \
  -F file=@./alguma-foto.jpg \
  -o saida.png
# saida.png deve ser PNG transparente

# Com sombra projetada:
curl -fsS -X POST http://localhost:8000/remove-bg \
  -F file=@./alguma-foto.jpg \
  -F add_shadow=true \
  -o saida_sombra.png
```

## Troca de modelo e tuning

Modelo trocavel no build, sem editar codigo (pre-baixa o escolhido). Default
`birefnet-general-lite` (melhor borda + fundo complexo; pico ~8.5 GB RAM em
CPU — requer servidor com folga, ex. KVM8/32 GB; `mem_limit: 12g` no compose).
Variante leve p/ hosts pequenos (~1.6 GB / ~1s):

```bash
docker compose build --build-arg REMBG_MODEL=isnet-general-use rembg
# qualidade x custo: birefnet-general-lite (default) > isnet-general-use > u2net
```

**Velocidade:** o birefnet em CPU e' memory-bound (~7s/img e' o piso; mais
nucleos/workers nao aceleram — nos testes 4 nucleos ~= 8). Default **1 worker**
(`REMBG_WORKERS=1`, `OMP_NUM_THREADS=8`): imagem unica mais rapida + menos RAM.
A sensacao de rapidez no LOTE vem do **upload progressivo** (cada imagem
aparece assim que fica pronta, no front). Multi-worker fica configuravel
(`REMBG_WORKERS` x `OMP_NUM_THREADS` ~= vCPUs; ~8.5 GB/worker) caso o host
tenha banda de memoria sobrando. Velocidade *real* do birefnet so com GPU.

Refino de borda ajustavel por env (defaults calibrados). Killswitch:
`REMBG_REFINE_EDGES=false` volta pro recorte cru do modelo, sem rebuild.
Outros: `REMBG_DESPILL_ITERS`, `REMBG_EDGE_ALPHA_LO`/`_HI`,
`REMBG_EDGE_FEATHER_PX`, `REMBG_EDGE_ERODE_PX`, `REMBG_POST_PROCESS_MASK`.

Sombra projetada ajustavel por env (sem rebuild — basta restart). Killswitch
global: `REMBG_SHADOW_ENABLED=false` ignora `add_shadow`. Direcao/forma:
`REMBG_SHADOW_OFFSET_X`/`_Y` (deslocamento, sinais invertem a direcao),
`REMBG_SHADOW_SHEAR` (inclinacao/projecao), `REMBG_SHADOW_BLUR` (suavidade),
`REMBG_SHADOW_OPACITY` (~0.30-0.50), `REMBG_SHADOW_COLOR` (`r,g,b`),
`REMBG_SHADOW_MAX_LONG` (cap do lado longo, default 1600).

## Configuracao no app principal

`.env`:

```env
REMBG_SIDECAR_URL=http://localhost:8000
REMBG_TIMEOUT_MS=60000
REMBG_ENABLED=true
```

> `REMBG_TIMEOUT_MS` default 60s: o BiRefNet leva ~7s/img em CPU e, no upload
> em lote, a fila no sidecar (1 worker) faz as ultimas imagens esperarem. 60s
> cobre com folga. O front envia o lote em blocos pequenos pra nenhuma estourar.

`REMBG_ENABLED=false` desliga a feature sem rebuild — uploads com toggle
ligado seguem em fallback graceful (imagem original sem remocao de
fundo, com aviso).
