import { env } from "./config/env.js";
import { buildServer } from "./api/server.js";

const app = buildServer();

try {
  await app.listen({ port: env.PORT, host: env.API_HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
