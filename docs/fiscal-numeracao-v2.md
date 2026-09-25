# Numeração NF-e V2 — operação

As flags são avaliadas no servidor a cada chamada. Habilitar exige `NFE_NUMERACAO_V2_ENABLED=true` e o ID da **configuração fiscal** em `NFE_NUMERACAO_V2_CONFIG_IDS`. Lista vazia não habilita nenhuma empresa; `*` habilita todas, mas só quando é o valor inteiro (`id,*` libera só o `id`). Em produção a regra é lista explícita, nunca `*` (ver "Rollout e rollback"). O modelo padrão é 55. Focus exige também `NFE_NUMERACAO_V2_FOCUS_ENABLED=true`, que **não tem allowlist própria: lê a mesma `NFE_NUMERACAO_V2_CONFIG_IDS`** — ligá-la vale para toda config da lista, não por empresa.

## Persistência e concorrência

`NfeNumeroReserva` guarda a identidade fiscal; `NfeNumeroTentativa` registra cada transmissão. O repositório usa SQL parametrizado e transações com cliente injetável. A ordem é sequência → reserva → tentativas → nota. A reserva/reutilização e os cálculos da nota são gravados na mesma transação. Um contador nunca diminui (`GREATEST`). Não existe reaproveitamento entre documentos.

Salvar como DRAFT não libera a reserva. A mesma nota reutiliza seu número após rejeição conclusiva ou consulta madura que encerre todas as tentativas. Legado só é adotado com evidência; linhas Focus legadas não são adotadas automaticamente. Contador inicial considera chaves autorizadas/canceladas/em envio e inutilizações aceitas, não o maior número de rascunho.

O claim pré-envio usa a versão da nota; reutilizar a reserva avança sua versão. Antes da rede, o XML assinado é armazenado (SEFAZ) e a tentativa/lease é persistida. Respostas atrasadas precisam da mesma versão da reserva. Uma falha de preparação preserva o número e não registra uma transmissão.

## Situação e descarte

`POST /fiscal/nfe/:id/consultar-situacao` nunca transmite. Consulta respeita emitente, ambiente e provedor da tentativa. Timeout/resultado inconclusivo conserva a reserva. Ausência só encerra tentativa madura; a nota só é liberada quando todas estiverem encerradas. Legado SENDING sem reserva V2 não é liberado automaticamente.

`POST /fiscal/nfe/:id/issue` aceita `confirmarDescarteNumero`. Em produção, troca de empresa/ambiente/modelo/série exige confirmação. Exclusão usa `DELETE /fiscal/nfe/draft/:id?descartarNumero=true`; reserva abandonada fica fora de uso e pode exigir inutilização. Números autorizados, cancelados ou pendentes não são liberados pela exclusão.

Correções de prontidão (25/09/2026), que valem só para config na V2:

- **Inutilização.** Linha `DRAFT`/`REJECTED` legada, sem reserva viva no mesmo número, não bloqueia a faixa, como no V1, e a linha fica como está. Reserva `RESERVADO`, `REJEITADO` ou `BLOQUEADO` na faixa responde 409 `NUMERACAO_CONFIRMAR_DESCARTE` com `detalhes: {numeros, serie}`; repetindo o POST com `confirmarDescarteNumeros: true`, o número vai para `ABANDONADO` e a faixa segue para a SEFAZ. Com `BLOQUEADO` na faixa, antes de confirmar, conferir que o número **não** foi autorizado na SEFAZ; a mensagem do 409 pede o mesmo. A nota `DRAFT`/`REJECTED` que ainda segurava o número volta a rascunho com número provisório e sem chave de acesso e, ao emitir, recebe número novo; é o que o operador vê na lista. Aceita a inutilização, a reserva passa a `INUTILIZADO`; recusada, fica `ABANDONADO` e o número não volta ao uso. Qualquer outra situação na faixa responde 400 `FAIXA_COM_NUMERO_VIVO`, com ou sem a confirmação: nota `AUTHORIZED`, `CANCELLED`, `VALIDATING`, `SIGNING` ou `SENDING`, e reserva `EM_TRANSMISSAO`, `INCERTO`, `AUTORIZADO`, `CANCELADO`, `DENEGADO`, `CONSUMIDO_EXTERNO` ou `INUTILIZADO`. No V1 o campo é ignorado.
- **Reserva BLOQUEADO** tem saída sem excluir a nota: `POST /fiscal/nfe/:id/numeracao/descartar-bloqueado`. Sem `confirmar: true` responde 409 `NUMERACAO_CONFIRMAR_DESCARTE` com `detalhes: {numero, serie}`. Com ele, o número vai para `ABANDONADO`, a nota volta a rascunho com número provisório e o próximo **Emitir** reserva número novo. Reserva que não está em BLOQUEADO responde 409 `NUMERACAO_NAO_BLOQUEADA`. Antes de confirmar, conferir que o número **não** foi autorizado.

