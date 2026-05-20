import { collectAllBookmakers } from "../bookmakers/registry.js";

try {
  await collectAllBookmakers();
  console.log("[sync] sync:odds finalizado.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
