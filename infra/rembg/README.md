# Sidecar rembg

Servico Python (FastAPI + rembg/U2Net) que remove o fundo de imagens. O
backend do Dexo o consome via `POST /remove-bg`. Killswitch por env
`REMBG_ENABLED=false` no app principal (sidecar nem precisa estar de pe
nesse caso).

## Endpoints

- `GET /health` — liveness. Devolve `{"status":"ok","model":"u2net"}`.
- `POST /remove-bg` — multipart `file=<image>`. Retorna `image/png`
  transparente. Limite 10 MB de entrada.

## Subir local

```bash
docker compose up rembg --build
```

A primeira build pre-baixa o modelo U2Net (~170 MB). Em seguida o
servico responde em `http://localhost:8000`.

## Smoke test

```bash
curl -fsS http://localhost:8000/health
# {"status":"ok","model":"u2net"}

curl -fsS -X POST http://localhost:8000/remove-bg \
  -F file=@./alguma-foto.jpg \
  -o saida.png

# saida.png deve ser PNG transparente
```

## Configuracao no app principal

`.env`:

```env
REMBG_SIDECAR_URL=http://localhost:8000
REMBG_TIMEOUT_MS=15000
REMBG_ENABLED=true
```

`REMBG_ENABLED=false` desliga a feature sem rebuild — uploads com toggle
ligado seguem em fallback graceful (imagem original sem remocao de
fundo, com aviso).