### Focus (revisão de 22/09/2026)

A NF-e 55 na Focus é assíncrona: o POST devolve 202 `processando_autorizacao` e o resultado (autorização ou rejeição da SEFAZ) chega pela consulta. Por isso:

- a consulta usa `?completa=1`, única forma de a Focus devolver `protocolo` e `protocolo_nota_fiscal.{numero_protocolo, data_recebimento}`;
- autorização Focus vale com `status: autorizado` e chave de 44 dígitos compatível com o emitente, **mesmo sem protocolo** (o 201 síncrono e a consulta simples não trazem protocolo); no SEFAZ direto o protocolo continua obrigatório;
- rejeição, 108/109 e 656 recebidos na consulta são a resposta da MESMA tentativa: gravam motivo e cStat reais na nota e na reserva (transição INCERTO → REJEITADO/RESERVADO);
- 539/562/613 na consulta: chave citada compatível com emitente/série/número ⇒ `CONSUMIDO_EXTERNO` (a mensagem traz a chave para conferência); chave ausente ou inconsistente ⇒ `BLOQUEADO` para conferência manual. A nota nunca fica INCERTO indefinidamente;
- o payload leva `data_emissao` (obrigatório) do instante da tentativa atual, e esse mesmo instante é gravado em `NfeEmitida.dataEmissao`;
- após o 202, a V2 faz consultas curtas (`NFE_NUMERACAO_V2_FOCUS_PAUSAS_MS`, padrão 2s/3s/4s) antes de responder "em andamento";
- a referência de reemissão é alfanumérica (`<nfeId>n<numero>`).

Falha na pós-autorização (XML/DANFE/auditoria) não desfaz a autorização: fica marcada em `POS_AUTORIZACAO_PENDENTE` e é refeita na próxima consulta/replay, uma única vez (a marca de conclusão é o evento `AUTORIZADA`).

Respostas V2 da emissão, da consulta e do rascunho incluem `numeracao` (null quando não há reserva viva) e `emAndamento`. Na lista e na ficha (`GET /fiscal/nfe` e `GET /fiscal/nfe/:id`), a chave `numeracao` só vem na nota que tem alguma reserva no ledger (null quando nenhuma está viva); a nota de config V2 que nunca teve reserva (legado do V1) vem **sem** a chave e com `legadoV1: true`, e segue a regra do V1. O frontend só promete manutenção quando o servidor informa `reutilizavel`. Na Focus, a chave autorizada prevalece para número/série; divergência é realinhada sem reduzir contador. Chave incompatível com CNPJ/modelo bloqueia para conferência. A referência Focus da tentativa acompanha recuperação de XML e cancelamento.

## Responsável técnico

GET/PUT `/fiscal/config/resp-tec` ou `/fiscal/companies/:id/resp-tec`. Modos: PADRAO, PROVEDOR, PERSONALIZADO e NENHUM, limitados pelo provedor/UF/ambiente. CSRT é cifrado com `FISCAL_CERT_ENC_KEY`; a API retorna apenas `csrtConfigurado`. Token vazio preserva o segredo; remoção exige `removerCsrt`. Não registrar corpos contendo credenciais, CSRT ou XML importado.

## Rollout e rollback

As flags são fail-closed: sem `..._ENABLED=true` e sem o id na allowlist, nenhuma empresa entra na V2. Só liga com o texto exato `"true"` (`"1"` não liga).

### Estado em produção (25/09/2026)

