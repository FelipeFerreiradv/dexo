# Runbook de Hardening da VPS — Dexo (Frente C)

> VPS: `srv1141695.hstgr.cloud` · Hostinger **KVM8** · Ubuntu 24.04 + CloudPanel · IP `72.61.57.38`.
> Estado inicial (painel): **Firewall: 0 regras** · **Malware scanner: não instalado** · **root SSH habilitado** · rembg em `0.0.0.0:8000` · **Backups: 2 snapshots**.
> **Você (Felipe) executa via SSH.** Cada passo tem verificação e rollback. Faça **um snapshot da VPS no painel antes de começar**.

## Ordem segura (não inverta)

A ordem evita lockout: firewall libera SSH antes de tudo; o corte do root SSH só acontece depois de validar a chave.

### Passo 0 — Snapshot + sessão de segurança

1. Painel Hostinger → VPS → **criar snapshot** (rollback de emergência).
2. Abra **duas** sessões SSH root e deixe ambas abertas durante o processo.
   ```bash
   ssh root@72.61.57.38
   ```

### Passo 1 — Firewall (UFW)

```bash
# copie os scripts para a VPS (scp) ou cole o conteúdo:
sudo bash ufw-setup.sh --dry-run     # revise o que fará
sudo bash ufw-setup.sh               # aplica (libera SSH ANTES de ativar)
```

**Verificar:** `sudo ufw status verbose` (22/80/443 abertos; 3000/3333/8000 negados).
Em outra sessão, confirme que o SSH ainda conecta.
**Rollback:** `sudo ufw disable`.

### Passo 2 — Fechar o rembg (porta 8000)

A correção do bind está no repo (`docker-compose.yml` → `127.0.0.1:8000:8000`). Faça deploy e recrie o container:

```bash
cd /caminho/do/projeto
git pull
docker compose up -d --force-recreate rembg
```

**Verificar:**

```bash
ss -tlnp | grep 8000           # deve mostrar 127.0.0.1:8000, NÃO 0.0.0.0:8000
curl -s http://127.0.0.1:8000/health   # deve responder localmente
curl -s --max-time 5 http://72.61.57.38:8000/health || echo "OK: 8000 nao acessivel externamente"
```

**Rollback:** reverter o `docker-compose.yml` e `docker compose up -d --force-recreate rembg` (não recomendado — reabre o DoS).

### Passo 3 — SSH hardening (sem root, key-only)

Siga **`ssh-hardening.md`** à risca (tem a trava anti-lockout). Resumo:

1. `adduser deploy` + `usermod -aG sudo deploy`.
2. Instalar sua chave pública em `deploy`.
3. **Testar `ssh deploy@... ` + `sudo whoami` em nova sessão ANTES de mexer no sshd.**
4. `PermitRootLogin no`, `PasswordAuthentication no` → `sshd -t && systemctl reload ssh`.
5. Validar (deploy entra, root é recusado) e só então fechar a sessão root.
   **Rollback:** restaurar `/etc/ssh/sshd_config.bak.*` + `systemctl reload ssh`; em último caso, console/VNC do painel.

### Passo 4 — fail2ban

```bash
sudo bash fail2ban-setup.sh
```

**Verificar:** `sudo fail2ban-client status sshd`.
**Rollback:** `sudo systemctl stop fail2ban && sudo systemctl disable fail2ban`.

### Passo 5 — Atualizações automáticas de segurança

```bash
sudo bash unattended-upgrades.sh
```

**Verificar:** `systemctl status unattended-upgrades` e o dry-run impresso.

### Passo 6 — Permissões de segredos em disco

```bash
# .env do app: dono = usuário do app, 600
sudo chown deploy:deploy /caminho/do/projeto/.env
sudo chmod 600 /caminho/do/projeto/.env

# FISCAL_STORAGE_PATH (certs A1 + XMLs): fora do dir servido pela web, 700
sudo chmod 700 "$FISCAL_STORAGE_PATH"
find "$FISCAL_STORAGE_PATH" -type f -name '*.pfx' -exec chmod 600 {} \;
```

**Verificar:** `ls -la` mostra `600`/`700` e dono correto.

### Passo 7 — Itens de painel (ver ACOES_MANUAIS_SEGURANCA.md)

