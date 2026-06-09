# Sidecar rembg

Servico Python (FastAPI + rembg/IS-Net) que remove o fundo de
imagens. O backend do Dexo o consome via `POST /remove-bg`. Killswitch por
env `REMBG_ENABLED=false` no app principal (sidecar nem precisa estar de pe
nesse caso).

Apos o recorte, faz um **refino de borda** (despill da cor do fundo antigo +
shaping do alpha) pra borda nitida sem halo borrado nem serrilhado. E'
conservador: nao regride o recorte de fundo solido, que ja sai perfeito.

Opcionalmente adiciona uma **sombra de contato** suave sob a peca (campo de
form `add_shadow=true`, default `false`). Derivada da silhueta (alpha),
achatada e ancorada na base, com blur — aspecto de peca apoiada. Sem o campo,
o comportamento e' identico ao de hoje.

## Endpoints

- `GET /health` — liveness. Devolve
  `{"status":"ok","model":"isnet-general-use","refine":true,"shadow":true}`.
- `POST /remove-bg` — multipart `file=<image>` + opcional `add_shadow=true|false`
  (default `false`). Retorna `image/png` transparente. Limite 10 MB de entrada.

## Subir local

```bash
docker compose up rembg --build
```

A primeira build pre-baixa o modelo (~178 MB p/ o `isnet-general-use`).
Em seguida o servico responde em `http://localhost:8000`.

## Smoke test

```bash
curl -fsS http://localhost:8000/health
# {"status":"ok","model":"birefnet-general-lite","refine":true,"shadow":true}

curl -fsS -X POST http://localhost:8000/remove-bg \
  -F file=@./alguma-foto.jpg \
  -o saida.png
# saida.png deve ser PNG transparente

# Com sombra de contato:
curl -fsS -X POST http://localhost:8000/remove-bg \
  -F file=@./alguma-foto.jpg \
  -F add_shadow=true \
  -o saida_sombra.png
```

## Troca de modelo e tuning do refino

Modelo trocavel no build, sem editar codigo (pre-baixa o escolhido). Default
`isnet-general-use` (~1s/img, pico ~1.6GB RAM). Para maxima qualidade em fundo
complexo, suba pro birefnet (custa ~7s + pico ~8.5GB RAM — exige RAM no
servidor e `mem_limit` maior no compose):

```bash
docker compose build --build-arg REMBG_MODEL=birefnet-general-lite rembg
# qualidade x custo: birefnet-general-lite (top) > isnet-general-use (default) > u2net
```

Refino de borda ajustavel por env (defaults calibrados). Killswitch:
`REMBG_REFINE_EDGES=false` volta pro recorte cru do modelo, sem rebuild.
Outros: `REMBG_DESPILL_ITERS`, `REMBG_EDGE_ALPHA_LO`/`_HI`,
`REMBG_EDGE_FEATHER_PX`, `REMBG_EDGE_ERODE_PX`, `REMBG_POST_PROCESS_MASK`.

Sombra de contato ajustavel por env. Killswitch global:
`REMBG_SHADOW_ENABLED=false` ignora `add_shadow` sem rebuild. Outros:
`REMBG_SHADOW_OPACITY` (~0.30-0.45), `REMBG_SHADOW_COLOR` (`r,g,b`),
`REMBG_SHADOW_SQUASH`, `REMBG_SHADOW_BLUR`, `REMBG_SHADOW_OFFSET_Y`,
`REMBG_SHADOW_WIDTH`, `REMBG_SHADOW_PAD_X`/`_BOTTOM`/`_TOP`,
`REMBG_SHADOW_MAX_LONG` (cap do lado longo, default 1600).

## Configuracao no app principal

`.env`:

```env
REMBG_SIDECAR_URL=http://localhost:8000
REMBG_TIMEOUT_MS=30000
REMBG_ENABLED=true
```

> O default de `REMBG_TIMEOUT_MS` é 30000 (cobre folgado o isnet ~1s e o
> birefnet ~7s). Ajuste o `.env` do servidor se ainda estiver em 15000.

`REMBG_ENABLED=false` desliga a feature sem rebuild — uploads com toggle
ligado seguem em fallback graceful (imagem original sem remocao de
fundo, com aviso).