- **Numeração:** desde 22/09/2026, `NFE_NUMERACAO_V2_ENABLED=true` com **uma única config na allowlist**, a DLS AUTO PEÇAS (`cmr9omjlt30xw18jqt3m5oyc3`, modelo 55). Todo o resto da base continua no V1.
- **Devolução:** ligada desde 24/09/2026 para a mesma config (`NFE_DEVOLUCAO_ENABLED=true`, `NFE_DEVOLUCAO_CONFIG_IDS` só com a DLS). As primeiras devoluções reais foram autorizadas em 25/09/2026. `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` está ausente, então vale o padrão 2026-10-05: até 04/10 a produção referencia a original por nota, e a partir de 05/10 por item.
- `NFE_NUMERACAO_V2_FOCUS_ENABLED` e `NFE_RESP_TEC_EMPRESA_ENABLED` seguem desligadas.
- Os três DDLs versionados de 18/09/2026 estão aplicados. Nunca usar `prisma db push`.

### Regra das listas

- **Lista explícita, a mesma nas duas allowlists** (`NFE_NUMERACAO_V2_CONFIG_IDS` e `NFE_DEVOLUCAO_CONFIG_IDS`), só com configs `SEFAZ_DIRECT`. **Nunca `*`**:
  - `isDevolucaoAtiva` não olha o provedor. Com `*` nas duas, a devolução liga para as configs Focus, que não podem emiti-la: a emissão V1 recusa com 422 `EXIGE_NUMERACAO_V2`, e os botões de devolução terminam nesse erro;
  - a sub-flag Focus não tem allowlist própria: `NFE_NUMERACAO_V2_FOCUS_ENABLED=true` com `*` arma **todas** as configs Focus de uma vez;
  - não existe "todas menos X": `id,*` libera só o `id`.
- A devolução liga junto com a numeração, com a mesma lista (decisão do dono, 25/09/2026). A única diferença admitida é tirar uma config só de `NFE_DEVOLUCAO_CONFIG_IDS`, que é o rollback da devolução. O contrário não serve: `isDevolucaoAtiva` exige a config nas duas listas, e fora da numeração a devolução fica morta.
- Para incluir uma empresa, **acrescentar** o id: redefinir a variável com um id só retira as demais da V2.
- **Config SEFAZ direto nova entra na lista no onboarding**, nas duas allowlists. Fora da lista ela segue no V1, sem regressão, até ser incluída.
- Contador atrás da numeração real do CNPJ (números usados fora do Dexo) **não** impede a entrada (decisão do dono, 25/09/2026): depois de 3 números seguidos que a SEFAZ já tinha com outra chave, a V2 trava a série com 409 `SEQUENCIA_ATRAS_DA_SEFAZ`, e o card **Ajustar próximo número** destrava com o último número que o cliente conferir. Fica fora da lista só a config inativa `cmrmh6iwp01i418u6r4yux253`, até ser reativada e o cliente informar o último número da série 1.

### Gate de pré-voo

Somente leitura, repetido **imediatamente antes de cada restart** (`psql "$DIRECT_URL"` na VPS, dentro de `BEGIN READ ONLY; … ROLLBACK;`). Há dois critérios, e este é o único lugar que os define; os outros docs apontam para cá.

**Gate estrito**, para ligar, ampliar ou fazer rollback, isto é, toda mudança de allowlist ou de flag: as duas primeiras consultas têm de voltar sem linhas e a terceira, 0. `BLOQUEADO` de qualquer config conta.

```sql
SELECT "companyFiscalConfigId","estado",count(*) FROM "NfeNumeroReserva"
 WHERE "estado" IN ('EM_TRANSMISSAO','INCERTO','BLOQUEADO') GROUP BY 1,2;
SELECT "companyFiscalConfigId","status","modelo",count(*) FROM "NfeEmitida"
 WHERE "status" IN ('VALIDATING','SIGNING','SENDING') GROUP BY 1,2,3;
SELECT count(*) FROM "NfeInutilizacao"
 WHERE "status"='PENDENTE' AND "createdAt" > (NOW() AT TIME ZONE 'UTC') - interval '15 minutes';
```

**Gate de rotina**, para o deploy de código sem mudança de flag: a primeira consulta dá lugar à de baixo, que só pega reserva com lease vivo (um `BLOQUEADO` estacionado à espera de conferência não trava o deploy), e as consultas de notas em voo (`VALIDATING`/`SIGNING`/`SENDING`) e de inutilização pendente continuam valendo, com o mesmo resultado: sem linhas, sem linhas e 0.

