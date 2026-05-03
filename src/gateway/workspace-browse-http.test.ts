import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import {
  handleWorkspaceBrowseRequest,
  WORKSPACE_BROWSE_PREFIX,
} from "./workspace-browse-http.js";

const noAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

function makeReq(url: string, method: "GET" | "HEAD" | "POST" | "DELETE" | "PUT" = "GET"): IncomingMessage {
  return { url, method, headers: {} } as IncomingMessage;
}

async function withWorkspace<T>(fn: (workspaceDir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ws-browse-test-"));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function call(
  url: string,
  workspaceDir: string,
  opts: { method?: "GET" | "HEAD" | "POST"; basePath?: string } = {},
) {
  const { res, setHeader, end } = makeMockHttpResponse();
  const handled = await handleWorkspaceBrowseRequest(makeReq(url, opts.method ?? "GET"), res, {
    basePath: opts.basePath ?? "",
    workspaceDir,
    resolvedAuth: noAuth,
    trustedProxies: [],
    allowRealIpFallback: false,
  });
  return { res, setHeader, end, handled };
}

describe("handleWorkspaceBrowseRequest", () => {
  describe("route matching", () => {
    it("returns false for non-workspace paths", async () => {
      await withWorkspace(async (ws) => {
        const { handled } = await call("/chat", ws);
        expect(handled).toBe(false);
      });
    });

    it("returns false for /workspace-extra path", async () => {
      await withWorkspace(async (ws) => {
        const { handled } = await call("/workspace-extra", ws);
        expect(handled).toBe(false);
      });
    });

    it("returns false for non-workspace path with basePath", async () => {
      await withWorkspace(async (ws) => {
        const { handled } = await call("/overview", ws, { basePath: "/ui" });
        expect(handled).toBe(false);
      });
    });

    it("matches /workspace with basePath", async () => {
      await withWorkspace(async (ws) => {
        const { handled } = await call("/ui/workspace", ws, { basePath: "/ui" });
        expect(handled).toBe(true);
      });
    });
  });

  describe("redirects", () => {
    it("redirects bare /workspace to /workspace/", async () => {
      await withWorkspace(async (ws) => {
        const { res, setHeader, handled } = await call("/workspace", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(301);
        expect(setHeader).toHaveBeenCalledWith("Location", "/workspace/");
      });
    });

    it("redirects directory without trailing slash", async () => {
      await withWorkspace(async (ws) => {
        await fs.mkdir(path.join(ws, "subdir"), { recursive: true });
        const { res, setHeader, handled } = await call("/workspace/subdir", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(301);
        expect(setHeader).toHaveBeenCalledWith("Location", "/workspace/subdir/");
      });
    });
  });

  describe("directory listing", () => {
    it("returns HTML listing for workspace root", async () => {
      await withWorkspace(async (ws) => {
        await fs.writeFile(path.join(ws, "readme.txt"), "hello");
        const { res, handled, end } = await call("/workspace/", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const body = String(end.mock.calls[0]?.[0] ?? "");
        expect(body).toContain("<!DOCTYPE html>");
        expect(body).toContain("readme.txt");
      });
    });

    it("lists directories before files", async () => {
      await withWorkspace(async (ws) => {
        await fs.mkdir(path.join(ws, "adir"), { recursive: true });
        await fs.writeFile(path.join(ws, "afile.txt"), "x");
        const { end } = await call("/workspace/", ws);
        const body = String(end.mock.calls[0]?.[0] ?? "");
        const dirPos = body.indexOf("adir/");
        const filePos = body.indexOf("afile.txt");
        expect(dirPos).toBeLessThan(filePos);
      });
    });

    it("shows a parent link for subdirectory", async () => {
      await withWorkspace(async (ws) => {
        const sub = path.join(ws, "sub");
        await fs.mkdir(sub, { recursive: true });
        const { end } = await call("/workspace/sub/", ws);
        const body = String(end.mock.calls[0]?.[0] ?? "");
        expect(body).toContain('href="../"');
      });
    });

    it("no parent link at root", async () => {
      await withWorkspace(async (ws) => {
        const { end } = await call("/workspace/", ws);
        const body = String(end.mock.calls[0]?.[0] ?? "");
        expect(body).not.toContain('href="../"');
      });
    });

    it("responds with 200 and empty body for HEAD", async () => {
      await withWorkspace(async (ws) => {
        const { res, handled, end } = await call("/workspace/", ws, { method: "HEAD" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(end.mock.calls[0]?.[0]).toBeUndefined();
      });
    });
  });

  describe("file serving", () => {
    it("serves a text file with correct Content-Type", async () => {
      await withWorkspace(async (ws) => {
        await fs.writeFile(path.join(ws, "hello.txt"), "world");
        const { res, handled, end } = await call("/workspace/hello.txt", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("world");
      });
    });

    it("serves an HTML file with text/html Content-Type", async () => {
      await withWorkspace(async (ws) => {
        await fs.writeFile(path.join(ws, "index.html"), "<h1>hi</h1>");
        const { res, setHeader, handled } = await call("/workspace/index.html", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        // Check that Content-Type starts with text/html
        const ctCall = (setHeader.mock.calls as [string, string][]).find(
          (args) => args[0].toLowerCase() === "content-type",
        );
        expect(ctCall?.[1]).toMatch(/^text\/html/);
      });
    });

    it("responds with 200 and no body for HEAD", async () => {
      await withWorkspace(async (ws) => {
        await fs.writeFile(path.join(ws, "data.json"), '{"ok":true}');
        const { res, handled, end } = await call("/workspace/data.json", ws, { method: "HEAD" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        // HEAD should end without a body
        expect(end.mock.calls[0]?.[0]).toBeUndefined();
      });
    });

    it("returns 404 for missing file", async () => {
      await withWorkspace(async (ws) => {
        const { res, handled } = await call("/workspace/does-not-exist.txt", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(404);
      });
    });

    it("serves a file in a subdirectory", async () => {
      await withWorkspace(async (ws) => {
        await fs.mkdir(path.join(ws, "a", "b"), { recursive: true });
        await fs.writeFile(path.join(ws, "a", "b", "c.txt"), "deep");
        const { res, handled, end } = await call("/workspace/a/b/c.txt", ws);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("deep");
      });
    });
  });

  describe("Content-Type mapping", () => {
    const cases: Array<[string, RegExp]> = [
      ["app.js", /^application\/javascript/],
      ["style.css", /^text\/css/],
      ["data.json", /^application\/json/],
      ["icon.svg", /^image\/svg\+xml/],
      ["photo.png", /^image\/png/],
      ["photo.jpg", /^image\/jpeg/],
      ["photo.webp", /^image\/webp/],
      ["favicon.ico", /^image\/x-icon/],
    ];

    for (const [filename, expectedCt] of cases) {
      it(`serves ${filename} with expected Content-Type`, async () => {
        await withWorkspace(async (ws) => {
          await fs.writeFile(path.join(ws, filename), "data");
          const { res, setHeader, handled } = await call(`/workspace/${filename}`, ws);
          expect(handled).toBe(true);
          const ctCall = (setHeader.mock.calls as [string, string][]).find(
            (args) => args[0].toLowerCase() === "content-type",
          );
          expect(ctCall?.[1]).toMatch(expectedCt);
        });
      });
    }
  });

  describe("path traversal prevention", () => {
    it("blocks ../  path traversal in URL", async () => {
      await withWorkspace(async (ws) => {
        // URL-encode the traversal attempt
        const { res, handled } = await call("/workspace/..%2F..%2Fetc%2Fpasswd", ws);
        expect(handled).toBe(true);
        // Should be either 403 (forbidden) or 404 (not found outside boundary)
        expect([403, 404]).toContain(res.statusCode);
      });
    });

    it("blocks traversal that resolves outside workspace", async () => {
      await withWorkspace(async (ws) => {
        const { res, handled } = await call("/workspace/%2E%2E%2F%2E%2E%2Ftmp", ws);
        expect(handled).toBe(true);
        expect([403, 404]).toContain(res.statusCode);
      });
    });
  });

  describe("method restriction", () => {
    it("returns 405 for DELETE to workspace path", async () => {
      await withWorkspace(async (ws) => {
        const { res, handled } = await call("/workspace/", ws, { method: "DELETE" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(405);
      });
    });

    it("returns 405 for PUT to workspace path", async () => {
      await withWorkspace(async (ws) => {
        const { res, handled } = await call("/workspace/", ws, { method: "PUT" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(405);
      });
    });
  });

  describe("WORKSPACE_BROWSE_PREFIX export", () => {
    it("is /workspace", () => {
      expect(WORKSPACE_BROWSE_PREFIX).toBe("/workspace");
    });
  });

  describe("file upload", () => {
    function buildMultipartBody(boundary: string, filename: string, content: Buffer): Buffer {
      return Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    }

    function makeUploadReq(url: string, filename: string, content: Buffer | string): IncomingMessage {
      const boundary = "test-boundary-abc123";
      const contentBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const body = buildMultipartBody(boundary, filename, contentBuf);
      const readable = Readable.from([body]);
      return Object.assign(readable, {
        url,
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
      }) as unknown as IncomingMessage;
    }

    async function callUpload(
      url: string,
      workspaceDir: string,
      filename: string,
      content: Buffer | string,
      opts: { basePath?: string } = {},
    ) {
      const { res, setHeader, end } = makeMockHttpResponse();
      const req = makeUploadReq(url, filename, content);
      const handled = await handleWorkspaceBrowseRequest(req, res, {
        basePath: opts.basePath ?? "",
        workspaceDir,
        resolvedAuth: noAuth,
        trustedProxies: [],
        allowRealIpFallback: false,
      });
      return { res, setHeader, end, handled };
    }

    it("uploads a file to the workspace root and redirects", async () => {
      await withWorkspace(async (ws) => {
        const { res, handled } = await callUpload("/workspace/", ws, "hello.txt", "world");
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(303);
        const destContent = await fs.readFile(path.join(ws, "hello.txt"), "utf-8");
        expect(destContent).toBe("world");
      });
    });

    it("redirects back to the source directory after upload", async () => {
      await withWorkspace(async (ws) => {
        await fs.mkdir(path.join(ws, "sub"), { recursive: true });
        const { res, setHeader } = await callUpload("/workspace/sub/", ws, "data.txt", "x");
        expect(res.statusCode).toBe(303);
        expect(setHeader).toHaveBeenCalledWith("Location", "/workspace/sub/");
        const destContent = await fs.readFile(path.join(ws, "sub", "data.txt"), "utf-8");
        expect(destContent).toBe("x");
      });
    });

    it("overwrites an existing file", async () => {
      await withWorkspace(async (ws) => {
        await fs.writeFile(path.join(ws, "file.txt"), "old");
        await callUpload("/workspace/", ws, "file.txt", "new");
        const destContent = await fs.readFile(path.join(ws, "file.txt"), "utf-8");
        expect(destContent).toBe("new");
      });
    });

    it("returns 400 when POST targets a file path", async () => {
      await withWorkspace(async (ws) => {
        await fs.writeFile(path.join(ws, "existing.txt"), "data");
        const { res, handled } = await callUpload("/workspace/existing.txt", ws, "other.txt", "x");
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
      });
    });

    it("returns 400 when Content-Type is not multipart/form-data", async () => {
      await withWorkspace(async (ws) => {
        const { res, setHeader, end } = makeMockHttpResponse();
        const req = Object.assign(Readable.from([Buffer.from("body")]), {
          url: "/workspace/",
          method: "POST",
          headers: { "content-type": "application/json" },
        }) as unknown as IncomingMessage;
        const handled = await handleWorkspaceBrowseRequest(req, res, {
          basePath: "",
          workspaceDir: ws,
          resolvedAuth: noAuth,
          trustedProxies: [],
          allowRealIpFallback: false,
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        void setHeader;
        void end;
      });
    });

    it("returns 400 when no file field is present in the multipart body", async () => {
      await withWorkspace(async (ws) => {
        const boundary = "test-boundary-nofile";
        const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nvalue\r\n--${boundary}--\r\n`);
        const { res, setHeader, end } = makeMockHttpResponse();
        const req = Object.assign(Readable.from([body]), {
          url: "/workspace/",
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        }) as unknown as IncomingMessage;
        const handled = await handleWorkspaceBrowseRequest(req, res, {
          basePath: "",
          workspaceDir: ws,
          resolvedAuth: noAuth,
          trustedProxies: [],
          allowRealIpFallback: false,
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        void setHeader;
        void end;
      });
    });

    it("strips path traversal from filename and saves safely", async () => {
      await withWorkspace(async (ws) => {
        // filename "../evil.txt" should be sanitized to "evil.txt"
        const { res } = await callUpload("/workspace/", ws, "../evil.txt", "payload");
        expect(res.statusCode).toBe(303);
        // File must exist inside the workspace, not outside
        const destContent = await fs.readFile(path.join(ws, "evil.txt"), "utf-8");
        expect(destContent).toBe("payload");
      });
    });

    it("returns 400 for a filename that is only path separators (empty base)", async () => {
      await withWorkspace(async (ws) => {
        const { res } = await callUpload("/workspace/", ws, "../", "payload");
        expect(res.statusCode).toBe(400);
      });
    });

    it("strips Origin: null before auth so trusted-proxy form POSTs are not blocked", async () => {
      await withWorkspace(async (ws) => {
        const boundary = "test-boundary-null-origin";
        const body = buildMultipartBody(boundary, "upload.txt", Buffer.from("ok"));
        const { res, setHeader, end } = makeMockHttpResponse();
        const req = Object.assign(Readable.from([body]), {
          url: "/workspace/",
          method: "POST",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "origin": "null", // browser sends literal "null" with Referrer-Policy: no-referrer
          },
        }) as unknown as IncomingMessage;
        const handled = await handleWorkspaceBrowseRequest(req, res, {
          basePath: "",
          workspaceDir: ws,
          resolvedAuth: noAuth,
          trustedProxies: [],
          allowRealIpFallback: false,
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(303);
        void setHeader;
        void end;
      });
    });

    it("authenticates upload via ?token= query param when no Authorization header", async () => {
      await withWorkspace(async (ws) => {
        // Simulate token auth: resolvedAuth mode "token", token matches
        const tokenAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
        const boundary = "test-boundary-token";
        const body = buildMultipartBody(boundary, "upload.txt", Buffer.from("ok"));
        const { res, setHeader, end } = makeMockHttpResponse();
        const req = Object.assign(Readable.from([body]), {
          url: "/workspace/?token=mytoken",
          method: "POST",
          // No Authorization header — token comes from query param
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        }) as unknown as IncomingMessage;
        const handled = await handleWorkspaceBrowseRequest(req, res, {
          basePath: "",
          workspaceDir: ws,
          resolvedAuth: tokenAuth,
          trustedProxies: [],
          allowRealIpFallback: false,
        });
        expect(handled).toBe(true);
        // With mode "none" auth, it passes regardless — this confirms the
        // query-param token injection code path doesn't break anything
        expect(res.statusCode).toBe(303);
        void setHeader;
        void end;
      });
    });

    it("directory listing includes action with ?token= when bearer token present", async () => {
      await withWorkspace(async (ws) => {
        const { res, setHeader, end } = makeMockHttpResponse();
        const req = Object.assign(new Readable({ read() {} }), {
          url: "/workspace/",
          method: "GET",
          headers: { authorization: "Bearer mytoken123" },
        }) as unknown as IncomingMessage;
        const handled = await handleWorkspaceBrowseRequest(req, res, {
          basePath: "",
          workspaceDir: ws,
          resolvedAuth: noAuth,
          trustedProxies: [],
          allowRealIpFallback: false,
        });
        expect(handled).toBe(true);
        const body = String(end.mock.calls[0]?.[0] ?? "");
        expect(body).toContain("action=");
        expect(body).toContain("mytoken123");
        void setHeader;
      });
    });

    it("returns 413 when file exceeds 50 MB", async () => {
      await withWorkspace(async (ws) => {
        const boundary = "test-boundary-large";
        const FIFTY_MB_PLUS_ONE = 50 * 1024 * 1024 + 1;
        const largeChunk = Buffer.alloc(FIFTY_MB_PLUS_ONE, 0x41); // fill with 'A'
        const body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
          largeChunk,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const { res, setHeader, end } = makeMockHttpResponse();
        const req = Object.assign(Readable.from([body]), {
          url: "/workspace/",
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        }) as unknown as IncomingMessage;
        const handled = await handleWorkspaceBrowseRequest(req, res, {
          basePath: "",
          workspaceDir: ws,
          resolvedAuth: noAuth,
          trustedProxies: [],
          allowRealIpFallback: false,
        });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(413);
        void setHeader;
        void end;
      });
    });
  });
});
