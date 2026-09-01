import type { SafeConnectionView } from "../connections/types.js";
import type { MemorySnapshot } from "../memory/document.js";

export type LocalUiNotice =
  | { readonly kind: "success" | "neutral" | "error"; readonly message: string }
  | undefined;

export interface LocalUiPageModel {
  readonly accounts: readonly SafeConnectionView[];
  readonly memory: MemorySnapshot;
  readonly draft?: string;
  readonly csrfToken: string;
  readonly ready: boolean;
  readonly notice?: LocalUiNotice;
}

export interface MemoryConflictPageModel {
  readonly current: MemorySnapshot;
  readonly draft: string;
}

export function renderLocalUiPage(model: LocalUiPageModel): string {
  const editorContent = model.draft ?? model.memory.content;
  const editorBytes = Buffer.byteLength(editorContent);
  const controlsDisabled = !model.ready;
  return documentShell(
    "Annie — control",
    `<header class="topbar">
      <h1>Annie</h1>
      <p class="service-status"><span aria-hidden="true"></span>${model.ready ? "Live" : "Starting"}</p>
    </header>
    ${renderNotice(model.notice)}
    <main class="workspace">
      <section class="accounts" aria-labelledby="accounts-heading">
        <div class="section-heading">
          <h2 id="accounts-heading">Accounts <span class="count">${model.accounts.length}</span></h2>
        </div>
        ${renderAccounts(model.accounts)}
        <form class="account-action" method="post" action="/connections/google" target="_blank" rel="noopener">
          <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
          <button class="button button-secondary" type="submit"${controlsDisabled ? " disabled" : ""}>Add Google account</button>
          <p>${connectHint(model.ready)}</p>
        </form>
      </section>

      <section class="memory" aria-labelledby="memory-heading">
        <div class="section-heading memory-heading">
          <h2 id="memory-heading">Memory</h2>
          <p class="byte-count"><strong>${editorBytes.toLocaleString("en-US")}</strong> / ${model.memory.maximumBytes.toLocaleString("en-US")} bytes</p>
        </div>
        <form class="memory-form" method="post" action="/memory">
          <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
          <input type="hidden" name="expectedRevision" value="${escapeHtml(model.memory.revision)}">
          <label class="sr-only" for="memory-content">Memory document</label>
          <textarea id="memory-content" name="content" rows="22" spellcheck="true" aria-describedby="memory-help"${controlsDisabled ? " disabled" : ""}>${escapeHtml(editorContent)}</textarea>
          <div class="memory-footer">
            <p id="memory-help"><code># Memory</code> is required. Trailing whitespace is removed on save.</p>
            <button class="button button-primary" type="submit"${controlsDisabled ? " disabled" : ""}>Save</button>
          </div>
        </form>
      </section>
    </main>`,
  );
}

export function renderMemoryConflictPage(model: MemoryConflictPageModel): string {
  return documentShell(
    "Memory changed — Annie",
    `<header class="topbar">
      <h1>Annie</h1>
    </header>
    <main class="conflict" id="status" tabindex="-1">
      <h2>Memory changed</h2>
      <p>A newer revision was saved. Your draft was not applied.</p>
      <div class="comparison">
        <section>
          <h3>Current memory</h3>
          <pre>${escapeHtml(model.current.content)}</pre>
        </section>
        <section>
          <h3>Your unsaved draft</h3>
          <pre>${escapeHtml(model.draft)}</pre>
        </section>
      </div>
      <a class="button button-primary" href="/">Reload</a>
    </main>`,
  );
}

export function renderLocalUiErrorPage(title: string, message: string): string {
  return documentShell(
    `${title} — Annie`,
    `<header class="topbar">
      <h1>Annie</h1>
    </header>
    <main class="error-page" id="status" tabindex="-1">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <a class="button button-primary" href="/">Return</a>
    </main>`,
  );
}

function renderAccounts(accounts: readonly SafeConnectionView[]): string {
  if (accounts.length === 0) {
    return `<div class="empty-state"><p>No accounts connected.</p></div>`;
  }
  return `<ul class="account-list">${accounts
    .map(
      (account) => `<li>
        <div class="account-title">
          <h3>${escapeHtml(account.label)}</h3>
          <span class="health" data-status="${escapeHtml(account.status)}"><i aria-hidden="true"></i>${statusLabel(account.status)}</span>
        </div>
        <p class="account-details"><span class="provider">${providerLabel(account.provider)}</span><span aria-hidden="true"> · </span>${account.capabilities.map(capabilityLabel).join(" · ")}</p>
      </li>`,
    )
    .join("")}</ul>`;
}

function renderNotice(notice: LocalUiNotice): string {
  if (notice === undefined) {
    return "";
  }
  return `<div class="notice" data-kind="${notice.kind}" id="status" role="status" tabindex="-1">${escapeHtml(notice.message)}</div>`;
}

function connectHint(ready: boolean): string {
  return ready ? "Reload after connecting." : "Available when Annie is ready.";
}

function providerLabel(provider: SafeConnectionView["provider"]): string {
  return provider === "google" ? "Google" : "Notion";
}

function statusLabel(status: SafeConnectionView["status"]): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "reconnect_required":
      return "Reconnect required";
    case "disconnected":
      return "Disconnected";
  }
}

function capabilityLabel(capability: SafeConnectionView["capabilities"][number]): string {
  const labels: Record<SafeConnectionView["capabilities"][number], string> = {
    "gmail.read": "Gmail",
    "calendar.read": "Calendar",
    "drive.read": "Drive",
    "contacts.read": "Contacts",
    "tasks.read": "Tasks",
    "notion.search": "Search",
    "notion.fetch": "Read pages",
    "notion.create_page": "Create pages",
    "notion.update_page": "Update pages",
  };
  return labels[capability];
}

function documentShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--bg:#f5f5f3;--surface:#fff;--surface-subtle:#fafaf8;--ink:#20201e;--muted:#6c6c67;--line:#deded9;--line-strong:#c8c8c1;--accent:#1859d1;--accent-hover:#1249ad;--success:#217a4b;--warning:#986515;--danger:#b03a32;--focus:#0b63ce;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--ink)}
code,pre,textarea{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
.topbar,.workspace,.notice,.conflict,.error-page{width:min(76rem,calc(100% - 3rem));margin-inline:auto}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:1.25rem 0 .9rem}
h1,h2,h3,p{margin-top:0}
h1{margin-bottom:0;font-size:1.25rem;line-height:1.2;letter-spacing:-.02em}
h2{font-size:1rem;line-height:1.3}
.topbar>div>p,.memory-footer p,.account-action p,.empty-state p{color:var(--muted);margin-bottom:0}
.service-status{display:flex;align-items:center;gap:.45rem;margin:0;color:var(--muted);font-size:.8rem}
.service-status span{width:.45rem;height:.45rem;border-radius:50%;background:var(--success)}
.workspace{display:grid;grid-template-columns:20.5rem minmax(0,1fr);height:min(50rem,calc(100dvh - 6.25rem));min-height:36rem;overflow:hidden;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 1px 2px rgba(28,28,24,.04);margin-bottom:2rem}
.workspace>section{min-width:0;padding:1.25rem}
.accounts{display:flex;min-height:0;flex-direction:column;background:var(--surface-subtle)}
.memory{display:flex;min-height:0;flex-direction:column;border-left:1px solid var(--line)}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.section-heading h2,.conflict h2,.error-page h2{margin-bottom:0}
.count{margin-left:.35rem;color:var(--muted);font-size:.8rem;font-weight:500}
.account-list{flex:1;min-height:0;overflow:auto;list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.account-list li{padding:.9rem 0;border-bottom:1px solid var(--line)}
.account-title{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}
.account-title h3{min-width:0;margin:0;font-size:.9rem;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
.account-details{margin:.35rem 0 0;color:var(--muted);font-size:.76rem;line-height:1.5}
.provider{font-weight:650;color:#4e4e49}
.health{display:inline-flex;align-items:center;gap:.35rem;white-space:nowrap;font-size:.74rem;color:var(--muted)}
.health i{width:.4rem;height:.4rem;border-radius:50%;background:currentColor}
.health[data-status="healthy"]{color:var(--success)}
.health[data-status="degraded"]{color:var(--warning)}
.health[data-status="reconnect_required"],.health[data-status="disconnected"]{color:var(--danger)}
.account-action{padding-top:1rem}
.account-action p{margin:.45rem 0 0;font-size:.74rem}
.empty-state{flex:1;padding:1rem 0;border-top:1px solid var(--line)}
.memory-heading{flex:0 0 auto}
.byte-count{margin:0;color:var(--muted);white-space:nowrap;font-size:.76rem}
.memory-form{display:flex;min-height:0;flex:1;flex-direction:column}
textarea{display:block;width:100%;min-height:0;flex:1;resize:none;border:1px solid var(--line-strong);border-radius:6px;background:#fff;color:var(--ink);font-size:14px;line-height:1.55;padding:.9rem;tab-size:2}
textarea:hover{border-color:#aaa9a1}
textarea:focus{border-color:var(--focus);outline:2px solid rgba(11,99,206,.18);outline-offset:1px}
textarea:disabled{background:#f0f0ed;color:var(--muted)}
.memory-footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:.85rem}
.memory-footer p{font-size:.75rem}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid transparent;border-radius:6px;padding:.6rem .95rem;font:inherit;font-weight:650;line-height:1;text-decoration:none;white-space:nowrap;cursor:pointer}
.button-primary{background:var(--accent);color:#fff}
.button-primary:hover{background:var(--accent-hover)}
.button-secondary{background:#fff;border-color:var(--line-strong);color:var(--ink)}
.button-secondary:hover{background:#f2f2ef}
.button:disabled{background:#e2e2de;border-color:#d5d5cf;color:#777772;cursor:not-allowed}
.button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.notice{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--surface);padding:.75rem .9rem;margin-bottom:.75rem;border-radius:6px}
.notice[data-kind="success"]{border-left-color:var(--success)}
.notice[data-kind="error"]{border-left-color:var(--danger)}
.conflict,.error-page{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1.25rem;margin-bottom:2rem}
.conflict>p,.error-page>p{color:var(--muted)}
.comparison{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1.25rem 0}
.comparison section{min-width:0}
.comparison h3{font-size:.85rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:25rem;overflow:auto;background:var(--surface-subtle);border:1px solid var(--line);border-radius:6px;padding:.9rem;font-size:.8rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:48rem){.topbar,.workspace,.notice,.conflict,.error-page{width:min(100% - 1.5rem,76rem)}.workspace{display:block;height:auto;min-height:0;overflow:visible}.accounts{display:block}.account-list{overflow:visible}.memory{border-left:0;border-top:1px solid var(--line)}.memory-form{display:block}.memory-footer{align-items:flex-start}.comparison{grid-template-columns:1fr}textarea{min-height:30rem;resize:vertical}}
@media(max-width:32rem){.topbar,.workspace,.notice,.conflict,.error-page{width:min(100% - 1rem,76rem)}.topbar{padding:1rem .15rem .75rem}.workspace>section,.conflict,.error-page{padding:1rem}.memory-footer{flex-direction:column}.memory-footer .button,.account-action .button{width:100%}textarea{min-height:26rem;font-size:16px}}
</style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