```sql
SELECT "companyFiscalConfigId","estado",count(*) FROM "NfeNumeroReserva"
 WHERE "estado" IN ('EM_TRANSMISSAO','INCERTO') AND "leaseAte" > (NOW() AT TIME ZONE 'UTC') GROUP BY 1,2;
```

As colunas do Prisma são `timestamp` sem fuso: comparar sempre com `(NOW() AT TIME ZONE 'UTC')`.

### Restart

- Só `pm2 restart dexo-api`: é o único processo que lê essas flags (a tela e o `dexo-sync-orders` não importam `app/fiscal/flags.ts`). Nunca `--update-env` e nunca `pm2 restart all`.
- Antes, confirmar que o pm2 não guardou as flags no dump: `pm2 env <id do dexo-api> | grep -oE "^NFE_[A-Z0-9_]+"` tem de voltar vazio. Listar só os nomes, nunca os valores.
- Antes de editar o `.env`, copiá-lo para `.env.bak-<data>-v2` (permissão 600, sem imprimir valores) e guardar à parte as linhas atuais de `NFE_NUMERACAO_V2_CONFIG_IDS` e `NFE_DEVOLUCAO_CONFIG_IDS`: elas são o rollback global.

### Ligação para as configs SEFAZ direto (25/09/2026)

Decisões do dono (25/09/2026): o canário de 3 configs por 48 h e a UAT de homologação foram substituídos pela ligação por lista explícita com vigília de 24 h e 48 h, e a devolução liga junto com a numeração, com a mesma lista. Os critérios do canário, medidos na DLS em 25/09/2026, passaram: nenhuma dupla ligação, nenhum INCERTO, nenhuma divergência entre número e chave, P2002 só do `OrderRepository` e nenhum erro 500 no `/issue`.

1. **Código, antes da ligação:** pelo deploy padrão, com o gate de rotina antes do restart, sobem juntas:
   - as correções de prontidão da numeração: inutilização com confirmação e saída para reserva BLOQUEADO (em "Situação e descarte");
   - da devolução, a proteção de rollback da devolução por config: com a config fora da lista da devolução, o V1 recusa com 422 `EXIGE_NUMERACAO_V2` o rascunho criado pela devolução, antes de transmitir, e a trava que impede cancelar uma original que já tem devolução continua valendo;
   - da devolução, o cancelamento que não perde a sessão quando a SEFAZ demora: com a devolução ligada, o cancelamento chama a SEFAZ dentro de uma transação, e em produção o papel `postgres` derruba transação ociosa em 120 s.

   Sem essas duas correções da devolução no ar, a devolução não entra na lista: `NFE_DEVOLUCAO_CONFIG_IDS` fica só com a DLS, e o adiamento da decisão do dono se registra nesta seção, com o motivo.
2. **Lista:** gerar, somente leitura, os ids das configs `SEFAZ_DIRECT` menos a inativa (ver "Regra das listas"); conferir que nenhum id da lista é de outro provedor (a segunda consulta tem de voltar sem linhas); fazer o backup do `.env`. Em 25/09/2026 o total esperado era 22 ids. Divergências históricas seguem no diagnóstico somente leitura (seção abaixo); nenhuma correção é automática.
   ```sql
   BEGIN READ ONLY;
   SELECT string_agg("id", ',' ORDER BY "createdAt") FROM "CompanyFiscalConfig"
    WHERE "providerName"='SEFAZ_DIRECT' AND "id"<>'cmrmh6iwp01i418u6r4yux253';
   SELECT "id","providerName" FROM "CompanyFiscalConfig"
    WHERE "id" = ANY(string_to_array('<lista>',',')) AND "providerName" IS DISTINCT FROM 'SEFAZ_DIRECT';
   ROLLBACK;
   ```
3. **Fase A, numeração e devolução juntas:** `NFE_NUMERACAO_V2_CONFIG_IDS` e `NFE_DEVOLUCAO_CONFIG_IDS` recebem a mesma lista. Conferir `FOCUS_ENABLED=false` e `MODELOS=55`.
   ```dotenv
   NFE_NUMERACAO_V2_ENABLED=true
   NFE_NUMERACAO_V2_CONFIG_IDS=cmr9omjlt30xw18jqt3m5oyc3,<demais configs SEFAZ_DIRECT>
   NFE_NUMERACAO_V2_MODELOS=55
   NFE_NUMERACAO_V2_FOCUS_ENABLED=false
   NFE_DEVOLUCAO_ENABLED=true
   NFE_DEVOLUCAO_CONFIG_IDS=cmr9omjlt30xw18jqt3m5oyc3,<demais configs SEFAZ_DIRECT>
   ```
   `NFE_DEVOLUCAO_REF_ITEM_PROD_DESDE` continua ausente (padrão 2026-10-05) e não se antecipa: o valor é **global** e, com a devolução na lista inteira, anteciparia a referência por item para todas as configs de uma vez.