Firewall do painel, **backup diário**, **auto-renew (expira 2026-07-10)**, **malware scanner**, CloudPanel 2FA + restrição de IP no 8443.

### Passo 8 — nginx: timeouts do proxy e CORS nas respostas de erro

> **Contexto:** o modal de criação de produto mostrava `Status code: 504` +
> `CORS header 'Access-Control-Allow-Origin' missing` no upload com remoção de
> fundo. O 504 é gerado pelo **nginx**, não pelo app — e por isso não passa pelo
> `@fastify/cors`, o browser descarta a resposta e a imagem se perde. O app já
> foi corrigido para **sempre responder dentro de ~45s** (degradando para imagem
> otimizada + aviso). Este passo é **defesa em profundidade**.

> ⚠️ **`api.usedexo.com.br` NÃO é um Site do CloudPanel.** É um vhost **manual**
> em `/etc/nginx/conf.d/usedexo.com.br.conf` (o `sites-available/usedexo.com.br`
> existe mas **não** está enabled). Logs em `/var/log/nginx/`, não em
> `/home/<site-user>/logs/`. Confirme antes de editar qualquer coisa.

#### ✅ Valores CONFIRMADOS em produção (medidos 2026-07-21)

Rodamos o 8.1 na VPS durante o incidente. Não é mais hipótese — quem for ler isto
depois não precisa redescobrir:

| Item | Valor real | Como se sabe |
|---|---|---|
| `proxy_read_timeout` do vhost da API | **NÃO EXISTE** → default de fábrica do nginx = **60s** | O único `proxy_read_timeout` de toda a config está no bloco do `felipeferreiradev.com`, não no da API |
| `REMBG_TIMEOUT_MS` no `.env` de prod | **60000** | O log do app dizia `timeout of 60000ms exceeded` |
| `client_max_body_size` | **64M**, global em `/etc/nginx/nginx.conf` | Sem override por vhost |
| Assinatura do erro | `upstream timed out ... while reading response header` | `error.log`, em todos os casos |

**A causa-raiz, em uma linha:** o nginx cortava em 60s e o axios só desistia aos
60s — **empate perfeito**, então a degradação graceful disparava sempre depois de
o proxy já ter desistido, e nunca chegava ao usuário. Com o orçamento por
requisição em vigor, o backend responde em ~43s e sobram ~17s de margem.

#### 8.1 — Diagnóstico PRIMEIRO (não pule: é o que fecha a causa-raiz)

```bash
# Onde o vhost realmente está e quais timeouts valem hoje.
# ATENÇÃO ao ler: os números de linha do `nginx -T` são do dump CONCATENADO.
# Compare a linha do proxy_read_timeout com a do server_name ANTERIOR a ela para
# saber a que vhost ele pertence — foi assim que descobrimos que o da API não tem.
nginx -T 2>/dev/null | grep -nE 'server_name|proxy_read_timeout|proxy_send_timeout|client_max_body_size'
ls -la /etc/nginx/conf.d/ /etc/nginx/sites-enabled/

# O bloco da API inteiro (é aqui que entram os timeouts do 8.2):
sed -n '/server_name api.usedexo.com.br/,/^}/p' /etc/nginx/conf.d/usedexo.com.br.conf

# O motivo exato, no error.log — ESTE é o detector confiável:
grep -F 'upstream timed out' /var/log/nginx/*error.log | grep -i upload | tail -20

# Cruzar com o app no MESMO horário:
pm2 logs dexo-api --lines 500 --nostream | grep -E 'sidecar rembg falhou|orçamento/fila'
```

> ⚠️ **NÃO use o `access.log` como detector.** O formato em uso não casa com
> `grep ' /upload/image '` — o comando volta **vazio mesmo durante o incidente**,
> e vazio aqui parece "está tudo bem". Use sempre o `error.log`.

> ⚠️ **`pm2 logs --nostream` lê o buffer ACUMULADO**, inclusive de antes do
> restart. Depois de um deploy, rode `pm2 flush dexo-api` **antes** de conferir,
> senão você vai reler os erros antigos e achar que o fix não pegou.

**Como ler:**

