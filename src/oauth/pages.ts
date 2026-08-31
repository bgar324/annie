import type { FastifyReply } from "fastify";

export function sendOAuthPage(
  reply: FastifyReply,
  statusCode: number,
  title: string,
  message: string,
): FastifyReply {
  reply.header("content-type", "text/html; charset=utf-8");
  reply.header("cache-control", "no-store, max-age=0");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  reply.header("x-frame-options", "DENY");
  return reply.code(statusCode).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:17px/1.5 system-ui,sans-serif;margin:0;background:#f6f5f2;color:#191918}
main{max-width:38rem;margin:12vh auto;padding:2rem;background:white;border:1px solid #dedbd4;border-radius:1rem}
h1{font-size:1.5rem;margin:0 0 .75rem}p{margin:0;color:#4a4945}
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`);
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