4. **Aplicar e verificar:** gate estrito, `pm2 restart dexo-api` e, na sequência:
   - `pm2 logs dexo-api --nostream --lines 200` com boot limpo;
   - o gate de novo: nota V1 em voo durante o restart vira legado preso e, se aparecer, pede o rollback abaixo;
   - um script `npx tsx` em `/var/www/dexo` (`import "dotenv/config"` e as funções de `app/fiscal/flags`) que imprima só booleanos: a DLS dá `isNumeracaoV2ParaEmissao` 55 `true`, 65 `false` e `isDevolucaoAtiva` `true`; uma config SEFAZ recém-incluída dá `true`, `false` e `true`; uma config SEFAZ deixada fora da lista e uma config Focus dão tudo `false`;
   - pelo console logado, `GET /fiscal/nfe` de um tenant recém-incluído traz `legadoV1: true` nas notas antigas, que nunca tiveram reserva, e **sem** a chave `numeracao`; isso é o esperado, não sinal de que a inclusão falhou. A chave `numeracao` só aparece na nota que passa pela emissão depois da ligação, e é essa primeira emissão que gera as linhas `[nfe-numeracao]` no log. `GET /fiscal/nfe/devolucao/disponibilidade` dele responde `disponivel: true`.
5. **Vigília de 24 h e 48 h**, somente leitura, com o instante da ligação em UTC:
   ```sql
   SELECT "companyFiscalConfigId","estado","serie","numero","nfeId" FROM "NfeNumeroReserva"
    WHERE "estado" IN ('EM_TRANSMISSAO','INCERTO','BLOQUEADO')
      AND "updatedAt" < (NOW() AT TIME ZONE 'UTC') - interval '15 minutes';
   SELECT "companyFiscalConfigId","estado","serie","numero","motivo" FROM "NfeNumeroReserva"
    WHERE "estado" IN ('ABANDONADO','INUTILIZADO','CONSUMIDO_EXTERNO') AND "updatedAt" >= '<ligação UTC>';
   SELECT "id","companyFiscalConfigId","serie","numero","chaveAcesso" FROM "NfeEmitida"
    WHERE "modelo"='55' AND "status" IN ('AUTHORIZED','CANCELLED') AND "updatedAt" >= '<ligação UTC>'
      AND "chaveAcesso" IS NOT NULL
      AND "numero" <> substr(regexp_replace("chaveAcesso",'[^0-9]','','g'),26,9)::int;
   ```
   Na segunda consulta, o `motivo` diz de onde veio o número: `RASCUNHO_EXCLUIDO` (rascunho excluído com o descarte confirmado), `NUMERO_RETIDO_DESCARTADO` (nº `BLOQUEADO` descartado na lista, na ficha ou no assistente) e `INUTILIZACAO_CONFIRMADA` (inutilização de faixa com o descarte confirmado) são ações confirmadas pelo operador na tela, não achado sem explicação. Em produção, o número desses três que ficou em `ABANDONADO` ainda pede inutilização pela tela **Inutilizar numeração**; se a SEFAZ a recusar, conferir no portal, porque o número pode já ter sido usado.

   Mais: `grep -h P2002 ~/.pm2/logs/dexo-api-*.log | grep -v OrderRepository`; erro 500 no `/issue` pelo `SystemLog` filtrando `details.url` (nunca por `action`); `SEQUENCIA_ATRAS_DA_SEFAZ` no log. **Regra de parada:** achado sem explicação ⇒ tirar a config da lista.

   Devolução: acompanhar pelo cStat a primeira devolução de cada autorizadora que nunca recebeu uma (GO, MG, PR e SP; a SVRS já autorizou devolução por nota em produção, na DLS, em 25/09/2026) e, a partir de 05/10, a primeira por item de cada autorizadora em produção: 225, 321 ou 1010 ⇒ tirar as configs daquela UF só de `NFE_DEVOLUCAO_CONFIG_IDS`, com a numeração seguindo, e investigar. Na V2 a rejeição não queima número: a nota corrigida sai com o mesmo.
