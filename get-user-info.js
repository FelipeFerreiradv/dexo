// Script para obter informações do usuário logado
// Execute no console do navegador (F12) quando estiver logado no sistema

// Para NextAuth v4
console.log('=== INFORMAÇÕES DO USUÁRIO LOGADO ===');

// Verificar se há sessão no localStorage
const sessionData = localStorage.getItem('next-auth.session-token') ||
                   localStorage.getItem('__Secure-next-auth.session-token');

if (sessionData) {
  console.log('Token de sessão encontrado no localStorage');
}

// Tentar obter sessão via API do NextAuth
fetch('/api/auth/session')
  .then(response => response.json())
  .then(session => {
    if (session?.user) {
      console.log('✅ Usuário autenticado:');
      console.log('Email:', session.user.email);
      console.log('Nome:', session.user.name);
      console.log('ID:', session.user.id);
      console.log('');
      console.log('📋 Use este email nos testes HTTP:');
      console.log('email:', session.user.email);
    } else {
      console.log('❌ Nenhum usuário autenticado encontrado');
    }
  })
  .catch(error => {
    console.log('❌ Erro ao obter sessão:', error);
  });

// Também verificar se há dados no window
if (window && (window as any).session) {
  console.log('Sessão encontrada em window.session:', (window as any).session);
}