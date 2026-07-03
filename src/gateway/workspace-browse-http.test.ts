import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import {
  contentTypeForPath,
  extractFileBody,
  handleWorkspaceBrowseRequest,
  sanitizeUploadFilename,
  WORKSPACE_BROWSE_PREFIX,
  type WorkspaceBrowseOpts,
} from "./workspace-browse-http.js";

const NO_AUTH: ResolvedGatewayAuth = { mode: "none" } as ResolvedGatewayAuth;

function makeOpts(workspaceDir: string, basePath = ""): WorkspaceBrowseOpts {
  return {
    basePath,
    workspaceDir,
    resolvedAuth: NO_AUTH,
    trustedProxies: [],
    allowRealIpFallback: false,
  };
}

function makeReq(url: string, method = "GET", extra?: Partial<IncomingMessage>): IncomingMessage {
  return {
    url,
    method,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...extra,
  } as IncomingMessage;
}

function makeUploadReq(
  url: string,
  boundary: string,
  body: Buffer,
): IncomingMessage {
  const stream = Readable.from(body);
  return Object.assign(stream, {
    url,
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

function buildMultipartBody(boundary: string, filename: string, data: Buffer | string): Buffer {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ws-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Route matching ───────────────────────────────────────────────────────────

describe("route matching", () => {
  it("returns false for non-workspace paths", async () => {
    const { res } = makeMockHttpResponse();
    const result = await handleWorkspaceBrowseRequest(makeReq("/other"), res, makeOpts(tmpDir));
    expect(result).toBe(false);
  });

  it("returns false for paths that start with workspace but are not the prefix", async () => {
    const { res } = makeMockHttpResponse();
    const result = await handleWorkspaceBrowseRequest(
      makeReq("/workspacefoo"),
      res,
      makeOpts(tmpDir),
    );
    expect(result).toBe(false);
  });

  it("returns true for bare /workspace (will 301 redirect)", async () => {
    const { res } = makeMockHttpResponse();
    const result = await handleWorkspaceBrowseRequest(makeReq("/workspace"), res, makeOpts(tmpDir));
    expect(result).toBe(true);
  });

  it("returns true for /workspace/ path", async () => {
    const { res } = makeMockHttpResponse();
    const result = await handleWorkspaceBrowseRequest(
      makeReq("/workspace/"),
      res,
      makeOpts(tmpDir),
    );
    expect(result).toBe(true);
  });

  it("matches with a basePath prefix", async () => {
    const { res } = makeMockHttpResponse();
    const result = await handleWorkspaceBrowseRequest(
      makeReq("/base/workspace/"),
      res,
      makeOpts(tmpDir, "/base"),
    );
    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("does not match /base/workspacefoo with basePath /base", async () => {
    const { res } = makeMockHttpResponse();
    const result = await handleWorkspaceBrowseRequest(
      makeReq("/base/workspacefoo"),
      res,
      makeOpts(tmpDir, "/base"),
    );
    expect(result).toBe(false);
  });
});

// ─── Redirects ────────────────────────────────────────────────────────────────

describe("redirects", () => {
  it("301 redirects bare /workspace to /workspace/", async () => {
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace"), res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(301);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/workspace/");
    expect(end).toHaveBeenCalled();
  });

  it("301 redirects directory without trailing slash", async () => {
    await fs.mkdir(path.join(tmpDir, "subdir"));
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(
      makeReq("/workspace/subdir"),
      res,
      makeOpts(tmpDir),
    );
    expect(res.statusCode).toBe(301);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/workspace/subdir/");
  });
});

// ─── Directory listing ────────────────────────────────────────────────────────

describe("directory listing", () => {
  it("returns HTML response for root with file names", async () => {
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "hello");
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/"), res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(200);
    const body = String(end.mock.calls[0]?.[0] ?? "");
    expect(body).toContain("hello.txt");
  });

  it("lists directories before files", async () => {
    await fs.mkdir(path.join(tmpDir, "bdir"));
    await fs.writeFile(path.join(tmpDir, "afile.txt"), "x");
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/"), res, makeOpts(tmpDir));
    const body = String(end.mock.calls[0]?.[0] ?? "");
    const dirIdx = body.indexOf("bdir/");
    const fileIdx = body.indexOf("afile.txt");
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  it("shows parent link only in subdirectories", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"));
    const { res: rootRes, end: rootEnd } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/"), rootRes, makeOpts(tmpDir));
    const rootBody = String(rootEnd.mock.calls[0]?.[0] ?? "");
    expect(rootBody).not.toContain(">..</");

    const { res: subRes, end: subEnd } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/sub/"), subRes, makeOpts(tmpDir));
    const subBody = String(subEnd.mock.calls[0]?.[0] ?? "");
    expect(subBody).toContain(">..</");
  });

  it("HEAD returns 200 with no body for directory", async () => {
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/", "HEAD"), res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(200);
    expect(end).toHaveBeenCalledWith();
  });
});

// ─── File serving ─────────────────────────────────────────────────────────────

describe("file serving", () => {
  it("serves file body with correct content", async () => {
    await fs.writeFile(path.join(tmpDir, "data.txt"), "file content");
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/data.txt"), res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(200);
    const body = end.mock.calls[0]?.[0] as Buffer;
    expect(body.toString()).toBe("file content");
  });

  it("sets correct Content-Type for text file", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.md"), "# doc");
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/readme.md"), res, makeOpts(tmpDir));
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
  });

  it("sets correct Content-Type for HTML file", async () => {
    await fs.writeFile(path.join(tmpDir, "index.html"), "<html/>");
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/index.html"), res, makeOpts(tmpDir));
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
  });

  it("sets correct Content-Type for JSON file", async () => {
    await fs.writeFile(path.join(tmpDir, "data.json"), "{}");
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/data.json"), res, makeOpts(tmpDir));
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
  });

  it("HEAD returns 200 with no body for file", async () => {
    await fs.writeFile(path.join(tmpDir, "note.txt"), "data");
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(
      makeReq("/workspace/note.txt", "HEAD"),
      res,
      makeOpts(tmpDir),
    );
    expect(res.statusCode).toBe(200);
    expect(end).toHaveBeenCalledWith();
  });

  it("returns 404 for missing file", async () => {
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(
      makeReq("/workspace/missing.txt"),
      res,
      makeOpts(tmpDir),
    );
    expect(res.statusCode).toBe(404);
  });

  it("serves file in subdirectory", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"));
    await fs.writeFile(path.join(tmpDir, "sub", "nested.txt"), "nested content");
    const { res, end } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(
      makeReq("/workspace/sub/nested.txt"),
      res,
      makeOpts(tmpDir),
    );
    expect(res.statusCode).toBe(200);
    expect((end.mock.calls[0]?.[0] as Buffer).toString()).toBe("nested content");
  });
});

// ─── Content-Type mapping ─────────────────────────────────────────────────────

describe("contentTypeForPath", () => {
  const cases: Array<[string, string]> = [
    [".html", "text/html; charset=utf-8"],
    [".js", "application/javascript; charset=utf-8"],
    [".mjs", "application/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".ico", "image/x-icon"],
    [".txt", "text/plain; charset=utf-8"],
    [".md", "text/plain; charset=utf-8"],
    [".yaml", "text/plain; charset=utf-8"],
    [".yml", "text/plain; charset=utf-8"],
    [".toml", "text/plain; charset=utf-8"],
    [".pdf", "application/pdf"],
    [".wasm", "application/wasm"],
    [".bin", "application/octet-stream"],
  ];

  it.each(cases)("maps %s → %s", (ext, expected) => {
    expect(contentTypeForPath(`file${ext}`)).toBe(expected);
  });
});

// ─── Path traversal ───────────────────────────────────────────────────────────

describe("path traversal", () => {
  it("rejects ..%2F traversal (403 or 404)", async () => {
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(
      makeReq("/workspace/..%2Fevil"),
      res,
      makeOpts(tmpDir),
    );
    expect([403, 404]).toContain(res.statusCode);
  });

  it("rejects %2E%2E%2F traversal (403 or 404)", async () => {
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(
      makeReq("/workspace/%2E%2E%2Fevil"),
      res,
      makeOpts(tmpDir),
    );
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ─── Method restriction ───────────────────────────────────────────────────────

describe("method restriction", () => {
  it("rejects DELETE with 405", async () => {
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/", "DELETE"), res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(405);
  });

  it("rejects PUT with 405", async () => {
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(makeReq("/workspace/", "PUT"), res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(405);
  });
});

// ─── File upload ──────────────────────────────────────────────────────────────

describe("file upload", () => {
  it("successfully uploads to root and redirects 303", async () => {
    const boundary = "testboundary123";
    const fileData = buildMultipartBody(boundary, "upload.txt", "uploaded content");
    const req = makeUploadReq("/workspace/", boundary, fileData);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(303);
    const saved = await fs.readFile(path.join(tmpDir, "upload.txt"), "utf-8");
    expect(saved).toBe("uploaded content");
  });

  it("uploads to subdirectory with correct Location header", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"));
    const boundary = "subboundary";
    const fileData = buildMultipartBody(boundary, "doc.txt", "sub content");
    const req = makeUploadReq("/workspace/sub/", boundary, fileData);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(303);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/workspace/sub/");
    const saved = await fs.readFile(path.join(tmpDir, "sub", "doc.txt"), "utf-8");
    expect(saved).toBe("sub content");
  });

  it("overwrites existing file with new content", async () => {
    await fs.writeFile(path.join(tmpDir, "existing.txt"), "old content");
    const boundary = "overwriteboundary";
    const fileData = buildMultipartBody(boundary, "existing.txt", "new content");
    const req = makeUploadReq("/workspace/", boundary, fileData);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(303);
    const saved = await fs.readFile(path.join(tmpDir, "existing.txt"), "utf-8");
    expect(saved).toBe("new content");
  });

  it("returns 400 for POST to file path", async () => {
    await fs.writeFile(path.join(tmpDir, "file.txt"), "data");
    const boundary = "fileboundary";
    const fileData = buildMultipartBody(boundary, "file.txt", "data");
    const req = makeUploadReq("/workspace/file.txt", boundary, fileData);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when Content-Type has no boundary (e.g. application/json)", async () => {
    const stream = Readable.from(Buffer.from("{}"));
    const req = Object.assign(stream, {
      url: "/workspace/",
      method: "POST",
      headers: { "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as IncomingMessage;
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when no file field in multipart body", async () => {
    const boundary = "noboundary";
    // Send multipart with a different field name
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nvalue\r\n--${boundary}--\r\n`,
    );
    const req = makeUploadReq("/workspace/", boundary, body);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(400);
  });

  it("sanitizes path traversal in filename (../evil.txt → evil.txt saved safely)", async () => {
    const boundary = "travboundary";
    const fileData = buildMultipartBody(boundary, "../evil.txt", "evil content");
    const req = makeUploadReq("/workspace/", boundary, fileData);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(303);
    // File should be saved as evil.txt inside tmpDir, not outside
    const saved = await fs.readFile(path.join(tmpDir, "evil.txt"), "utf-8");
    expect(saved).toBe("evil content");
    // The parent directory should NOT have an evil.txt
    const parentEvil = path.join(path.dirname(tmpDir), "evil.txt");
    expect(fsSync.existsSync(parentEvil)).toBe(false);
  });

  it("returns 400 when filename is only separators (e.g. ../)", async () => {
    const boundary = "sepboundary";
    const fileData = buildMultipartBody(boundary, "../", "data");
    const req = makeUploadReq("/workspace/", boundary, fileData);
    const { res } = makeMockHttpResponse();
    await handleWorkspaceBrowseRequest(req, res, makeOpts(tmpDir));
    expect(res.statusCode).toBe(400);
  });
});

// ─── sanitizeUploadFilename unit tests ────────────────────────────────────────

describe("sanitizeUploadFilename", () => {
  it("returns basename of a safe name", () => {
    expect(sanitizeUploadFilename("hello.txt")).toBe("hello.txt");
  });

  it("strips path traversal, keeping only basename", () => {
    expect(sanitizeUploadFilename("../evil.txt")).toBe("evil.txt");
  });

  it("converts backslashes and strips path", () => {
    expect(sanitizeUploadFilename("sub\\file.txt")).toBe("file.txt");
  });

  it("returns null for only-dot names", () => {
    expect(sanitizeUploadFilename(".")).toBeNull();
    expect(sanitizeUploadFilename("..")).toBeNull();
  });

  it("returns null for empty result", () => {
    expect(sanitizeUploadFilename("")).toBeNull();
    expect(sanitizeUploadFilename("../")).toBeNull();
  });
});
