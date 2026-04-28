declare module "busboy" {
  import type { IncomingHttpHeaders } from "node:http";
  import type { Writable, Readable } from "node:stream";

  export interface BusboyConfig {
    headers: IncomingHttpHeaders;
    limits?: {
      fieldNameSize?: number;
      fieldSize?: number;
      fields?: number;
      fileSize?: number;
      files?: number;
      parts?: number;
      headerPairs?: number;
    };
    preservePath?: boolean;
  }

  export interface FileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  export interface BusboyFileStream extends Readable {
    truncated?: boolean;
    on(event: "limit", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface Busboy extends Writable {
    on(event: "file", listener: (fieldname: string, file: BusboyFileStream, info: FileInfo) => void): this;
    on(event: "field", listener: (fieldname: string, value: string, info: { nameTruncated: boolean; valueTruncated: boolean; encoding: string; mimeType: string }) => void): this;
    on(event: "finish", listener: () => void): this;
    on(event: "error", listener: (err: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  function busboy(options: BusboyConfig): Busboy;
  export default busboy;
}