| Evidência | Conclusão |
|---|---|
| `upstream timed out ... while reading response header` | É o `proxy_read_timeout`. Causa confirmada. |
| `... while connecting to upstream` | O Fastify não estava aceitando conexão (outro problema). |
| `socket hang up` / `read ECONNRESET` no log do app | O **sidecar fechou a conexão** — não é fila, é container morrendo. Ver 8.5. |
| `$status 413` com `$request_time < 1s` | Corpo grande — ver 8.3. |
| Nenhuma entrada no nginx | O 504 veio de algo **na frente** do nginx (CDN/WAF). |
| `sidecar rembg falhou` ANTES do corte | A degradação funcionou; investigar outra causa. |
| `timeout of 60000ms exceeded` **depois** do deploy do orçamento | O código novo NÃO está rodando (o teto passou a ser ~42000). |

#### 8.2 — Alinhar os timeouts

O bloco da API hoje está **exatamente assim** (sem nenhum timeout, por isso o
default de 60s), em `/etc/nginx/conf.d/usedexo.com.br.conf`:

```nginx
server_name api.usedexo.com.br;
...
location / {
  proxy_pass http://backend;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Acrescente as duas linhas **dentro desse `location /`**:

```nginx
proxy_read_timeout 120s;
proxy_send_timeout 120s;
```

O app degrada sozinho em ~43s, então o nginx só cortaria numa anomalia real.
Para ajustar o orçamento do app sem redeploy, use `UPLOAD_HANDLER_BUDGET_MS` no
`.env` (default 45000) — mantenha-o **bem abaixo** do valor acima.

> Note que o upstream é o `upstream backend` (não um `proxy_pass` literal para
> `127.0.0.1:3333`) — não confunda ao procurar o bloco.

**Verificar:** `nginx -t && systemctl reload nginx`, depois repetir o upload com
"Remover fundo" + "Adicionar sombra" ligados.
**Rollback:** remover as duas linhas e `nginx -t && systemctl reload nginx`.

#### 8.3 — Conferir o limite de corpo (provavelmente já OK)

```bash
nginx -T 2>/dev/null | grep -n client_max_body_size
```

Verificado em 2026-07-08: é **global** em `/etc/nginx/nginx.conf` = `64M`, sem
override por vhost — folgado para os 20 MB que o app aceita. **Só confirme.** Se
algum dia aparecer um valor `< 20M`, suba para `64M`.

#### 8.4 — CORS **apenas** nas respostas de erro geradas pelo nginx

Sem isto, um 502/504 chega ilegível ao browser (`TypeError` opaco) e o front não
consegue diferenciar timeout de falha real.

```nginx
# DENTRO do location que faz proxy_pass:
proxy_intercept_errors on;
error_page 502 503 504 = @api_error;

# NO MESMO server block:
location @api_error {
    add_header 'Access-Control-Allow-Origin' 'https://app.usedexo.com.br' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;
    add_header 'Vary' 'Origin' always;
    default_type application/json;
    return 504 '{"error":"Gateway Timeout","message":"O servidor de imagens esta sobrecarregado. Tente novamente."}';
}
```

> ⚠️ **ALERTA CRÍTICO — NÃO duplicar o header.** Ponha o `add_header` **somente**
> na location de erro. O Fastify já envia `Access-Control-Allow-Origin` em todas
> as respostas que ele mesmo produz; **dois** headers `Access-Control-Allow-Origin`
> fazem o navegador **rejeitar a resposta inteira** — você trocaria um bug por
> outro pior, que atingiria o caminho feliz.
>
> Troque `https://app.usedexo.com.br` pelo valor **exato** de `CORS_ORIGIN` do
> `.env` (`grep '^CORS_ORIGIN=' /var/www/dexo/.env`). Precisa bater byte a byte:
> sem barra final, com o mesmo esquema/host/porta.

**Verificar:** com o app parado (`pm2 stop dexo-api`), um `curl -i -H 'Origin: <CORS_ORIGIN>'
https://api.usedexo.com.br/upload/image -X POST` deve trazer **exatamente um**
`Access-Control-Allow-Origin`. Religue com `pm2 start dexo-api`.
**Rollback:** remover o `error_page`/`location @api_error` + `nginx -t && systemctl reload nginx`.

#### 8.5 — Saúde do sidecar rembg (memória e reinícios)

