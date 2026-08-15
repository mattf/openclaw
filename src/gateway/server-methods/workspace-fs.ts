// Shared read-only workspace filesystem access for gateway file browsers.
// All entry points route through fs-safe roots (realpathed root, symlink and
// hardlink rejection) so no caller can read or list outside a workspace root.
import path from "node:path";
import { root as fsSafeRoot, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";

export type WorkspaceRoot = Awaited<ReturnType<typeof fsSafeRoot>>;
export type WorkspacePathStat = Awaited<ReturnType<WorkspaceRoot["stat"]>>;
export type WorkspaceDirEntry = WorkspacePathStat & { name: string };

/** Shared preview cap: keeps file payloads comfortably under client WS limits. */
export const WORKSPACE_PREVIEW_MAX_BYTES = 256 * 1024;

async function openWorkspaceRoot(rootDir: string): Promise<WorkspaceRoot | undefined> {
  try {
    return await fsSafeRoot(rootDir, {
      hardlinks: "reject",
      maxBytes: WORKSPACE_PREVIEW_MAX_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
}

export async function statWorkspacePath(
  rootDir: string,
  browserPath: string,
): Promise<WorkspacePathStat | undefined> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.stat(browserPath || ".");
  } catch {
    return undefined;
  }
}

export async function listWorkspacePath(
  rootDir: string,
  browserPath: string,
): Promise<WorkspaceDirEntry[] | undefined> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.list(browserPath || ".", { withFileTypes: true });
  } catch {
    return undefined;
  }
}

export async function readWorkspaceFile(
  rootDir: string,
  browserPath: string,
  opts?: { maxBytes?: number },
): Promise<ReadResult | undefined | "too-large"> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.read(browserPath, {
      hardlinks: "reject",
      maxBytes: opts?.maxBytes ?? WORKSPACE_PREVIEW_MAX_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "too-large") {
      return "too-large";
    }
    return undefined;
  }
}

/** Collapses `.` segments and separators into a canonical root-relative path. */
export function normalizeRelativePath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

/**
 * Lexical containment pre-check before any fs access; fs-safe re-verifies
 * against the realpathed root so symlinked escapes still fail later.
 */
export function resolveWorkspacePath(
  root: string | undefined,
  filePath: string,
): string | undefined {
  if (!root) {
    return undefined;
  }
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

export function workspaceStatKind(
  stat: WorkspacePathStat,
): "file" | "directory" | "symlink" | undefined {
  const kind = (stat as { kind?: unknown }).kind;
  if (kind === "file" || kind === "directory" || kind === "symlink") {
    return kind;
  }
  const nodeStat = stat as {
    isDirectory?: boolean | (() => boolean);
    isFile?: boolean | (() => boolean);
    isSymbolicLink?: boolean | (() => boolean);
  };
  const isFile = typeof nodeStat.isFile === "function" ? nodeStat.isFile() : nodeStat.isFile;
  if (isFile) {
    return "file";
  }
  const isDirectory =
    typeof nodeStat.isDirectory === "function" ? nodeStat.isDirectory() : nodeStat.isDirectory;
  if (isDirectory) {
    return "directory";
  }
  const isSymbolicLink =
    typeof nodeStat.isSymbolicLink === "function"
      ? nodeStat.isSymbolicLink()
      : nodeStat.isSymbolicLink;
  return isSymbolicLink ? "symlink" : undefined;
}

/** Protocol timestamps are integer milliseconds. */
export function toUpdatedAtMs(mtimeMs: number): number {
  return Math.floor(mtimeMs);
}

export function sortDirents<T extends { name: string }>(dirents: readonly T[]): T[] {
  return dirents.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Directories first, then name order — the shared browser display order. */
export function sortWorkspaceEntries<T extends { kind: "file" | "directory"; name: string }>(
  entries: readonly T[],
): T[] {
  return entries.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export type WorkspaceFileExportResult =
  | { kind: "text"; content: string; canonicalPath: string; stat: WorkspacePathStat }
  | { kind: "binary"; content: Uint8Array; canonicalPath: string; stat: WorkspacePathStat }
  | { status: "missing" }
  | { status: "unsafe" };

function isTextData(data: Uint8Array): boolean {
  const len = Math.min(data.length, 8192);
  for (let i = 0; i < len; i++) {
    const byte = data[i];
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) return false;
  }
  return true;
}

export async function exportWorkspaceFile(
  rootDir: string,
  browserPath: string,
): Promise<WorkspaceFileExportResult> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return { status: "unsafe" };
  }
  try {
    const opened = await workspaceRoot.open(browserPath, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    try {
      const stat = opened.stat;
      const isDirectory =
        typeof stat.isDirectory === "function" ? stat.isDirectory() : stat.isDirectory;
      if (isDirectory) {
        return { status: "unsafe" };
      }
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await opened.handle.read(buffer, 0, stat.size, 0);
      const data = buffer.subarray(0, bytesRead);
      const canonicalPath = path
        .relative(workspaceRoot.rootReal, opened.realPath)
        .split(path.sep)
        .join("/");
      const decoded = isTextData(data) ? data.toString("utf8") : undefined;
      if (decoded !== undefined) {
        return {
          kind: "text" as const,
          content: decoded,
          canonicalPath,
          stat,
        };
      }
      return {
        kind: "binary" as const,
        content: data,
        canonicalPath,
        stat,
      };
    } finally {
      await opened.handle.close();
    }
  } catch {
    return { status: "missing" as const };
  }
}

async function openUploadRoot(rootDir: string): Promise<ReturnType<typeof fsSafeRoot> | undefined> {
  try {
    return await fsSafeRoot(rootDir, {
      hardlinks: "reject",
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
}

export async function writeWorkspaceFile(
  rootDir: string,
  browserPath: string,
  content: Buffer,
): Promise<{ success: true } | { error: string }> {
  const workspaceRoot = await openUploadRoot(rootDir);
  if (!workspaceRoot) {
    return { error: "workspace-not-found" };
  }
  try {
    await workspaceRoot.write(browserPath, content, { renameIdentity: "strict" });
    return { success: true };
  } catch (err) {
    if (err instanceof FsSafeError) {
      return { error: "unsafe" };
    }
    throw err;
  }
}
