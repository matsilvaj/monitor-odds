import "dotenv/config";
import { collectFastBookmakers } from "./src/bookmakers/registry.js";
const t0 = Date.now();
await collectFastBookmakers({ logProgress: false, trigger: "watch" });
console.log(`CICLO COMPLETO: ${Math.round((Date.now()-t0)/1000)}s`);
process.exit(0);
