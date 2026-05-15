import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
// @ts-expect-error busboy has no type declarations
import Busboy from "busboy";
import { z } from "zod";
import {
  sendJson,
  sendMethodNotAllowed,
  sendNotFound,
  sendServerError,
  sendUnauthorized,
} from "./http-common.js";

const WORKSPACE_BROWSE_PREFIX = "/workspace";

const FILE_ENTRY = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  mime: z.string().nullable().default(null),
  dir: z.boolean(),
  modified: z.number().nullable().default(null),
});

const LIST_DIR_RESPONSE = z.object({
  ok: z.literal(true),
  path: z.string(),
  entries: z.array(FILE_ENTRY),
});

const UPLOAD_RESPONSE = z.object({
  ok: z.literal(true),
  path: z.string(),
});

type FileEntry = z.infer<typeof FILE_ENTRY>;
type ListDirResponse = z.infer<typeof LIST_DIR_RESPONSE>;
type UploadResponse = z.infer<typeof UPLOAD_RESPONSE>;

type WorkspaceBrowseHttpRequestOpts = {
  auth: { mode: string };
  trustedProxies: readonly string[];
  allowRealIpFallback: boolean;
  rateLimiter?: unknown;
  workspaceDir?: string;
};

function getSafeWorkspaceRoot(workspaceDir: string): string {
  let root = workspaceDir.replace(/\/+$/, "");
  if (!path.isAbsolute(root)) {
    root = `/${root}`;
  }
  return root;
}

function listDir(workspaceRoot: string, uriPath: string): ListDirResponse {
  let resolved = path.normalize(uriPath).replace(/^\//, "");
  if (resolved) {
    resolved = resolved.replace(/^\//, "");
  }
  let full = path.resolve(workspaceRoot, resolved);
  if (!full.startsWith(workspaceRoot + path.sep) && full !== workspaceRoot) {
    full = workspaceRoot;
  }
  if (!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: true, path: uriPath || "/", entries: [] };
  }
  const entries: FileEntry[] = [];
  for (const dirent of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(full, dirent.name);
    const stat = fs.statSync(child, { throwIfNoEntry: false });
    if (!stat) continue;
    const modified = stat.mtimeMs ?? null;
    const size = dirent.isDirectory() ? 0 : stat.size;
    const mime = dirent.isDirectory() ? null : mimeTypeFromPath(child);
    entries.push({
      name: dirent.name,
      path: `${uriPath}${uriPath.endsWith("/") ? "" : "/"}${encodeURIComponent(dirent.name)}`,
      size,
      mime,
      dir: dirent.isDirectory(),
      modified,
    });
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, path: uriPath || "/", entries };
}

function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".txt":
    case ".md":
    case ".log":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    case ".toml":
      return "text/toml";
    case ".xml":
      return "text/xml";
    default:
      return "application/octet-stream";
  }
}

function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderHtml(
  pathName: string,
  entries: FileEntry[],
  workspaceRoot: string,
  basePath: string,
  error?: string,
): string {
  const escape = htmlEscape;
  const rows = entries
    .map(
      (e) => `
    <tr>
      <td><a href="${escape(e.path)}">${escape(e.name)}${e.dir ? "/" : ""}</a></td>
      <td>${escape(formatSize(e.size))}</td>
      <td>${escape(formatTime(e.modified))}</td>
      <td>${e.dir ? "Directory" : e.mime ? escape(e.mime) : "File"}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Files — OpenClaw</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f7f8fa;color:#1e1e1e;padding:24px}
header h1{font-size:1.25rem;font-weight:600;margin-bottom:24px}
a{color:#0969da;text-decoration:none}
a:hover{text-decoration:underline}
.breadcrumb{font-size:.875rem;margin-bottom:16px;color:#57606a}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #e1e4e8;font-size:.875rem}
th{background:#f6f8fa;font-weight:600}
tr:hover{background:#f6f8fa}
.empty{padding:40px;text-align:center;color:#57606a}
</style></head>
<body>
<header><h1>📁 Files</h1></header>
<div class="breadcrumb">${escape(pathName)}</div>
${error ? `<div style="color:#cf222e;margin-bottom:16px">${escape(error)}</div>` : ""}
<table><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Type</th></tr></thead><tbody>
${entries.length ? rows : '<tr><td colspan="4" class="empty">No files found.</td></tr>'}
</tbody></table>
</body></html>`;
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceRoot: string,
  fullPath: string,
): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }
  let savePath: string | null = null;
  let saved = false;
  const busboyObj: unknown = new Busboy({ headers: req.headers });
  const busboyTyped = busboyObj as {
    on(event: string, cb: (...args: unknown[]) => void): void;
    pipe: (source: unknown) => void;
  };
  const _reqRaw = req as unknown as { pipe: (sink: unknown) => void };
  busboyTyped.on("file", (fieldname: unknown, fileObj: unknown, infoObj: unknown) => {
    if (fieldname !== "file") return;
    const info = infoObj as { filename: string };
    const file = fileObj as { pipe: (dest: unknown) => void; resume: () => void };
    if (savePath) {
      file.resume();
      return;
    }
    savePath = `${workspaceRoot}${fullPath.replace(/^\//, "")}/${encodeURIComponent(info.filename)}`;
    const ws = fs.createWriteStream(savePath);
    file.pipe(ws);
    ws.on("finish", () => {
      saved = true;
    });
    ws.on("error", () => {
      saved = false;
      sendServerError(res, "Upload failed");
    });
  });
  busboyTyped.on("finish", () => {
    if (!savePath) {
      sendNotFound(res);
      return;
    }
    if (!saved) {
      sendServerError(res, "Upload failed");
      return;
    }
    sendJson(res, 200, { ok: true, path: fullPath } as UploadResponse);
  });
  _reqRaw.pipe(busboyObj);
  return true;
}

export async function handleWorkspaceBrowseHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkspaceBrowseHttpRequestOpts,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith(WORKSPACE_BROWSE_PREFIX)) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  if (!opts.workspaceDir) {
    sendNotFound(res);
    return true;
  }

  const workspaceRoot = getSafeWorkspaceRoot(opts.workspaceDir);
  const relativePath = url.pathname.slice(WORKSPACE_BROWSE_PREFIX.length) || "/";

  if (req.method === "POST") {
    return handleUpload(req, res, workspaceRoot, relativePath);
  }

  const result = listDir(workspaceRoot, relativePath);
  const basePath = WORKSPACE_BROWSE_PREFIX;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(renderHtml(url.pathname, result.entries, workspaceRoot, basePath));
  return true;
}
