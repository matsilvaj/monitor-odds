import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { Client } from "pg";

function buildConnectionString() {
  const rawUrl = process.env.SUPABASE_DB_URL;
  const rawPassword = process.env.SUPABASE_DB_PASSWORD;
  if (!rawUrl) return null;

  if (!rawPassword) return rawUrl;

  const url = new URL(rawUrl);
  if (url.password === "[YOUR-PASSWORD]" || url.password === "" || decodeURIComponent(url.password) !== rawPassword) {
    url.password = rawPassword;
  }

  return url.toString();
}

const connectionString = buildConnectionString();

if (!connectionString) {
  console.error("SUPABASE_DB_URL nao foi preenchida no .env.");
  console.error("Pegue a URI em Supabase -> Connect -> Session pooler ou Direct connection.");
  process.exit(1);
}

const schemaPath = path.resolve("supabase", "schema.sql");
const sql = await fs.readFile(schemaPath, "utf8");
const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

try {
  const parsed = new URL(connectionString);
  console.log(`Conectando em ${parsed.hostname}:${parsed.port || "5432"} como ${decodeURIComponent(parsed.username)}...`);
  await client.connect();
  await client.query(sql);
  console.log("Schema aplicado com sucesso no Supabase.");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "28P01") {
    console.error("Falha de autenticacao no Postgres do Supabase.");
    console.error("Confira se a SUPABASE_DB_URL usa a senha do banco, nao a API key.");
    console.error("Se a senha tiver caracteres especiais, aplique URL encode: @=%40, #=%23, :=%3A, /=%2F, %%=%25.");
  }
  throw error;
} finally {
  await client.end();
}
