# Estrutura de pastas do projeto

Segue a árvore de diretórios do projeto (exclui expansão de `node_modules`, `.git` e `.next` para evitar listagens muito longas):

`````
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
````markdown
# Estrutura de pastas do projeto (atualizada)

Segue a árvore de diretórios do projeto (exclui expansão de `node_modules`, `.git` e `.next` para evitar listagens muito longas):

`````

ghd-plataform/
├─ .env
├─ .git/
├─ .gitignore
├─ .husky/
├─ .next/
├─ app/
│ ├─ api/
│ │ └─ api.ts
│ ├─ favicon.ico
│ ├─ generated/
│ │ ├─ default.d.ts
│ │ ├─ default.js
│ │ ├─ edge.d.ts
│ │ ├─ edge.js
│ │ ├─ index-browser.js
│ │ ├─ index.d.ts
│ │ ├─ index.js
│ │ ├─ package.json
│ │ ├─ query_engine-windows.dll.node
│ │ ├─ query_engine_bg.js
│ │ ├─ query_engine_bg.wasm
│ │ ├─ runtime/
│ │ │ ├─ edge-esm.js
│ │ │ ├─ edge.js
│ │ │ ├─ index-browser.d.ts
│ │ │ ├─ index-browser.js
│ │ │ ├─ library.d.ts
│ │ │ ├─ library.js
│ │ │ ├─ react-native.js
│ │ │ └─ wasm.js
│ │ ├─ schema.prisma
│ │ ├─ wasm-edge-light-loader.mjs
│ │ ├─ wasm-worker-loader.mjs
│ │ ├─ wasm.d.ts
│ │ └─ wasm.js
│ ├─ globals.css
│ ├─ interfaces/
│ │ ├─ product.interface.ts
│ │ └─ user.interface.ts
│ ├─ layout.tsx
│ ├─ lib/
│ │ └─ prisma.ts
│ ├─ page.tsx
│ ├─ repositories/
│ │ ├─ product.repository.ts
│ │ └─ user.repository.ts
│ ├─ routes/
│ │ ├─ product.routes.ts
│ │ └─ user.routes.ts
│ └─ usecases/
│ ├─ product.usercase.ts
│ └─ user.usercase.ts
├─ components/
│ ├─ app-header.tsx
│ ├─ app-sidebar.tsx
│ ├─ main-layout.tsx
│ ├─ theme-provider.tsx
│ └─ ui/
│ ├─ avatar.tsx
│ ├─ button.tsx
│ ├─ card.tsx
│ ├─ collapsible.tsx
│ ├─ dropdown-menu.tsx
│ ├─ input.tsx
│ ├─ separator.tsx
│ ├─ sheet.tsx
│ ├─ sidebar.tsx
│ ├─ skeleton.tsx
│ └─ tooltip.tsx
├─ components.json
├─ eslint.config.mjs
├─ hooks/
│ └─ use-mobile.ts
├─ lib/
│ └─ utils.ts
├─ next-env.d.ts
├─ next.config.mjs
├─ next.config.ts
├─ node_modules/
├─ package-lock.json
├─ package.json
├─ pnpm-lock.yaml
├─ postcss.config.mjs
├─ prisma/
│ ├─ app/
│ │ └─ generated/
│ │ ├─ default.d.ts
│ │ ├─ default.js
│ │ ├─ edge.d.ts
│ │ ├─ edge.js
│ │ ├─ index-browser.js
│ │ ├─ index.d.ts
│ │ ├─ index.js
│ │ ├─ package.json
│ │ ├─ query_engine-windows.dll.node
│ │ ├─ query_engine_bg.js
│ │ ├─ query_engine_bg.wasm
│ │ ├─ runtime/
│ │ │ ├─ edge-esm.js
│ │ │ ├─ edge.js
│ │ │ ├─ index-browser.d.ts
│ │ │ ├─ index-browser.js
│ │ │ ├─ library.d.ts
│ │ │ ├─ library.js
│ │ │ ├─ react-native.js
│ │ │ └─ wasm.js
│ │ ├─ schema.prisma
│ │ ├─ wasm-edge-light-loader.mjs
│ │ ├─ wasm-worker-loader.mjs
│ │ ├─ wasm.d.ts
│ │ └─ wasm.js
│ └─ schema.prisma
├─ prisma.config.ts
├─ PROJECT_STRUCTURE.md
├─ public/
├─ README.md
├─ routes.http
├─ styles/
│ └─ globals.css
├─ tsconfig.json
└─ tsconfig.tsbuildinfo

```

```
