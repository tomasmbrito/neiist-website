import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "neiist.tecnico.ulisboa.pt",
        pathname: "/api/user/photo/:path*",
      },
    ],
    localPatterns: [{ pathname: "/api/user/photo/**" }, { pathname: "/**/**" }],
  },
  // Uploaded product images are served straight from public/ as static files, and proxy.ts
  // deliberately excludes `products/` and every path containing a dot from its matcher — so
  // addSecurityHeaders never runs for them and they went out with no nosniff and no CSP (#95).
  //
  // Magic-byte validation on upload is what actually stops a polyglot being executed, and it
  // still holds; this removes the dependence on that being the only layer. Set here rather than
  // in the matcher because these are static assets that never reach middleware.
  async headers() {
    return [
      {
        source: "/products/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Nothing in an image directory should ever be executed or framed.
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
        ],
      },
    ];
  },
};

export default nextConfig;
