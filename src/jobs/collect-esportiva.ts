import { collectEsportiva } from "../services/esportiva-collector.js";

try {
  const summary = await collectEsportiva();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
