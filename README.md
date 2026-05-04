This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
npm run dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Colaboradores (sub-usuários)

O Dexo suporta hierarquia administrador → colaboradores via campo `parentUserId` na tabela `User`.

- **Administrador**: usuário sem `parentUserId`. Continua funcionando exatamente como antes.
- **Colaborador**: usuário com `parentUserId` apontando para o administrador. Compartilha **todos os dados** do admin pai (produtos, anúncios, NF-e, clientes, sucatas, localizações, financeiro). Suas ações são auditadas individualmente — `userId` no `SystemLog` é sempre o autor da ação.
- **Restrição**: colaboradores **não podem conectar/desconectar contas de marketplace**. Backend bloqueia via `blockCollaborator` middleware (HTTP 403). UI esconde os botões.

### Como criar um colaborador via SQL

Não há tela para cadastrar colaboradores — crie diretamente no banco. O `id` precisa ser um cuid (igual aos demais users); use `gen_random_uuid()` ou gere um cuid manualmente.

```sql
INSERT INTO "User" (id, email, password, name, role, "parentUserId", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,           -- ou cuid manual ('clxxxx...')
  'colaborador@email.com',
  'senha_em_texto_plano',            -- senha ainda em texto plano (TODO: bcrypt)
  'Nome do Colaborador',
  'USER',
  '<id_do_admin_pai>',               -- pegue de SELECT id, email FROM "User" WHERE email = ...;
  NOW(),
  NOW()
);
```

Após inserir, o colaborador pode logar normalmente em `/login` com email + senha. Limpe o cache da sessão (60s TTL) caso teste imediatamente após o INSERT.

### Auditoria

Acesse a aba **Colaboradores** (`/colaboradores`, visível apenas para admins) para ver o histórico das ações dos colaboradores: data/hora, autor, tipo de ação, recurso e mensagem. Filtros disponíveis: por colaborador, intervalo de datas e tipo de ação.

A auditoria é centralizada no `loggingMiddleware` (em `app/middlewares/logging.middleware.ts`) — toda ação POST/PUT/DELETE em rotas de domínio é registrada na tabela `SystemLog` de forma assíncrona (`setImmediate`), sem bloquear o request. Falhas no logging não derrubam a operação principal.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
