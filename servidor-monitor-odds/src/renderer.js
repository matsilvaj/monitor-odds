const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const chromeButton = document.querySelector("#chrome-button");
const chromePath = document.querySelector("#chrome-path");
const statusPill = document.querySelector("#status-pill");
const pendingList = document.querySelector("#pending-list");
const logOutput = document.querySelector("#log-output");

let pendingRequests = [];
let bookmakerIssues = [];

function setStatus(status) {
  const textByStatus = {
    parado: "Parado",
    iniciando: "Iniciando",
    rodando: "Rodando",
    erro: "Erro"
  };

  statusPill.textContent = textByStatus[status] ?? status;
  statusPill.className = "status-pill";
  if (status === "rodando" || status === "iniciando") statusPill.classList.add("running");
  if (status === "erro") statusPill.classList.add("error");

  startButton.disabled = status === "rodando" || status === "iniciando";
  stopButton.disabled = status !== "rodando" && status !== "iniciando";
}

function applyState(state) {
  if (!state) return;
  setStatus(state.status);
  chromePath.textContent = state.chromeExecutablePath ? `Chrome: ${state.chromeExecutablePath}` : "Chrome: nao configurado";
  if (Array.isArray(state.pendingRequests)) pendingRequests = state.pendingRequests;
  if (Array.isArray(state.bookmakerIssues)) bookmakerIssues = state.bookmakerIssues;
  renderAttention();
}

function appendLog(text) {
  const next = `${logOutput.textContent}${logOutput.textContent ? "\n" : ""}${text}`;
  const lines = next.split(/\r?\n/).slice(-300);
  logOutput.textContent = lines.join("\n");
  logOutput.scrollTop = logOutput.scrollHeight;
}

function pendingMessage(request) {
  if (request.reason === "saved-url-failed") {
    return `A URL salva para "${request.leagueName}" nao funcionou.\nEntre na ${request.bookmakerName} e atualize a URL da competicao:`;
  }

  return `Nao encontrei a competicao "${request.leagueName}" na ${request.bookmakerName}.\nEntre na ${request.bookmakerName} e pegue a URL da competicao:`;
}

function renderIssueCard(issue) {
  const card = document.createElement("article");
  card.className = "pending-card issue-card";

  const title = document.createElement("h3");
  title.textContent = `${issue.bookmakerName ?? issue.bookmakerSlug} precisa de atencao`;

  const message = document.createElement("p");
  message.textContent = `Erro na ultima coleta: ${issue.message}`;

  const meta = document.createElement("div");
  meta.className = "issue-meta";
  meta.textContent = issue.updatedAt ? `Atualizado em ${new Date(issue.updatedAt).toLocaleString("pt-BR")}` : "Confira os logs para mais detalhes.";

  card.append(title, message, meta);
  pendingList.append(card);
}

function renderPendingRequestCard(request) {
  const card = document.createElement("article");
  card.className = "pending-card";

  const title = document.createElement("h3");
  title.textContent = `${request.bookmakerName} precisa de atencao`;

  const message = document.createElement("p");
  message.textContent = pendingMessage(request);

  const row = document.createElement("div");
  row.className = "url-row";

  const input = document.createElement("input");
  input.type = "url";
  input.placeholder = "URL da competicao";
  input.autocomplete = "off";

  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = request.mode === "update" ? "Atualizar URL" : "Adicionar URL";

  const feedback = document.createElement("div");
  feedback.className = "message";

  button.addEventListener("click", async () => {
    button.disabled = true;
    feedback.textContent = "";
    const result = await window.monitorOdds.saveCompetitionUrl({
      requestId: request.id,
      url: input.value
    });

    if (!result?.ok) {
      feedback.textContent = result?.error ?? "Nao consegui salvar a URL.";
      button.disabled = false;
      return;
    }

    feedback.textContent = "URL salva. O proximo ciclo vai usar esse link.";
    card.remove();
    pendingRequests = pendingRequests.filter((item) => item.id !== request.id);
    renderAttention();
  });

  row.append(input, button);
  card.append(title, message, row, feedback);
  pendingList.append(card);
}

function renderAttention() {
  pendingList.innerHTML = "";

  if (!bookmakerIssues.length && !pendingRequests.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nenhuma pendencia no momento.";
    pendingList.append(empty);
    return;
  }

  for (const issue of bookmakerIssues) renderIssueCard(issue);
  for (const request of pendingRequests) renderPendingRequestCard(request);
}

startButton.addEventListener("click", async () => {
  const result = await window.monitorOdds.startMonitor();
  if (!result?.ok) appendLog(result?.error ?? "Nao consegui iniciar o monitor.");
});

stopButton.addEventListener("click", () => {
  window.monitorOdds.stopMonitor();
});

chromeButton.addEventListener("click", () => {
  window.monitorOdds.selectChrome();
});

window.monitorOdds.onState(applyState);
window.monitorOdds.onLog(appendLog);
window.monitorOdds.onPendingRequests((requests) => {
  pendingRequests = Array.isArray(requests) ? requests : [];
  renderAttention();
});
window.monitorOdds.onBookmakerIssues((issues) => {
  bookmakerIssues = Array.isArray(issues) ? issues : [];
  renderAttention();
});
window.monitorOdds.getState().then(applyState);
