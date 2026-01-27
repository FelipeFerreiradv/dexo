# Estrutura de pastas do projeto

Segue a árvore de diretórios do projeto (exclui expansão de `node_modules`, `.git` e `.next` para evitar listagens muito longas):

```
ghd-plataform/
├─ .env
├─ .git/
├─ .gitignore
├─ .husky/
│  └─ commit-msg
├─ .next/
├─ app/
│  ├─ api/
│  │  └─ api.ts
│  ├─ favicon.ico
│  ├─ globals.css
│  ├─ layout.tsx
│  ├─ lib/
│  │  └─ prisma.ts
│  └─ page.tsx
├─ components/
│  └─ theme-provider.tsx
├─ components.json
├─ eslint.config.mjs
├─ lib/
│  └─ utils.ts
├─ next-env.d.ts
├─ next.config.mjs
├─ next.config.ts
├─ node_modules/
├─ package-lock.json
├─ package.json
├─ pnpm-lock.yaml
├─ postcss.config.mjs
├─ prisma/
│  └─ schema.prisma
├─ prisma.config.ts
├─ public/
│  ├─ file.svg
│  ├─ globe.svg
│  ├─ next.svg
│  ├─ vercel.svg
│  └─ window.svg
├─ README.md
├─ styles/
│  └─ globals.css
└─ tsconfig.json
```
