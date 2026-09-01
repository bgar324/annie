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
    "Annie — local control",
    `<header class="topbar">
      <div>
        <h1>Annie</h1>
        <p>Local control</p>
      </div>
      <p class="service-status"><span aria-hidden="true"></span>${model.ready ? "Live state" : "Starting"}</p>
    </header>
    ${renderNotice(model.notice)}
    <main class="workspace">
      <section class="accounts" aria-labelledby="accounts-heading">
        <div class="section-heading">
          <div>
            <h2 id="accounts-heading">Accounts</h2>
            <p>Connection health and granted access.</p>
          </div>
          <span class="count">${model.accounts.length}</span>
        </div>
        ${renderAccounts(model.accounts)}
        <form class="account-action" method="post" action="/connections/google" target="_blank" rel="noopener">
          <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
          <button class="button button-primary" type="submit"${controlsDisabled ? " disabled" : ""}>Add Google account</button>
          <p>${connectHint(model.ready)}</p>
        </form>
      </section>

      <section class="memory" aria-labelledby="memory-heading">
        <div class="section-heading memory-heading">
          <div>
            <h2 id="memory-heading">Memory</h2>
            <p>The complete contents of <code>MEMORY.md</code>.</p>
          </div>
          <p class="byte-count"><strong>${editorBytes.toLocaleString("en-US")}</strong> / ${model.memory.maximumBytes.toLocaleString("en-US")} bytes</p>
        </div>
        <form method="post" action="/memory">
          <input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
          <input type="hidden" name="expectedRevision" value="${escapeHtml(model.memory.revision)}">
          <label class="sr-only" for="memory-content">Memory document</label>
          <textarea id="memory-content" name="content" rows="22" spellcheck="true" aria-describedby="memory-help"${controlsDisabled ? " disabled" : ""}>${escapeHtml(editorContent)}</textarea>
          <div class="memory-footer">
            <p id="memory-help">Start with <code># Memory</code>. Use <code>##</code> for sections. Saving normalizes line endings and trailing whitespace.</p>
            <button class="button button-primary" type="submit"${controlsDisabled ? " disabled" : ""}>Save memory</button>
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
      <div>
        <h1>Annie</h1>
        <p>Local control</p>
      </div>
    </header>
    <main class="conflict" id="status" tabindex="-1">
      <h2>Memory changed while you were editing</h2>
      <p>Annie or another browser saved a newer revision. Nothing from your draft was applied.</p>
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
      <a class="button button-primary" href="/">Reload the editor</a>
    </main>`,
  );
}

export function renderLocalUiErrorPage(title: string, message: string): string {
  return documentShell(
    `${title} — Annie`,
    `<header class="topbar">
      <div>
        <h1>Annie</h1>
        <p>Local control</p>
      </div>
    </header>
    <main class="error-page" id="status" tabindex="-1">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <a class="button button-primary" href="/">Return to local control</a>
    </main>`,
  );
}

