import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveControlUiRootSync } from "../infra/control-ui-assets.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: OpenClawConfig;
  agentId?: string;
  root?: ControlUiRootState;
};

export type ControlUiRootState =
  | { kind: "resolved"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function applyControlUiSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForExt(path.extname(resolved.filePath).toLowerCase()));
    res.setHeader("Cache-Control", "no-cache");
    res.end();
    return true;
  }

  serveFile(res, resolved.filePath);
  return true;
}

function respondNotFound(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function serveFile(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(filePath));
}

interface ControlUiInjectionOpts {
  basePath: string;
  assistantName?: string;
  assistantAvatar?: string;
}

function injectControlUiConfig(html: string, opts: ControlUiInjectionOpts): string {
  const { basePath, assistantName, assistantAvatar } = opts;
  const script =
    `<script>` +
    `window.__OPENCLAW_CONTROL_UI_BASE_PATH__=${JSON.stringify(basePath)};` +
    `window.__OPENCLAW_ASSISTANT_NAME__=${JSON.stringify(
      assistantName ?? DEFAULT_ASSISTANT_IDENTITY.name,
    )};` +
    `window.__OPENCLAW_ASSISTANT_AVATAR__=${JSON.stringify(
      assistantAvatar ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
    )};` +
    `</script>`;

  // Floating voice-chat button — only visible on chat routes
  const voiceBtn =
    `<style>` +
    `#oc-voice-fab{position:fixed;bottom:24px;right:24px;z-index:9999;width:48px;height:48px;border-radius:50%;border:none;` +
    `background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);` +
    `display:none;align-items:center;justify-content:center;transition:transform .15s,box-shadow .15s;font-size:20px;}` +
    `#oc-voice-fab:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(99,102,241,0.5);}` +
    `</style>` +
    `<a id="oc-voice-fab" href="/__openclaw__/voice/" title="Voice Chat">` +
    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>` +
    `<path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>` +
    `</svg></a>` +
    `<script>` +
    `(function(){var b=document.getElementById("oc-voice-fab");` +
    `function u(){b.style.display=location.pathname.match(/\\/chat/)||location.pathname==="/"?"flex":"none"}` +
    `u();window.addEventListener("popstate",u);` +
    `new MutationObserver(u).observe(document.body,{childList:true,subtree:true});` +
    `})();` +
    `</script>`;

  // Check if already injected
  if (html.includes("__OPENCLAW_ASSISTANT_NAME__")) {
    return html;
  }

  // Inject config script into <head>
  let result = html;
  const headClose = result.indexOf("</head>");
  if (headClose !== -1) {
    result = `${result.slice(0, headClose)}${script}${result.slice(headClose)}`;
  } else {
    result = `${script}${result}`;
  }

  // Inject voice button before </body>
  const bodyClose = result.lastIndexOf("</body>");
  if (bodyClose !== -1) {
    result = `${result.slice(0, bodyClose)}${voiceBtn}${result.slice(bodyClose)}`;
  } else {
    result += voiceBtn;
  }
  return result;
}

interface ServeIndexHtmlOpts {
  basePath: string;
  config?: OpenClawConfig;
  agentId?: string;
}

function serveIndexHtml(res: ServerResponse, indexPath: string, opts: ServeIndexHtmlOpts) {
  const { basePath, config, agentId } = opts;
  const identity = config
    ? resolveAssistantIdentity({ cfg: config, agentId })
    : DEFAULT_ASSISTANT_IDENTITY;
  const resolvedAgentId =
    typeof (identity as { agentId?: string }).agentId === "string"
      ? (identity as { agentId?: string }).agentId
      : agentId;
  const avatarValue =
    resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: resolvedAgentId,
      basePath,
    }) ?? identity.avatar;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const raw = fs.readFileSync(indexPath, "utf8");
  res.end(
    injectControlUiConfig(raw, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue,
    }),
  );
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;

  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      applyControlUiSecurityHeaders(res);
      respondNotFound(res);
      return true;
    }
  }

  if (basePath) {
    if (pathname === basePath) {
      applyControlUiSecurityHeaders(res);
      res.statusCode = 302;
      res.setHeader("Location", `${basePath}/${url.search}`);
      res.end();
      return true;
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      return false;
    }
  }

  applyControlUiSecurityHeaders(res);

  const rootState = opts?.root;
  if (rootState?.kind === "invalid") {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      `Control UI assets not found at ${rootState.path}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
    );
    return true;
  }
  if (rootState?.kind === "missing") {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    );
    return true;
  }

  const root =
    rootState?.kind === "resolved"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    );
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondNotFound(res);
    return true;
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    respondNotFound(res);
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (path.basename(filePath) === "index.html") {
      serveIndexHtml(res, filePath, {
        basePath,
        config: opts?.config,
        agentId: opts?.agentId,
      });
      return true;
    }
    serveFile(res, filePath);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    serveIndexHtml(res, indexPath, {
      basePath,
      config: opts?.config,
      agentId: opts?.agentId,
    });
    return true;
  }

  respondNotFound(res);
  return true;
}
