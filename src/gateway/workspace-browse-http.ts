import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { matchRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import { authorizeGatewayHttpRequestOrReply, getBearerToken } from "./http-auth-utils.js";
import { sendJson, sendText } from "./http-common.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

function sendNotFound(res: ServerResponse): void {
  sendText(res, 404, "Not Found");
}

function sendServerError(res: ServerResponse, message?: string): void {
  sendJson(res, 500, {
    error: { message: message ?? "Internal Server Error", type: "internal_server_error" },
  });
}

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

function h(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
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
    default:
      return "application/octet-stream";
  }
}

export function sanitizeUploadFilename(raw: string): string | null {
  const cleaned = raw.replace(/\x00/g, "").replace(/\\/g, "/");
  const base = path.basename(cleaned);
  if (!base || base === "." || base === "..") {
    return null;
  }
  return base;
}

export async function extractFileBody(
  req: IncomingMessage,
  boundary: string,
): Promise<{ data: Buffer; filename: string } | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const body = Buffer.concat(chunks);

  const boundaryBuf = Buffer.from(`--${boundary}`);
  let pos = 0;

  while (pos < body.length) {
    const boundaryIdx = body.indexOf(boundaryBuf, pos);
    if (boundaryIdx === -1) break;

    const afterBoundary = boundaryIdx + boundaryBuf.length;
    // Closing boundary: --boundary--
    if (body[afterBoundary] === 0x2d && body[afterBoundary + 1] === 0x2d) break;

    // Skip CRLF after boundary marker
    let headerStart = afterBoundary;
    if (body[headerStart] === 0x0d && body[headerStart + 1] === 0x0a) {
      headerStart += 2;
    }

    // Find end of part headers (blank line = \r\n\r\n)
    const CRLF2 = Buffer.from("\r\n\r\n");
    const headerEnd = body.indexOf(CRLF2, headerStart);
    if (headerEnd === -1) break;

    const headerSection = body.slice(headerStart, headerEnd).toString("utf-8");
    const bodyStart = headerEnd + 4;

    // Find next boundary to delimit body
    const nextBoundaryMarker = Buffer.from(`\r\n--${boundary}`);
    const nextBoundaryIdx = body.indexOf(nextBoundaryMarker, bodyStart);
    const bodyEnd = nextBoundaryIdx !== -1 ? nextBoundaryIdx : body.length;
    const partBody = body.slice(bodyStart, bodyEnd);

    // Must have a Content-Disposition header
    const dispositionMatch = headerSection.match(/content-disposition:[^\r\n]*/i);
    if (!dispositionMatch) {
      pos = afterBoundary;
      continue;
    }
    const disposition = dispositionMatch[0];

    // Only process the "file" field
    if (!/name="file"/i.test(disposition)) {
      pos = afterBoundary;
      continue;
    }

    // Extract filename
    let filename = "";
    const filenameQuoted = disposition.match(/filename="([^"]*)"/i);
    if (filenameQuoted) {
      filename = filenameQuoted[1];
    } else {
      const filenameStar = disposition.match(/filename\*=UTF-8''([^\s;]*)/i);
      if (filenameStar) {
        filename = decodeURIComponent(filenameStar[1]);
      } else {
        const filenameBare = disposition.match(/filename=([^\s;]*)/i);
        if (filenameBare) {
          filename = filenameBare[1];
        }
      }
    }

    return { data: partBody, filename };
  }

  return null;
}

async function handleFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
  realAbsDir: string,
  decodedSubPath: string,
  browsePrefix: string,
  realWorkspaceDir: string,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;,\s]+))/);
  if (!boundaryMatch) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Missing multipart boundary");
    return;
  }
  const boundary = (boundaryMatch[1] ?? boundaryMatch[2])!;

  const result = await extractFileBody(req, boundary);
  if (!result) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("No file part found in upload");
    return;
  }

  const sanitized = sanitizeUploadFilename(result.filename);
  if (!sanitized) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Invalid filename");
    return;
  }

  const savePath = path.resolve(realAbsDir, sanitized);
  if (!savePath.startsWith(realWorkspaceDir + path.sep)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return;
  }

  try {
    await fs.promises.writeFile(savePath, result.data);
    const location = browsePrefix + decodedSubPath;
    res.statusCode = 303;
    res.setHeader("Location", location);
    res.end();
  } catch (err) {
    sendServerError(res, String(err));
  }
}

