const { spawn } = require("node:child_process");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set();

function start(name, args) {
  console.log(`[${name}] npm ${args.join(" ")}`);
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true
  });

  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (signal) console.log(`[${name}] finalizado por ${signal}`);
    else if (code && code !== 0) console.log(`[${name}] finalizado com codigo ${code}`);
  });

  return child;
}

function stopAll() {
  for (const child of children) {
    child.kill("SIGINT");
  }
}

process.on("SIGINT", () => {
  stopAll();
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  stopAll();
  setTimeout(() => process.exit(0), 500);
});

start("api", ["run", "dev"]);

const delayMs = 8000;
console.log(`[sync] aguardando ${Math.round(delayMs / 1000)}s para a API iniciar...`);
setTimeout(() => start("sync", ["run", "sync:watch"]), delayMs);