Se o log do app mostrar `socket hang up` ou `read ECONNRESET` vindos do sidecar,
**não é fila** — fila produz *timeout*. Esses dois significam que o container
fechou a conexão no meio, ou seja: morreu e reiniciou.

```bash
docker inspect dexo-rembg --format 'restarts={{.RestartCount}}'
docker stats --no-stream dexo-rembg
free -g

# ESTE é o que decide. Os demais só dão indício.
dmesg -T | grep -iE 'oom|killed process' | tail -20
```

> ⚠️ **`{{.State.OOMKilled}}` e `{{.State.ExitCode}}` NÃO servem como histórico.**
> Eles descrevem a execução **atual**. Como o `restart: unless-stopped` sobe o
> container de novo em segundos, você lê `oom=false exit=0` mesmo tendo havido
> quatro OOM kills na última hora. Idem `docker ps`: mostra `Up ... (healthy)`
> entre os kills. **O `dmesg` é a única fonte confiável de histórico.**

**Como ler o `dmesg`:**

| Evidência | Conclusão |
|---|---|
| `constraint=CONSTRAINT_MEMCG` + `oom_memcg=/system.slice/docker-<id>` | Estourou o **`mem_limit` do container**. O host está bem. |
| `constraint=CONSTRAINT_NONE` | Estourou a RAM do **HOST** — isso derruba o app inteiro, é muito mais grave. |
| `anon-rss` da linha `Killed process` | O working set real no instante do kill. Compare com o `mem_limit`. |
| `RestartCount` subindo sem nada no `dmesg` | Crash do processo, não OOM — ver `docker logs dexo-rembg`. |

**Medido em 2026-07-21 — OOM do cgroup CONFIRMADO:**

- `RestartCount = 159`; **4 kills em 53 min** (11:46, 12:11, 12:13, 12:39).
- `anon-rss` no kill: **~11,9 GiB** contra o `mem_limit` de 12 GiB.
- `constraint=CONSTRAINT_MEMCG` → é o limite do container, **não** o do host.
- Host folgado: 31 GiB totais, **16 GiB disponíveis**.
- `total-vm ~23,3 GB` contra `anon-rss ~11,9 GiB` — reserva virtual grande,
  assinatura típica de arena de alocador.

Ou seja: o comentário do `docker-compose.yml` que diz *"pico ~8,5 GB; 12g cobre
com folga"* está **desatualizado**. O working set real é ~40% maior que isso.

> ⚠️ **NÃO suba o `mem_limit` como primeira ação.** Se o crescimento for
> ilimitado, subir o limite apenas **move o OOM do container para o HOST** — e aí
> em vez de um container reiniciando (degradação graceful) você derruba API,
> frontend e workers de uma vez. Trate a causa primeiro. Lembre também que
> `REMBG_WORKERS=2` já foi testado e **descartado** (~20 GB, OOM).

**Ordem de investigação da causa (da menor para a maior fricção):**

