// Troca de página das telas fiscais num lugar só. Existe para os testes de tela
// poderem ver PARA ONDE a tela mandou a pessoa: no jsdom, `window.location` não
// pode ser espionado (as propriedades são "unforgeable") e a navegação não é
// implementada — sem este ponto único, "depois de autorizar vai para a nota
// autorizada" ou "criar a devolução abre o rascunho certo" seriam invisíveis ao
// teste. Em produção é exatamente `window.location.assign`.

export function navegarPara(url: string): void {
  window.location.assign(url);
}
