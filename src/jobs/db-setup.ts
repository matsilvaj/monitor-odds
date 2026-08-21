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

// O pooler do Supabase apresenta uma cadeia self-signed que o bundle padrao do Node
// nao valida. Baixe o certificado em Supabase -> Settings -> Database -> SSL configuration
// e aponte SUPABASE_DB_CA_CERT para o arquivo (ou cole o PEM na propria variavel).
// SUPABASE_DB_SSL_INSECURE=1 desliga a verificacao — use so em rede confiavel.
async function buildSsl() {
  const ca = process.env.SUPABASE_DB_CA_CERT;
  if (ca) {
    const pem = ca.includes("BEGIN CERTIFICATE") ? ca : await fs.readFile(path.resolve(ca), "utf8");
    return { ca: pem, rejectUnauthorized: true };
  }

  if (process.env.SUPABASE_DB_SSL_INSECURE === "1") {
    console.warn("AVISO: verificacao de certificado desligada (SUPABASE_DB_SSL_INSECURE=1).");
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
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
  ssl: await buildSsl()
});

try {
  const parsed = new URL(connectionString);
  console.log(`Conectando em ${parsed.hostname}:${parsed.port || "5432"} como ${decodeURIComponent(parsed.username)}...`);
  await client.connect();
  await client.query(sql);
  console.log("Schema aplicado com sucesso no Supabase.");
} catch (error) {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "28P01") {
      console.error("Falha de autenticacao no Postgres do Supabase.");
      console.error("Confira se a SUPABASE_DB_URL usa a senha do banco, nao a API key.");
      console.error("Se a senha tiver caracteres especiais, aplique URL encode: @=%40, #=%23, :=%3A, /=%2F, %%=%25.");
    }
    if (error.code === "SELF_SIGNED_CERT_IN_CHAIN" || error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      console.error("O certificado do Supabase nao foi validado pelo bundle padrao do Node.");
      console.error("Baixe o CA em Settings -> Database -> SSL configuration e defina SUPABASE_DB_CA_CERT=caminho/do/arquivo.crt");
      console.error("Alternativa temporaria em rede confiavel: SUPABASE_DB_SSL_INSECURE=1 npm run db:setup");
    }
  }
  throw error;
} finally {
  await client.end();
}
