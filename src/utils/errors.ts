export function errorMessage(error: unknown) {
  if (error instanceof Error) {
    const directCode = "code" in error && typeof error.code === "string" ? error.code : null;
    const cause = "cause" in error ? error.cause : null;
    const causeCode = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : null;
    const code = directCode ?? causeCode;

    return code && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
