import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentX",
  description: "Bug-fix agent workspace"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => { try { const theme = localStorage.getItem("agentx-theme"); if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme; } catch (_) {} })();`
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
