const { spawn } = require("node:child_process");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const webEnvironment = {
  ...process.env,
  NEXT_IGNORE_INCORRECT_LOCKFILE: "1"
};
const children = [
  spawn(npmCommand, ["run", "dev:web"], { stdio: "inherit", env: webEnvironment, shell: process.platform === "win32" })
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Unable to start AgentX development service:", error.message);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`AgentX development service exited with ${signal || `code ${code}`}.`);
      shutdown(code || 1);
    }
  });
}

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
