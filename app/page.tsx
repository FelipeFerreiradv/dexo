import { Package, Warehouse, ShoppingCart, TrendingUp } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const stats = [
  {
    title: "Total de Produtos",
    value: "1.284",
    description: "+12% em relação ao mês anterior",
    icon: Package,
  },
  {
    title: "Itens em Estoque",
    value: "45.231",
    description: "Unidades disponíveis",
    icon: Warehouse,
  },
  {
    title: "Pedidos Pendentes",
    value: "89",
    description: "Aguardando processamento",
    icon: ShoppingCart,
  },
  {
    title: "Vendas do Mês",
    value: "R$ 124.500",
    description: "+8% em relação ao mês anterior",
    icon: TrendingUp,
  },
]

export default function Home() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h2>
        <p className="text-muted-foreground">
          Visão geral do seu estoque e vendas
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card className="" key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <stat.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Integrações Ativas</CardTitle>
            <CardDescription>Status das conexões com marketplaces</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                    <span className="text-sm font-semibold text-primary">ML</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Mercado Livre</p>
                    <p className="text-xs text-muted-foreground">Última sync: há 5 min</p>
                  </div>
                </div>
                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  Conectado
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-orange-500/10">
                    <span className="text-sm font-semibold text-orange-500">SP</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Shopee</p>
                    <p className="text-xs text-muted-foreground">Última sync: há 12 min</p>
                  </div>
                </div>
                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  Conectado
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alertas de Estoque</CardTitle>
            <CardDescription>Produtos com estoque baixo</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Camiseta Básica Preta - M</p>
                  <p className="text-xs text-muted-foreground">SKU: CAM-BAS-PRT-M</p>
                </div>
                <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-1 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  3 unidades
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Calça Jeans Slim - 42</p>
                  <p className="text-xs text-muted-foreground">SKU: CAL-JNS-SLM-42</p>
                </div>
                <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                  8 unidades
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Tênis Running Pro - 40</p>
                  <p className="text-xs text-muted-foreground">SKU: TEN-RUN-PRO-40</p>
                </div>
                <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                  5 unidades
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
