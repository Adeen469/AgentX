import fs from "node:fs";
import path from "node:path";

const rootEnvPath = path.resolve(process.cwd(), "../../.env.local");
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Security headers, applied to every route. Notes:
  // - GitHub OAuth is a top-level redirect to github.com, not a fetch,
  //   form post, or iframe, so CSP does not interfere with it. No other
  //   OAuth provider callback route exists.
  // - `script-src 'unsafe-inline'` is deliberate: Next.js App Router
  //   streams its RSC payload through inline <script> tags, so a strict
  //   script-src would break the app. A nonce-based CSP would need Edge
  //   middleware, which this deployment cannot use (see redirects note
  //   below). 'unsafe-inline' + default-src 'self' still blocks loading
  //   scripts from any other origin.
  // - HSTS `preload` is only honoured once the domain is submitted to the
  //   preload list; includeSubDomains assumes all subdomains serve HTTPS.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self'",
              "connect-src 'self' https://api.github.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
  // Legacy paths redirect to their /app/* equivalents. These are plain
  // routing redirects, not Edge middleware: Vercel services reject Edge
  // Function output ("middleware"), which failed every deployment that
  // included middleware.ts.
  async redirects() {
    return [
      { source: "/workspace", destination: "/app/workspace", permanent: false },
      { source: "/review", destination: "/app/review", permanent: false },
      { source: "/repositories", destination: "/app/repositories", permanent: false },
      { source: "/settings", destination: "/app/settings", permanent: false },
      { source: "/investigate", destination: "/app", permanent: false },
    ];
  },
};

export default nextConfig;
