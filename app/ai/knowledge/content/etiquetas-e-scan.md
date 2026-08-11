# Etiquetas e Receber por scanner

Etiqueta com QR é o que liga a peça física ao cadastro. Cola-se a etiqueta na peça e a etiqueta da prateleira na prateleira; depois é só apontar a câmera do celular.

## Gerar etiquetas de peças

Na tela **Produtos**, marque as peças e use a ação de **gerar etiquetas**. Sai um PDF pronto para imprimir, uma etiqueta por página, com QR, SKU e nome da peça.

**As etiquetas saem na ordem em que você marcou.** A primeira peça marcada é a primeira do PDF. Quem cadastra 1 a 10 e manda imprimir recebe na ordem 1 a 10, não invertida.

"Selecionar todos" marca na ordem visível na tela — ou seja, na ordenação que você escolheu na lista.

O QR da etiqueta de peça aponta para a página do produto: lendo com a câmera comum do celular, abre o cadastro daquela peça.

## Etiqueta avulsa (peça que ainda não existe)

Na tela Produtos há **Etiqueta avulsa**: gera etiquetas para peças que ainda **não** estão cadastradas. Serve para etiquetar no momento do desmonte e cadastrar depois.

Cada linha tem **Nome**, **SKU** e **Quantidade** (quantas cópias daquela etiqueta). Os limites são 100 cópias por linha e 500 etiquetas no total.

**Nada é salvo.** É só o PDF. Aqui o QR guarda o SKU cru, não um endereço — então, quando a peça for cadastrada com aquele SKU, a etiqueta já impressa passa a funcionar no Receber por scan.

## Etiquetas de localização

Na tela **Localizações**, selecione as prateleiras e gere o PDF. Cada etiqueta traz o código e o QR da localização. É esse QR que o Passo 1 do Receber por scan espera.

## Receber por scan

A tela fica em **Principal → Receber por scan**. Serve para guardar várias peças em uma prateleira sem digitar nada.

**Passo 1 — escaneie o QR da localização.** "Aponte a câmera para a etiqueta colada na caixa, prateleira ou galpão de destino." Quem não tem a etiqueta em mãos pode colar o código ou a URL no campo ao lado.

**Passo 2 — escaneie cada produto.** "Cada QR de produto lido é vinculado automaticamente a esta localização." O campo manual aqui aceita **SKU, id ou URL do produto** — então dá para digitar o SKU quando a etiqueta estiver ilegível.

Cada leitura mostra a peça reconhecida e vai empilhando a lista da sessão. Peça já vinculada àquela prateleira é reconhecida como tal, sem duplicar. Peça que o sistema não reconhece vai para uma lista de puladas, com o motivo.

**Sessão concluída** mostra o total vinculado e oferece **Receber em outra localização** ou voltar para Localizações.

O vínculo vale na hora, uma peça de cada vez — não existe "confirmar tudo no fim". Sair no meio mantém o que já foi lido.

## Permissão da câmera

Na primeira vez, o navegador pede permissão de câmera. A permissão nunca é pedida sozinha ao abrir a tela: só quando a leitura começa. Negando, dá para seguir pelo campo manual.

Em celular, a leitura precisa de HTTPS — navegador nenhum libera câmera fora disso.

## Erros comuns

- **QR não é reconhecido no Passo 1** — foi lida uma etiqueta de **produto** onde se esperava a de **localização**. São QRs diferentes.
- **"produto não encontrado"** — a etiqueta é avulsa e a peça ainda não foi cadastrada com aquele SKU, ou o SKU é de outra loja.
- **Etiquetas saíram na ordem errada** — a ordem é a da seleção; com "selecionar todos", é a ordenação escolhida na lista.
- **Câmera não abre** — permissão negada no navegador, ou a página não está em HTTPS.
- **Leitor não lê a etiqueta impressa** — QR pequeno demais ou impressão fraca. Etiqueta de peça e de localização foram desenhadas para impressão em tamanho cheio.

## Limitações conhecidas

- O PDF sai com uma etiqueta por página; não há grade com várias etiquetas por folha.
- Não há leitura de código de barras comum — só QR.
- O Receber por scan vincula localização; ele não altera quantidade em estoque.

## Etiqueta e impressora: o padrão do galpão

- **Tamanho da etiqueta de peça: 100 × 50 mm.**
- **Impressoras usadas:** Argox OS-240 Plus e Elgin L42 Pro. São essas duas, independente do cliente.
- **Ribbon: resina ou misto.** ⚠️ **Ribbon de cera falha** nessa etiqueta — a impressão sai borrada, apagando ou incompleta. Se o lojista reclamar de etiqueta falhando, saindo fraca ou sumindo com o tempo, **pergunte o ribbon antes de qualquer outra coisa**: cera é a causa mais provável, e a troca por resina ou misto resolve.

Etiqueta com impressão falhando não é problema do Dexo nem do QR: o PDF é o mesmo. É consumível ou configuração da impressora.

**Configuração:** o PDF sai com **uma etiqueta por página**, então a impressora precisa estar com o tamanho de página em 100 × 50 mm — não em A4. Impressora configurada em A4 imprime a etiqueta minúscula num canto da folha, ou corta o QR.