6. **Modo por item.** O formato por item (`DFeReferenciado`, regra VC02-14 da NT 2025.002, obrigatório em produção a partir de 05/10/2026) foi autorizado em homologação na SVRS em 25/09/2026, com o certificado da DLS e protocolo 342260000975434: XML gerado pelo código do Dexo, por script, sem gravar nada na base. Não está provado em GO, MG, PR e SP nem em produção; por isso a primeira devolução por item de cada autorizadora entra na vigília acima.

### Rollback de uma config

1. Pré-voo filtrado pela config:
   ```sql
   SELECT "estado","serie","numero","nfeId" FROM "NfeNumeroReserva"
    WHERE "companyFiscalConfigId"='<X>' AND "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO');
   SELECT e."id",e."status",e."numero" FROM "NfeDevolucao" d JOIN "NfeEmitida" e ON e."id"=d."nfeId"
    WHERE e."companyFiscalConfigId"='<X>' AND e."status" IN ('DRAFT','REJECTED','VALIDATING','SIGNING','SENDING');
   ```
   - `EM_TRANSMISSAO`, `INCERTO` e `BLOQUEADO` têm de dar zero. Se não derem, resolver antes por **Consultar situação** ou pelo descarte confirmado.
   - Além do filtrado, vale o gate estrito, com `BLOQUEADO` de qualquer config (ver "Gate de pré-voo"): o rollback é mudança de allowlist. Se um `BLOQUEADO` de outra config segurar uma emergência, liberar o restart sem resolvê-lo é decisão do dono, não do operador.
   - `RESERVADO` e `REJEITADO`: avisar o cliente. Depois do rollback essas notas respondem 409 `NUMERACAO_EMITENTE_FORA_V2` (emitir pelo V1 deixaria o número órfão) até serem descartadas na exclusão ou a config voltar à lista.
   - Rascunho de devolução aberto: com a proteção de rollback da devolução por config no ar (pré-condição da ligação), o V1 o recusa com 422 `EXIGE_NUMERACAO_V2` antes de transmitir, e a mensagem manda reativar a devolução da empresa ou excluir o rascunho. Sem ela, ele cairia no V1 e tomaria 321.
2. Tirar a config das **duas** listas (`NFE_NUMERACAO_V2_CONFIG_IDS` e `NFE_DEVOLUCAO_CONFIG_IDS`). **Nunca** `NFE_NUMERACAO_V2_ENABLED=false`: a nota cairia no V1 e seria renumerada, e o ledger deixaria de ser consultado no cancelamento e na exclusão.
3. Gate estrito, conferir o `pm2 env` e rodar `pm2 restart dexo-api`.
4. Não apagar reservas nem tentativas. Não inutilizar pelo V1 um número com reserva viva da config.
5. Nota presa depois do rollback: recolocar a config na lista, consultar a situação e tirar de novo.
6. Para desligar só a devolução, tirar a config de `NFE_DEVOLUCAO_CONFIG_IDS`. Com a proteção de rollback da devolução por config no ar, a trava que impede cancelar uma original que já tem devolução continua valendo; sem ela, essa trava sai junto. A recusa 422 `EXIGE_NUMERACAO_V2` do item 1 é do V1 e **não** vale aqui: com a numeração ainda ligada, o rascunho de devolução aberto dessa config (a segunda consulta do item 1) segue pela V2 sem a referência da original e volta 321 da SEFAZ; o número fica reservado para a nota e não se perde. Avisar o cliente de que esses rascunhos só voltam a emitir com a devolução religada.

**Rollback global:** voltar as duas linhas guardadas antes da ampliação (`NFE_NUMERACAO_V2_CONFIG_IDS` e `NFE_DEVOLUCAO_CONFIG_IDS`; hoje, só a DLS em cada uma), com o gate estrito e o pré-voo filtrado aplicado a cada config que sai da lista.

Trocar ambiente/token com nota pendente de consulta responde 409. Antes de alternar Focus/V1, consultar envios pendentes e preservar a referência registrada; não renumerar automaticamente documentos incertos.

