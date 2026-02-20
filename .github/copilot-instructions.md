# GHD Platform - AI Coding Instructions

## Project Overview

Sistema de Gestão de Estoque Centralizado (Centralized Inventory Management System) with marketplace integrations (Mercado Livre, Shopee). Built with **Next.js 15 (App Router)** frontend + **Fastify** standalone API backend + **Prisma** ORM + **PostgreSQL (Neon)**.

## Architecture (Dual-Server Pattern)

### Two Separate Servers

1. **Next.js App** (`npm run dev` → port 3000): Frontend + NextAuth authentication
2. **Fastify API** (`npm run api` → port 3333): Backend REST API for business logic

### Layer Structure (Clean Architecture in `/app`)

```
interfaces/  → TypeScript types + Repository contracts
repositories/ → Prisma database implementations (suffix: *RepositoryPrisma)
usecases/    → Business logic (suffix: *UseCase)
routes/      → Fastify route handlers (register on api.ts)
marketplaces/ → External marketplace integrations (ML, Shopee)
```

**Pattern example** - Adding a new domain:

```typescript
// 1. interfaces/order.interface.ts - Types + Repository interface
// 2. repositories/order.repository.ts - class OrderRepositoryPrisma implements OrderRepository
// 3. usecases/order.usercase.ts - class OrderUseCase (injects repository via constructor)
// 4. routes/order.routes.ts - export const orderRoutes = async (fastify: FastifyInstance)
// 5. api/api.ts - api.register(orderRoutes, { prefix: "/orders" })
```

## Key Conventions

### File Naming

- Repositories: `*.repository.ts` with class `*RepositoryPrisma`
- Use Cases: `*.usercase.ts` (note: "usercase", not "usecase")
- Routes: `*.routes.ts`
- Interfaces: `*.interface.ts`
- React components: `kebab-case.tsx`

### UI Components

- **shadcn/ui** with New York style - components in `/components/ui/`
- Add new components via: `npx shadcn@latest add <component>`
- Icons: **lucide-react** exclusively
- Path aliases: `@/components`, `@/lib`, `@/hooks`

### Authentication Flow

- **NextAuth** (v4) with Credentials provider in `/app/lib/auth.ts`
- Session check in Server Components: `getServerSession(authOptions)`
- Protected pages redirect to `/login` when unauthenticated
- Fastify API uses custom header-based auth middleware (`email` header)

### Marketplace Integrations (`/app/marketplaces/`)

```
marketplaces/
├── mercado-livre/   → ML-specific constants (ml-constants.ts)
├── services/        → OAuth (ml-oauth.service.ts), PKCE (pkce.service.ts)
├── repositories/    → MarketplaceAccount persistence
├── types/           → OAuth types (ml-oauth.types.ts), Platform enum
└── usecases/        → Integration business logic (marketplace.usercase.ts)
```

**OAuth Flow (Mercado Livre):**

- Uses PKCE (RFC 7636) with SHA256 code challenge
- In-memory state storage with 10-min TTL for CSRF protection
- Auto token renewal when expired
- Requires ngrok for local development (ML doesn't accept localhost)

**Marketplace Routes:** `/marketplace/ml/*`

- `POST /ml/auth` → Initiate OAuth, returns authUrl + state
- `GET /ml/callback` → Process OAuth callback, save tokens
- `GET /ml/status` → Check connection status (requires auth)
- `DELETE /ml` → Disconnect marketplace (requires auth)

## Development Commands

```bash
npm run dev          # Next.js frontend (port 3000)
npm run api          # Fastify backend (port 3333) - uses tsx watch
npm run build        # Production build
npm run lint         # ESLint
npm run lint:prettier:fix  # Format code
```

### Database

```bash
npx prisma migrate dev    # Apply migrations
npx prisma generate       # Regenerate client
npx prisma studio         # Visual DB browser (port 5555)
npx prisma db push        # Push schema changes without migration
```

Schema at `/prisma/schema.prisma`. Central stock model: `Product.stock` is the source of truth.

### Local Testing with ngrok

```bash
npx ngrok http 3333       # Expose port 3333 publicly
# Update APP_BACKEND_URL in .env with ngrok URL
# Update Redirect URI in Mercado Livre developer panel
```

## Important Patterns

### Repository Implementation

Always convert Prisma `Decimal` to `number` in repository layer:

```typescript
price: result.price.toNumber(); // Convert Decimal for interface compatibility
```

Use `findFirst()` instead of `findUnique()` when no unique constraint exists:

```typescript
// Wrong: findUnique with non-unique fields
// Correct:
const account = await prisma.marketplaceAccount.findFirst({
  where: { userId, platform },
});
```

### Server Components + Client Boundary

Pages in `/app` are Server Components by default. Client interactivity requires:

- `"use client"` directive at file top
- Wrap providers in `/app/providers.tsx`
- Layout wrapper handles session hydration

### API Response Pattern

```typescript
// Success with pagination
reply.status(200).send({
  products: data.products,
  pagination: { page, limit, total, totalPages },
});

// Error response
reply.status(401).send({
  error: "Não autenticado",
  message: "Usuário não está autenticado",
});
```

### Environment Variables

Key variables in `.env`:

- `DATABASE_URL` - Neon PostgreSQL connection string
- `NEXTAUTH_SECRET` - NextAuth encryption key
- `ML_CLIENT_ID`, `ML_CLIENT_SECRET` - Mercado Livre OAuth credentials
- `APP_BACKEND_URL` - Backend URL (use ngrok URL for local ML testing)

## Language Note

Code comments and user-facing strings are in **Portuguese (Brazilian)**. Keep this consistency in new code.
