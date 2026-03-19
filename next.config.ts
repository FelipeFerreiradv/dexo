import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable React compiler optimizations (auto-memoization)
  reactStrictMode: true,
  // Compress responses
  compress: true,
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
        port: "3333",
        pathname: "/uploads/**",
      },
      {
        protocol: "https",
        hostname: "**",
        pathname: "/uploads/**",
      },
      {
        protocol: "http",
        hostname: "http2.mlstatic.com",
      },
    ],
  },
  // Enable build-time optimizations
  experimental: {
    optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
  },
};

export default nextConfig;
