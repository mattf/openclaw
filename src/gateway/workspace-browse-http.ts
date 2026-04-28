import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import busboy from "busboy";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import { authorizeGatewayHttpRequestOrReply, getBearerToken } from "./http-utils.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";

export const WORKSPACE_BROWSE_PREFIX = "/workspace";
const WORKSPACE_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export type WorkspaceBrowseOpts = {
  basePath: string;
  workspaceDir: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
};

export async function handleWorkspaceBrowseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkspaceBrowseOpts,
): Promise<boolean> {
  if (!req.url) {
    return false;
  }

  const normalizedBase = normalizeControlUiBasePath(opts.basePath);
  const browsePrefix = `${normalizedBase}${WORKSPACE_BROWSE_PREFIX}`;

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // Route match: must start with {basePath}/workspace or equal it
  if (pathname !== browsePrefix && !pathname.startsWith(`${browsePrefix}/`)) {
    return false;
  }

  // Method check
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD, POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // A plain HTML form POST cannot set custom headers, so the browser won't
  // send an Authorization: Bearer header. To support form-based uploads we
  // accept a ?token= query parameter and inject it as a Bearer header before
  // the auth check runs. This is safe: the token is only ever embedded in
  // the page by the server after a successful GET (auth already passed then),
  // and the connection is HTTPS in production.
  const queryToken = url.searchParams.get("token");
  if (queryToken && !req.headers["authorization"]) {
    req.headers["authorization"] = `Bearer ${queryToken}`;
  }

  // Browsers send `Origin: null` (opaque origin) on form POST navigations when
  // the page's Referrer-Policy is `no-referrer` (set by setDefaultSecurityHeaders).
  // `checkBrowserOrigin` treats the literal string "null" as an invalid origin
  // and would block the request. Strip it so it is treated as absent — which
  // passes through in trusted-proxy mode (origin check only fires for non-empty
  // origins) and is safe because the proxy has already verified the user identity
  // via X-Forwarded-User before the request reaches openclaw.
  if (req.headers["origin"] === "null") {
    delete req.headers["origin"];
  }

  // Auth
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.resolvedAuth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true; // auth wrote 401
  }

  // Redirect bare /workspace → /workspace/
  if (pathname === browsePrefix) {
    res.statusCode = 301;
    res.setHeader("Location", `${browsePrefix}/`);
    res.end();
    return true;
  }

  // Extract the subpath within the workspace (URL-encoded)
  const rawSubPath = pathname.slice(`${browsePrefix}/`.length);

  // Decode — catch malformed percent-encoding
  let decodedSubPath: string;
  try {
    decodedSubPath = rawSubPath ? decodeURIComponent(rawSubPath) : "";
  } catch {
    respondPlainText(res, 400, "Bad Request");
    return true;
  }

  // Resolve the workspace root to a real path first
  let realWorkspaceDir: string;
  try {
    realWorkspaceDir = fs.realpathSync(opts.workspaceDir);
  } catch {
    respondPlainText(res, 503, "Workspace directory not available");
    return true;
  }

  // Compute the lexically resolved absolute path
  const absPath = path.resolve(realWorkspaceDir, decodedSubPath);

  // Lexical boundary check (guards against `../` bypasses before any I/O)
  if (absPath !== realWorkspaceDir && !absPath.startsWith(realWorkspaceDir + path.sep)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  // Resolve symlinks in the target — catches symlink escapes
  let realAbsPath: string;
  try {
    realAbsPath = fs.realpathSync(absPath);
  } catch (err: unknown) {
    const code = isNodeError(err) ? err.code : "";
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      respondNotFound(res);
      return true;
    }
    respondPlainText(res, 500, "Internal Server Error");
    return true;
  }

  // Post-symlink boundary check
  if (
    realAbsPath !== realWorkspaceDir &&
    !realAbsPath.startsWith(realWorkspaceDir + path.sep)
  ) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realAbsPath);
  } catch {
    respondNotFound(res);
    return true;
  }

  if (stat.isDirectory()) {
    // Ensure URL ends with "/" so relative links resolve correctly
    if (!pathname.endsWith("/")) {
      res.statusCode = 301;
      res.setHeader("Location", `${pathname}/`);
      res.end();
      return true;
    }
    if (method === "POST") {
      return handleFileUpload(req, res, realAbsPath, decodedSubPath, browsePrefix, realWorkspaceDir);
    }
    const bearerToken = getBearerToken(req);
    return serveDirectoryListing(req, res, realAbsPath, decodedSubPath, browsePrefix, bearerToken);
  }

  if (stat.isFile()) {
    if (method === "POST") {
      respondPlainText(res, 400, "Bad Request: cannot upload to a file path");
      return true;
    }
    return serveWorkspaceFile(req, res, realAbsPath, realWorkspaceDir);
  }

  respondNotFound(res);
  return true;
}

function serveWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  realAbsPath: string,
  realWorkspaceDir: string,
): boolean {
  const opened = openBoundaryFileSync({
    absolutePath: realAbsPath,
    rootPath: realWorkspaceDir,
    rootRealPath: realWorkspaceDir,
    boundaryLabel: "workspace",
    maxBytes: WORKSPACE_MAX_FILE_BYTES,
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });

  if (!opened.ok) {
    if (opened.reason === "validation") {
      res.statusCode = 413;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("File too large");
    } else {
      respondNotFound(res);
    }
    return true;
  }

  try {
    const contentType = contentTypeForPath(realAbsPath);

    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if ((req.method ?? "GET").toUpperCase() === "HEAD") {
      res.end();
      return true;
    }

    const body = fs.readFileSync(opened.fd);
    res.setHeader("Content-Length", body.length);
    res.end(body);
    return true;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function serveDirectoryListing(
  req: IncomingMessage,
  res: ServerResponse,
  realAbsDir: string,
  decodedSubPath: string,
  browsePrefix: string,
  bearerToken?: string,
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realAbsDir, { withFileTypes: true });
  } catch {
    respondPlainText(res, 500, "Internal Server Error");
    return true;
  }

  const isRoot = decodedSubPath === "";
  const title = isRoot ? "Workspace" : `Workspace: /${decodedSubPath}`;

  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const fileNames = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  type FileEntry = { name: string; size: number; mtime: Date };

  const fileEntries: FileEntry[] = fileNames.map((name) => {
    try {
      const st = fs.statSync(path.join(realAbsDir, name));
      return { name, size: st.size, mtime: st.mtime };
    } catch {
      return { name, size: -1, mtime: new Date(0) };
    }
  });

  // Breadcrumb: build from subpath segments
  const parts = decodedSubPath ? decodedSubPath.split("/").filter(Boolean) : [];
  const breadcrumbLinks = [
    `<a href="${h(`${browsePrefix}/`)}">workspace</a>`,
  ];
  const accParts: string[] = [];
  for (const part of parts) {
    accParts.push(part);
    const href = `${browsePrefix}/${accParts.map(encodeURIComponent).join("/")}/`;
    breadcrumbLinks.push(`<a href="${h(href)}">${h(part)}</a>`);
  }

  const parentRow = isRoot
    ? ""
    : `<tr><td class="col-name"><a href="../">..</a></td><td class="col-size">—</td><td class="col-mtime">—</td></tr>`;

  const dirRows = dirNames
    .map(
      (name) =>
        `<tr><td class="col-name"><a href="${h(encodeURIComponent(name) + "/")}">${h(name)}/</a></td><td class="col-size">—</td><td class="col-mtime">—</td></tr>`,
    )
    .join("\n");

  const fileRows = fileEntries
    .map(
      (entry) =>
        `<tr><td class="col-name"><a href="${h(encodeURIComponent(entry.name))}">${h(entry.name)}</a></td><td class="col-size">${h(formatFileSize(entry.size))}</td><td class="col-mtime">${h(formatDate(entry.mtime))}</td></tr>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0d1117;
  color: #c9d1d9;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
header {
  padding: 16px 24px 12px;
  border-bottom: 1px solid #21262d;
}
h1 {
  font-size: 16px;
  font-weight: 600;
  color: #f0f6fc;
  margin-bottom: 6px;
}
nav.breadcrumb {
  font-size: 13px;
  color: #8b949e;
}
nav.breadcrumb a {
  color: #58a6ff;
  text-decoration: none;
}
nav.breadcrumb a:hover { text-decoration: underline; }
nav.breadcrumb span { color: #484f58; padding: 0 4px; }
table {
  width: 100%;
  border-collapse: collapse;
}
thead th {
  text-align: left;
  padding: 10px 16px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8b949e;
  border-bottom: 1px solid #21262d;
  background: #0d1117;
  position: sticky;
  top: 0;
}
tbody tr { border-bottom: 1px solid #161b22; }
tbody tr:hover { background: #161b22; }
td { padding: 8px 16px; }
.col-name { width: 60%; }
.col-size { width: 15%; color: #8b949e; text-align: right; }
.col-mtime { width: 25%; color: #8b949e; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
@media (max-width: 600px) {
  .col-size, .col-mtime { display: none; }
  .col-name { width: 100%; }
}
.upload-form {
  padding: 16px 24px;
  border-top: 1px solid #21262d;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.upload-form label { font-size: 13px; color: #8b949e; }
.upload-form input[type="file"] { font-size: 13px; color: #c9d1d9; }
.upload-form button {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 13px;
  padding: 5px 16px;
}
.upload-form button:hover { background: #30363d; }
</style>
</head>
<body>
<header>
<h1>Files</h1>
<nav class="breadcrumb" aria-label="Path">${breadcrumbLinks.join("<span>/</span>")}</nav>
</header>
<table>
<thead><tr><th class="col-name">Name</th><th class="col-size">Size</th><th class="col-mtime">Modified</th></tr></thead>
<tbody>
${parentRow}
${dirRows}
${fileRows}
</tbody>
</table>
<form method="POST" enctype="multipart/form-data" class="upload-form">
  <label for="upload-input">Upload file:</label>
  <input id="upload-input" type="file" name="file">
  <button type="submit">Upload</button>
</form>
</body>
</html>`;

  const uploadAction = bearerToken ? `?token=${encodeURIComponent(bearerToken)}` : "";
  const htmlWithAction = html.replace(
    'method="POST" enctype="multipart/form-data"',
    `method="POST" enctype="multipart/form-data"${uploadAction ? ` action="${h(uploadAction)}"` : ""}`,
  );

  const body = Buffer.from(htmlWithAction, "utf-8");

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  // Block scripts; allow inline styles (no injected code possible, only layout)
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");

  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    res.end();
    return true;
  }

  res.setHeader("Content-Length", body.length);
  res.end(body);
  return true;
}