function serveDirectoryListing(
  res: ServerResponse,
  realAbsPath: string,
  decodedSubPath: string,
  browsePrefix: string,
  isHead: boolean,
  bearerToken?: string,
): void {
  const entries = fs.readdirSync(realAbsPath, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));

  const formatSize = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (d: Date): string =>
    d.toISOString().replace("T", " ").slice(0, 19);

  const isRoot = decodedSubPath === "/";
  const segments = decodedSubPath.split("/").filter(Boolean);

  // Build breadcrumb
  let breadcrumb = `<a href="${h(browsePrefix + "/")}">/</a>`;
  for (let i = 0; i < segments.length; i++) {
    const segUrl =
      browsePrefix + "/" + segments.slice(0, i + 1).map(encodeURIComponent).join("/") + "/";
    breadcrumb += ` <a href="${h(segUrl)}">${h(segments[i])}/</a>`;
  }

  let tableRows = "";

  if (!isRoot) {
    const parentSegments = segments.slice(0, -1);
    const parentUrl =
      parentSegments.length > 0
        ? browsePrefix + "/" + parentSegments.map(encodeURIComponent).join("/") + "/"
        : browsePrefix + "/";
    tableRows += `<tr><td><a href="${h(parentUrl)}">..</a></td><td>—</td><td>—</td></tr>\n`;
  }

  for (const d of dirs) {
    const dirUrl =
      browsePrefix + "/" + [...segments, d.name].map(encodeURIComponent).join("/") + "/";
    tableRows += `<tr><td><a href="${h(dirUrl)}">${h(d.name)}/</a></td><td>—</td><td>—</td></tr>\n`;
  }

  for (const f of files) {
    const fileUrl =
      browsePrefix + "/" + [...segments, f.name].map(encodeURIComponent).join("/");
    let size = "—";
    let mtime = "—";
    try {
      const fstat = fs.statSync(path.join(realAbsPath, f.name));
      size = formatSize(fstat.size);
      mtime = formatDate(fstat.mtime);
    } catch {
      // ignore individual stat errors
    }
    tableRows += `<tr><td><a href="${h(fileUrl)}">${h(f.name)}</a></td><td>${size}</td><td>${mtime}</td></tr>\n`;
  }

  const uploadTokenParam = bearerToken
    ? `data-token="${h(bearerToken)}"`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Workspace: ${h(decodedSubPath)}</title>
