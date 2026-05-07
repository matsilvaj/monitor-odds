import { collectAllBookmakers } from "../bookmakers/registry.js";

try {
  const bookmakers = await collectAllBookmakers();
  console.log(JSON.stringify({ bookmakers }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
