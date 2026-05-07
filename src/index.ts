import { env } from "./config/env.js";
import { buildServer } from "./api/server.js";

const app = buildServer();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