<style>
body { background: #0d1117; color: #c9d1d9; font-family: monospace; padding: 1rem 2rem; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th { text-align: left; border-bottom: 1px solid #30363d; padding: 0.3rem 1rem 0.3rem 0; color: #8b949e; }
td { padding: 0.25rem 1rem 0.25rem 0; }
nav { margin-bottom: 1rem; font-size: 0.9rem; }
.upload-form { margin-top: 2rem; padding: 1rem; border: 1px solid #30363d; border-radius: 6px; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.upload-form label { color: #8b949e; }
.upload-form button { background: #238636; color: #fff; border: none; border-radius: 4px; padding: 0.3rem 0.8rem; cursor: pointer; }
.upload-form button:hover { background: #2ea043; }
.upload-form button:disabled { background: #484f58; cursor: not-allowed; }
.upload-form .status { color: #8b949e; font-size: 0.9rem; }
.upload-form .status.error { color: #f85149; }
.upload-form .status.success { color: #3fb950; }
</style>
</head>
<body>
<nav>${breadcrumb}</nav>
<table>
<thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
<tbody>
${tableRows}</tbody>
</table>
<form class="upload-form" ${uploadTokenParam}>
  <label for="upload-input">Upload file:</label>
  <input id="upload-input" type="file" name="file">
  <button type="submit">Upload</button>
  <span class="status"></span>
  <script>
(function() {
  var form = document.currentScript.parentElement;
  var status = form.querySelector('.status');
  var btn = form.querySelector('button');
  var input = document.getElementById('upload-input');
  form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (!input.files.length) return;
    var fd = new FormData();
    fd.append('file', input.files[0]);
    var tok = form.dataset.token || '';
    var url = location.pathname + (tok ? '?token=' + encodeURIComponent(tok) : '');
    status.textContent = 'Uploading...';
    status.className = 'status';
    btn.disabled = true;
    fetch(url, { method: 'POST', body: fd })
      .then(function(r) {
        if (r.redirected) {
          location.href = r.url;
        } else if (r.ok) {
          location.reload();
        } else {
          throw new Error('HTTP ' + r.status);
        }
      })
      .catch(function(er) {
        status.textContent = 'Upload failed: ' + er.message;
        status.className = 'status error';
        btn.disabled = false;
      });
  });
})();
  </script>
</form>
</body>
</html>`;

  const body = Buffer.from(html, "utf-8");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Length", body.length);
  if (isHead) {
    res.end();
    return;
  }
  res.end(body);
}

export async function handleWorkspaceBrowseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkspaceBrowseOpts,
): Promise<boolean> {
  const browsePrefix = normalizeControlUiBasePath(opts.basePath) + WORKSPACE_BROWSE_PREFIX;

  const rawUrl = req.url ?? "/";
  const requestUrl = new URL(rawUrl, "http://localhost");
  const requestPath = requestUrl.pathname;

  // Step 1: Route match
  if (requestPath !== browsePrefix && !requestPath.startsWith(browsePrefix + "/")) {
    return false;
  }

  // Inject bearer token from query params for form POST (HTML form can't send Authorization header)
  const queryToken = requestUrl.searchParams.get("token");
  if (queryToken && !req.headers["authorization"]) {
    req.headers["authorization"] = `Bearer ${queryToken}`;
  }

  // Step 2: Method check
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD, POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // Step 3: Auth
  const authed = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.resolvedAuth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authed) return true;

  const bearerToken = getBearerToken(req);

  // Step 4: 301-redirect bare prefix → prefix/
  if (requestPath === browsePrefix) {
    res.statusCode = 301;
    res.setHeader("Location", browsePrefix + "/");
    res.end();
    return true;
  }

  // Step 5: Decode subpath
  let decodedSubPath: string;
  try {
    decodedSubPath = decodeURIComponent(requestPath.slice(browsePrefix.length));
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: malformed URL encoding");
    return true;
  }

  // Step 6: Resolve workspace dir (503 if missing)
  let realWorkspaceDir: string;
  try {
    realWorkspaceDir = fs.realpathSync(opts.workspaceDir);
  } catch {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Workspace directory not available");
    return true;
  }

  // Step 7: Lexical boundary check (pre-symlink)
  const absPath = path.resolve(realWorkspaceDir, decodedSubPath.slice(1));
  if (absPath !== realWorkspaceDir && !absPath.startsWith(realWorkspaceDir + path.sep)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  // Step 8: Resolve real path (404 for ENOENT/ENOTDIR/ELOOP, 500 for others)
  let realAbsPath: string;
  try {
    realAbsPath = fs.realpathSync(absPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      sendNotFound(res);
    } else {
      sendServerError(res);
    }
    return true;
  }

  // Step 9: Post-symlink boundary check
  if (realAbsPath !== realWorkspaceDir && !realAbsPath.startsWith(realWorkspaceDir + path.sep)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  // Step 10: Stat the resolved path
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realAbsPath);
  } catch {
    sendNotFound(res);
    return true;
  }

  const isHead = method === "HEAD";
  const isPost = method === "POST";

  if (stat.isDirectory()) {
    // Redirect to add trailing slash if missing
    if (!requestPath.endsWith("/")) {
      res.statusCode = 301;
      res.setHeader("Location", requestPath + "/");
      res.end();
      return true;
    }
    if (isPost) {
      await handleFileUpload(req, res, realAbsPath, decodedSubPath, browsePrefix, realWorkspaceDir);
      return true;
    }
    serveDirectoryListing(res, realAbsPath, decodedSubPath, browsePrefix, isHead, bearerToken);
    return true;
  }

  if (stat.isFile()) {
    if (isPost) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Cannot upload to a file path");
      return true;
    }

    const opened = openRootFileSync({
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
        res.end("Content Too Large");
      } else {
        return matchRootFileOpenFailure(opened, {
          io: () => {
            sendNotFound(res);
            return true;
          },
          fallback: () => {
            sendNotFound(res);
            return true;
          },
        });
      }
      return true;
    }

    let fileData: Buffer;
    try {
      try {
        fileData = fs.readFileSync(opened.fd);
      } finally {
        fs.closeSync(opened.fd);
      }
    } catch {
      sendServerError(res);
      return true;
    }

    const ct = contentTypeForPath(realAbsPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", fileData.length);
    if (isHead) {
      res.end();
    } else {
      res.end(fileData);
    }
    return true;
  }

  sendNotFound(res);
  return true;
}