Tabela V2 ausente é detectada **antes do claim** e conserva o caminho V1 para notas comuns. Devolução habilitada nunca cai para emissão V1. Falha após mutação V2 não dispara fallback.

### Não fazer

- Não inutilizar número só porque o contador do Dexo tem vão: na Focus pelo V1 o contador do Dexo é fictício, e um 539 diz que o número já foi usado com outra chave (a SEFAZ recusaria a inutilização).
- Não ajustar contador sem o último número informado pelo cliente: o ajuste só avança e não tem volta.
- Não mover nem excluir rascunho de cliente.

### Focus

`NFE_NUMERACAO_V2_FOCUS_ENABLED` continua `false`, numa trilha separada. Os pré-requisitos estão no [roteiro Focus](roteiro-emissao-focus-nfe.md).

### Canário em produção (22–23/09/2026)

Ativada em 22/09/2026 para a DLS AUTO PEÇAS (`cmr9omjlt30xw18jqt3m5oyc3`, modelo 55); VPS no commit `21270f2`. Com a sub-flag Focus desligada, o canário corre pelo **SEFAZ direto** — é o único provedor que `isNumeracaoV2ParaEmissao` libera nessa configuração.

Primeira emissão real em 23/09/2026. A nota 710 levou três tentativas — cStat 232, 232 e então 100, autorizada, protocolo `242260451012429` — **mantendo o mesmo número e a mesma chave de acesso**. A nota 711 autorizou de primeira. O contador foi de 710 para 712: nenhum número queimado, que é a invariante que a V2 existe para sustentar.

A chave se repete entre as tentativas porque **o `cNF` mora na reserva, não na tentativa**. Isso é deliberado: sortear um `cNF` novo na retransmissão geraria uma segunda chave para o mesmo (CNPJ, modelo, série, nNF), e é exatamente esse par chave-nova/número-repetido que a SEFAZ devolve como cStat 539. Reenviar a chave idêntica, no pior caso, volta como 204.

## Diagnóstico e testes locais

`scripts/fiscal/diagnostico-numeracao-nfe.ts` exige DATABASE_URL explícita e abre transação `READ ONLY`. Produz JSON/CSV em `scripts/out`; lista divergências, emissões antigas, intervalos candidatos, reservas pendentes, empresas PR/produção e compartilhamento de tokens (sem retornar token ou fingerprint). Intervalos candidatos precisam de conferência fiscal: não autorizam inutilização.

Os testes PostgreSQL são opt-in por `NFE_TEST_DATABASE_URL`: somente localhost e banco com `nfe_test` no nome. Criam schema aleatório, aplicam DDL local e removem apenas esse schema. Não apontar testes a produção. A suíte normal usa fake com mutex/rollback e transportes simulados.

## Dependências externas

Focus: confirmar CNPJ do RT, CSRT no PR, respeito a número/série explícitos, re-POST da mesma ref após rejeição, resposta a duplicidade, evolução do contador interno e webhook. Kiko: verificar token do ambiente, habilitação da empresa e autorização de uso do fornecedor no UPD com o contador. Tributos da devolução dependem de revisão do responsável fiscal quando sinalizados. Nenhum desses itens é provado por testes de código.

Notas presas: **zero**. As 14 que restavam foram encerradas em 23/09/2026, depois de a auditoria provar que **nenhuma chegou a ser transmitida à SEFAZ** — todas pararam antes do envio (CA bundle local ausente, token Focus inválido, empresa não habilitada na Focus). Fechadas como `REJECTED` com o motivo real e **`cStatRejeicao` nulo**, porque não houve rejeição da SEFAZ para registrar; backup em `ops_backup.nfe_presas_sending_20260923`. ⛔ Os números 8–10 da série 3 da Kiko **não** devem ser inutilizados: não há lacuna real. A config é Focus pelo V1, em que quem numera é a Focus (o número que o Dexo envia é ignorado) e o contador do Dexo é fictício; os nºs 1–7 voltaram 974 e os nºs 8–10 nunca foram transmitidos. Inutilizá-los queimaria números reais da Focus. Nenhuma faixa foi liberada automaticamente. Kiko 4x4 e VN Motors (cujo CNPJ padrão é o da Veiga Auto Peças LTDA, 65416054000188) seguem **ativos e usando o sistema** — nenhum dos dois cancelou, e "Veiga" não é um cliente.