1. **Fragmentação do malloc do glibc.** `OMP_NUM_THREADS=8` sem `MALLOC_ARENA_MAX`
   faz o glibc criar até `8 × núcleos` arenas, uma por thread que aloca; cada uma
   fragmenta por conta própria e o RSS nunca volta pro SO. Mitigação **só por env,
   sem rebuild**, já aplicada no `docker-compose.yml`: `MALLOC_ARENA_MAX: "2"`.
   (Só vale porque a imagem é `python:3.11-slim` = Debian/**glibc**; em
   Alpine/musl seria inerte.)

   > **Correção de uma recomendação anterior deste runbook:** uma versão prévia
   > sugeria também `MALLOC_TRIM_THRESHOLD_: "134217728"`. **Isso está na direção
   > errada** — o `M_TRIM_THRESHOLD` é o mínimo de espaço livre no topo do heap
   > *antes* de devolver ao SO, então um valor ALTO faz o glibc devolver MENOS
   > memória, não mais. Não use.

   1b. Se `MALLOC_ARENA_MAX` sozinho não bastar, o próximo lever é
   `MALLOC_MMAP_THRESHOLD_` explícito (ex.: `"131072"`). Ele ataca outro
   mecanismo: ao liberar um bloco mmap'ado, o glibc **sobe dinamicamente** o
   limiar de mmap (até 32 MB) e passa a servir blocos grandes pelo heap via
   `sbrk` — e esses **não** voltam pro SO no `free`. Fixar o valor desliga esse
   ratchet. Também é só env.
2. **Arena do ONNX Runtime.** `enable_cpu_mem_arena` é `True` por default e a
   estratégia de extensão dobra sem devolver memória. Exige rebuild: setar
   `so.enable_cpu_mem_arena = False` no `_build_tuned_session` de
   `infra/rembg/app.py`, atrás de flag. É troca de **alocador**, não de
   matemática — a saída é bit-idêntica —, mas rode o gate SSIM assim mesmo.
3. **Reciclagem controlada** do worker após N requisições: pior que corrigir a
   causa, porém muito melhor que o OOM atual, porque termina a resposta antes de
   sair em vez de matar a conexão no meio.

#### 8.6 — Aplicar e MEDIR o `MALLOC_ARENA_MAX`

**Antes** de aplicar, anote a linha de base (senão não dá para saber se melhorou):

```bash
docker inspect dexo-rembg --format 'restarts={{.RestartCount}}'
dmesg -T | grep -c 'Killed process.*uvicorn'
date
```

Aplicar (o `git pull` já traz o compose novo; **não** precisa de rebuild):

```bash
cd /var/www/dexo && git pull
# --env-file /dev/null: o .env do app quebra o parser do compose (gotcha conhecido).
# O compose só tem o serviço rembg e não usa ${...}, então ignorar o .env é seguro.
docker compose --env-file /dev/null up -d rembg
docker exec dexo-rembg printenv MALLOC_ARENA_MAX     # tem que imprimir 2
curl -s localhost:8000/health                        # sidecar de pé
```

**Medir** ao longo de algumas horas de uso real (o RSS cresce com a carga, não com
o tempo ocioso — sem upload não há o que medir):

```bash
watch -n 300 "docker stats --no-stream --format '{{.MemUsage}} {{.MemPerc}}' dexo-rembg"
dmesg -T | grep 'Killed process.*uvicorn' | tail -5
docker inspect dexo-rembg --format 'restarts={{.RestartCount}}'
```

| Resultado após algumas horas de uso | Leitura |
|---|---|
| RSS estabiliza bem abaixo de 12 GiB e `RestartCount` para de subir | ✅ era fragmentação de arena — resolvido |
| RSS ainda escala até ~11,9 GiB e os kills continuam | ❌ o dominante é a arena do ONNX — ir para o item 2 (rebuild) |
| RSS menor, mas ainda com kills esporádicos | Parcial — tentar o **1b** (`MALLOC_MMAP_THRESHOLD_`) antes do rebuild |

**Rollback** (instantâneo, sem rebuild): remover a linha `MALLOC_ARENA_MAX` do
`docker-compose.yml` e repetir o `docker compose --env-file /dev/null up -d rembg`.

Enquanto a causa não é tratada, o impacto no usuário é **degradação graceful**
(imagem otimizada + aviso), não perda de imagem — o orçamento por requisição já
cobre esse caso. É melhoria de capacidade, não incêndio.

## Verificações finais (checklist)

- [ ] `ss -tlnp` — só 22/80/443 públicos; 3333/8000 em 127.0.0.1.
- [ ] `ufw status verbose` — default deny incoming.
- [ ] `ssh root@...` recusado; `ssh deploy@...` por chave OK.
- [ ] `fail2ban-client status sshd` ativo.
- [ ] App funcionando (home, login, upload de imagem usando o rembg local).
- [ ] `nginx -T | grep proxy_read_timeout` — 120s no vhost da API.
- [ ] Upload no modal com "Remover fundo" + "Adicionar sombra": ou sai o PNG
      recortado, ou sai a imagem otimizada **com aviso** — nunca "falhou".
- [ ] `curl -i` num erro do nginx traz **um único** `Access-Control-Allow-Origin`.
- [ ] `pm2 flush dexo-api` + upload de teste ⇒ **nenhum** `sidecar rembg falhou`.
- [ ] `dmesg -T | grep -i oom` — sem kills recentes do `dexo-rembg` (o
      `docker ps`/`OOMKilled` NÃO detectam isso; ver 8.5).
- [ ] Snapshot/backup recente existe.
