# Correção manual — 93 anúncios ML com dimensões travadas

## Contexto

Dos 17.054 anúncios auditados, **16.961 já foram resolvidos** automaticamente (97,8% da fatia que precisava de push; o restante já tinha dimensões manuais preservadas pelo anti-regressão). Estes **93 anúncios** não aceitaram nenhuma dimensão automática porque o *catalog product* associado tem um mínimo interno escondido (a API `/products` não expõe esse valor).

Eles precisam ser ajustados um por um, direto no painel do Mercado Livre.

## Arquivo

`scripts/out/ml-manual-fix.csv` — 93 linhas, todas na conta **JOTABÊ AUTOPEÇAS**.

### Colunas

| Coluna | O que é |
|---|---|
| `itemId` | ID do anúncio ML (ex: MLB3272983229) |
| `account` | Conta ML |
| `category` | Categoria ML |
| `title` | Título do anúncio |
| `originalTier` | Tier que a automação usou na 1ª tentativa |
| `lastTier` | Tier usado na última tentativa (já escalado) |
| `lastH_cm` / `lastW_cm` / `lastL_cm` / `lastWeight_g` | Últimas dimensões que tentamos |
| `failingAxes` | **Eixo(s) que o ML reclamou** — é por aqui que começa a correção |
| `failureType` | `ml-min-product` (mínimo escondido), `user-product-conflict`, `other` |
| `finalError` | Mensagem completa do erro |
| `mlPanelLink` | Link direto pro painel ML filtrado no item |

## Como corrigir — passo a passo

### Caso 1: `failureType = ml-min-product` (86 itens)

É a grande maioria. O ML está dizendo "o pacote é menor que o mínimo do produto do catálogo".

1. Abrir o anúncio pelo `mlPanelLink` (ou colar o `itemId` na busca do painel).
2. Ir em **Informações do anúncio → Medidas de embalagem**.
3. Olhar a coluna `failingAxes` do CSV — ela diz exatamente qual eixo está pequeno:
   - `height` → aumentar a **altura** do pacote
   - `width` → aumentar a **largura**
   - `length` → aumentar o **comprimento**
   - `weight` → aumentar o **peso**
   - Se aparecem 2 ou 3 eixos, aumentar todos os que estão listados.
4. Como ponto de partida, usar os valores da coluna `lastH/W/L/Weight` e **acrescentar ~50% no eixo reclamado**. Exemplo: `lastL_cm=50` com `failingAxes=length` → tentar `75`.
5. Salvar. Se o ML aceitar, pronto. Se reclamar de novo, repetir aumentando mais nesse mesmo eixo.
6. **Limite de sanidade**: lado ≤ 100 cm, soma L+A+C ≤ 200 cm, peso ≤ 30 kg. Não ultrapassar — é o limite do Mercado Envios.

> **Dica**: como todos os 86 são do mesmo catálogo de autopeças, muito provavelmente 5-10 *produtos do catálogo* (coluna `category`) concentram a maioria. Vale agrupar o CSV por `category` — quando achar o valor que funciona para uma categoria, reaproveitar nos outros itens da mesma categoria.

### Caso 2: `failureType = user-product-conflict` (3 itens)

Mensagem: *"Repeated user-product. Conflict id: MLBU…"*. Significa que **já existe outro anúncio ativo do vendedor vinculado ao mesmo catalog product** — o ML bloqueia duplicação. Não é dimensão.

Opções:
- Pausar/encerrar o anúncio duplicado mais antigo (ou o desejado, a critério do time).
- Ou unificar estoque no que estiver melhor posicionado.

### Caso 3: `failureType = other` (4 itens)

Erros fora do padrão acima. Abrir e avaliar manualmente lendo a coluna `finalError`.

## Como marcar como resolvido

Sugestão para o time ir acompanhando o progresso: criar uma coluna extra no CSV chamada `resolvedBy` e preencher com o nome de quem corrigiu + data. Quando o CSV chegar a 100% preenchido, o Phase 3 termina oficialmente.

## Referência rápida — valores conservadores que funcionam na maioria

Se o eixo reclamado for…

| Eixo | Tente este valor |
|---|---|
| `height` | 30–40 cm |
| `width`  | 40–60 cm |
| `length` | 60–100 cm |
| `weight` | 8–15 kg (8000–15000 g) |

São valores que cabem no Mercado Envios e costumam passar mesmo em catálogos com mínimos altos.