function renderAccounts(accounts: readonly SafeConnectionView[]): string {
  if (accounts.length === 0) {
    return `<div class="empty-state"><p>No accounts connected.</p><p>Add Google to use Gmail, Calendar, Drive, Contacts, and Tasks.</p></div>`;
  }
  return `<ul class="account-list">${accounts
    .map(
      (account) => `<li>
        <div class="account-title">
          <div><span class="provider">${providerLabel(account.provider)}</span><h3>${escapeHtml(account.label)}</h3></div>
          <span class="health" data-status="${escapeHtml(account.status)}"><i aria-hidden="true"></i>${statusLabel(account.status)}</span>
        </div>
        <p class="capabilities">${account.capabilities.map(capabilityLabel).join(" · ")}</p>
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
  if (!ready) {
    return "Available after Annie finishes starting.";
  }
  return "Google opens in a new tab. Reload this page after it says the account is connected.";
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
    "gmail.read": "Gmail read",
    "calendar.read": "Calendar read",
    "drive.read": "Drive read",
    "contacts.read": "Contacts read",
    "tasks.read": "Tasks read",
    "notion.search": "Notion search",
    "notion.fetch": "Notion fetch",
    "notion.create_page": "Notion create page",
    "notion.update_page": "Notion update page",
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
:root{color-scheme:light;--bg:#f3f3f0;--surface:#fff;--ink:#1d1d1b;--muted:#686863;--line:#deded8;--accent:#2859c5;--accent-dark:#1f469b;--success:#267249;--warning:#986315;--danger:#a43a32;--focus:#0b63ce;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink)}
body:before{content:"";display:block;height:4px;background:var(--accent)}
code,pre,textarea{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
.topbar,.workspace,.notice,.conflict,.error-page{width:min(70rem,calc(100% - 2rem));margin-inline:auto}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:1.75rem 0 1.25rem}
h1,h2,h3,p{margin-top:0}
h1{font-size:1.35rem;line-height:1.2;margin-bottom:.2rem;letter-spacing:-.015em}
.topbar>div>p,.section-heading p,.memory-footer p,.account-action p,.empty-state p:last-child{color:var(--muted);margin-bottom:0}
.service-status{display:flex;align-items:center;gap:.5rem;margin:0;color:var(--muted);font-size:.9rem}
.service-status span{width:.55rem;height:.55rem;border-radius:50%;background:var(--success)}
.workspace{display:grid;grid-template-columns:minmax(17rem,.72fr) minmax(0,1.55fr);background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(25,25,20,.05);margin-bottom:3rem}
.workspace>section{padding:1.5rem}
.memory{border-left:1px solid var(--line)}
.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.25rem}
.section-heading h2,.conflict h2,.error-page h2{font-size:1.05rem;line-height:1.3;margin-bottom:.25rem}
.section-heading p{font-size:.88rem}
.count{display:grid;place-items:center;min-width:1.8rem;height:1.8rem;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:.85rem}
.account-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.account-list li{padding:1rem 0;border-bottom:1px solid var(--line)}
.account-title{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}
.account-title h3{font-size:.95rem;margin:.12rem 0 0;overflow-wrap:anywhere}
.provider{text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-size:.7rem;font-weight:700}
.health{display:inline-flex;align-items:center;gap:.4rem;white-space:nowrap;font-size:.76rem;color:var(--muted)}
.health i{width:.45rem;height:.45rem;border-radius:50%;background:currentColor}
.health[data-status="healthy"]{color:var(--success)}
.health[data-status="degraded"]{color:var(--warning)}
.health[data-status="reconnect_required"],.health[data-status="disconnected"]{color:var(--danger)}
.capabilities{color:var(--muted);font-size:.78rem;line-height:1.55;margin:.65rem 0 0}
.account-action{margin-top:1.25rem}
.account-action p{font-size:.78rem;margin-top:.65rem}
.empty-state{padding:1.1rem 0;border-block:1px solid var(--line)}
.empty-state p{margin-bottom:.3rem}
.memory-heading{align-items:center}
.byte-count{white-space:nowrap!important;font-size:.78rem!important}
textarea{display:block;width:100%;min-height:28rem;resize:vertical;border:1px solid #c9c9c2;border-radius:8px;background:#fdfdfb;color:var(--ink);font-size:16px;line-height:1.55;padding:1rem;tab-size:2}
textarea:disabled{background:#f1f1ee;color:var(--muted)}
.memory-footer{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-top:1rem}
.memory-footer p{font-size:.8rem;max-width:38rem;margin-bottom:0}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid transparent;border-radius:7px;padding:.65rem 1rem;font:inherit;font-weight:650;text-decoration:none;white-space:nowrap;cursor:pointer}
.button-primary{background:var(--accent);color:#fff}
.button-primary:hover{background:var(--accent-dark)}
.button:disabled{background:#d9d9d4;color:#74746f;cursor:not-allowed}
.button:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.notice{border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--surface);padding:.85rem 1rem;margin-bottom:1rem;border-radius:6px}
.notice[data-kind="success"]{border-left-color:var(--success)}
.notice[data-kind="error"]{border-left-color:var(--danger)}
.conflict,.error-page{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:1.5rem;margin-bottom:3rem}
.conflict>p,.error-page>p{color:var(--muted)}
.comparison{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1.5rem 0}
.comparison section{min-width:0}
.comparison h3{font-size:.85rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:25rem;overflow:auto;background:#f5f5f2;border:1px solid var(--line);border-radius:8px;padding:1rem;font-size:.82rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:48rem){.workspace{grid-template-columns:1fr}.memory{border-left:0;border-top:1px solid var(--line)}.memory-footer{flex-direction:column}.memory-footer .button{width:100%}.comparison{grid-template-columns:1fr}.topbar{align-items:flex-start}.service-status{margin-top:.2rem}}
@media(max-width:32rem){.topbar,.workspace,.notice,.conflict,.error-page{width:min(100% - 1rem,70rem)}.topbar{padding:1.25rem .25rem 1rem}.workspace>section,.conflict,.error-page{padding:1rem}.section-heading,.memory-heading{display:block}.count{margin-top:.7rem;width:max-content}.byte-count{margin-top:.65rem!important}.account-title{display:block}.health{margin-top:.5rem}.button{width:100%}textarea{min-height:22rem}}
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