async function handleFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
  realAbsDir: string,
  decodedSubPath: string,
  browsePrefix: string,
  realWorkspaceDir: string,
): Promise<boolean> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    respondPlainText(res, 400, "Bad Request: expected multipart/form-data");
    return true;
  }

  type UploadResult =
    | { ok: true; destPath: string; tempPath: string }
    | { ok: false; status: number; message: string };

  const result = await new Promise<UploadResult>((resolve) => {
    let settled = false;
    let tempPath: string | null = null;
    let destPath: string | null = null;
    let fileReceived = false;
    let fileWritePromise: Promise<void> = Promise.resolve();
    let fileSizeExceeded = false;

    const settle = (r: UploadResult) => {
      if (settled) return;
      settled = true;
      if (!r.ok && tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      resolve(r);
    };

    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: WORKSPACE_MAX_FILE_BYTES } });
    } catch {
      settle({ ok: false, status: 400, message: "Bad Request: malformed multipart headers" });
      return;
    }

    bb.on("file", (_fieldname, file, info) => {
      fileReceived = true;
      const sanitized = sanitizeUploadFilename(info.filename ?? "");
      if (!sanitized) {
        file.resume();
        settle({ ok: false, status: 400, message: "Bad Request: invalid filename" });
        return;
      }

      const dest = path.join(realAbsDir, sanitized);
      if (!dest.startsWith(realWorkspaceDir + path.sep)) {
        file.resume();
        settle({ ok: false, status: 403, message: "Forbidden" });
        return;
      }
      destPath = dest;

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      tempPath = path.join(realAbsDir, `.${sanitized}.tmp-${suffix}`);
      const ws = fs.createWriteStream(tempPath);

      file.on("limit", () => {
        fileSizeExceeded = true;
      });

      fileWritePromise = new Promise<void>((writeResolve, writeReject) => {
        ws.on("finish", writeResolve);
        ws.on("error", writeReject);
      });

      file.pipe(ws);
    });

    bb.on("finish", async () => {
      if (!fileReceived) {
        settle({ ok: false, status: 400, message: "Bad Request: no file field" });
        return;
      }
      if (settled) return;

      try {
        await fileWritePromise;
      } catch {
        settle({ ok: false, status: 500, message: "Internal Server Error" });
        return;
      }

      if (fileSizeExceeded) {
        if (tempPath) {
          try {
            fs.unlinkSync(tempPath);
          } catch {}
          tempPath = null;
        }
        settle({ ok: false, status: 413, message: "File too large" });
        return;
      }

      if (!destPath || !tempPath) {
        settle({ ok: false, status: 400, message: "Bad Request: no file field" });
        return;
      }

      settle({ ok: true, destPath, tempPath });
    });

    bb.on("error", () => {
      settle({ ok: false, status: 400, message: "Bad Request: malformed multipart data" });
    });

    req.pipe(bb);
  });

  if (!result.ok) {
    respondPlainText(res, result.status, result.message);
    return true;
  }

  try {
    fs.renameSync(result.tempPath, result.destPath);
  } catch {
    try {
      fs.unlinkSync(result.tempPath);
    } catch {}
    respondPlainText(res, 500, "Internal Server Error");
    return true;
  }

  const parts = decodedSubPath ? decodedSubPath.split("/").filter(Boolean) : [];
  const redirectTo =
    parts.length > 0
      ? `${browsePrefix}/${parts.map(encodeURIComponent).join("/")}/`
      : `${browsePrefix}/`;
  res.statusCode = 303;
  res.setHeader("Location", redirectTo);
  res.end();
  return true;
}

/** Return the safe base name for an uploaded filename, or null if invalid. */
function sanitizeUploadFilename(raw: string): string | null {
  // Strip null bytes and normalise Windows-style backslashes to forward slashes
  const cleaned = raw.replace(/\0/g, "").replace(/\\/g, "/");
  // Use only the base name component — strips any path traversal (e.g. "../evil")
  const base = path.basename(cleaned);
  if (!base || base === "." || base === "..") return null;
  return base;
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
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
    case ".md":
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".ini":
    case ".env":
    case ".sh":
    case ".bash":
    case ".zsh":
      return "text/plain; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".wasm":
      return "application/wasm";
    case ".mp4":
      return "video/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

/** HTML-escape a string for safe embedding in HTML attributes and text. */
function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFileSize(bytes: number): string {
  if (bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(d: Date): string {
  if (d.getTime() === 0) return "—";
  return d.toLocaleString("en-US", { timeZoneName: "short" });
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}
