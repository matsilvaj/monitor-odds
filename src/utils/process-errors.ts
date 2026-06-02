const NON_FATAL_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ERR_SSL_UNSUPPORTED_ELLIPTIC_CURVE",
  "ERR_CRYPTO_OPERATION_FAILED",
  "UND_ERR_SOCKET"
]);

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = "code" in error ? error.code : null;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isKnownNonFatalError(error: unknown) {
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();
  return (
    (code != null && NON_FATAL_ERROR_CODES.has(code)) ||
    message.includes("unsupported_elliptic_curve") ||
    message.includes("unsupported elliptic curve") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

export function installProcessErrorHandlers() {
  process.on("uncaughtException", (error) => {
    if (isKnownNonFatalError(error)) {
      console.warn(`[sync] Erro de rede/TLS ignorado para manter o monitor ativo: ${errorMessage(error)}`);
      return;
    }

    console.error(error);
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (reason) => {
    if (isKnownNonFatalError(reason)) {
      console.warn(`[sync] Rejeicao de rede/TLS ignorada para manter o monitor ativo: ${errorMessage(reason)}`);
      return;
    }

    console.error(reason);
    process.exitCode = 1;
  });
}
