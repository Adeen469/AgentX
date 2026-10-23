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
  output: "standalone"
};

export default nextConfig;
