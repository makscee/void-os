/**
 * Bridge between Hono (Fetch API) and the MCP SDK's Node-shaped transports.
 *
 * The SDK's StreamableHTTPServerTransport expects Node's IncomingMessage /
 * ServerResponse. Hono on Bun gives us a Fetch API Request inside the Context.
 * We fabricate minimal Node-shaped objects backed by web-stream interop.
 *
 * Only the surface the SDK actually calls is implemented; everything else
 * throws if touched, so silent misuse cannot hide.
 */

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { Context } from "hono";

export interface BridgeResult {
  nodeReq: Readable & { headers: Record<string, string>; method: string; url: string };
  nodeRes: NodeResShim;
  responsePromise: Promise<Response>;
}

interface NodeResShim extends EventEmitter {
  statusCode: number;
  setHeader: (k: string, v: string | number | readonly string[]) => void;
  getHeader: (k: string) => string | number | readonly string[] | undefined;
  removeHeader: (k: string) => void;
  writeHead: (status: number, headers?: Record<string, string>) => NodeResShim;
  flushHeaders: () => void;
  write: (chunk: string | Uint8Array) => boolean;
  end: (chunk?: string | Uint8Array) => void;
  headersSent: boolean;
}

export function honoBridge(c: Context): BridgeResult {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k] = v; });

  // Body stream — even if absent, give an empty Readable so SDK consumers can
  // attach data/end listeners without crashing.
  const body = c.req.raw.body;
  const nodeReqStream = body
    ? Readable.fromWeb(body as unknown as import("stream/web").ReadableStream)
    : Readable.from(Buffer.alloc(0));
  const nodeReq = Object.assign(nodeReqStream as Readable, {
    headers,
    method: c.req.method,
    url: c.req.path + (c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : ""),
  });

  // Outgoing — buffer into a TransformStream whose readable side becomes the
  // Hono Response body. Headers settle when the SDK calls writeHead /
  // flushHeaders / first write / end.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const resHeaders: Record<string, string> = {};
  let statusCode = 200;
  let headersSent = false;
  let resolveResponse!: (r: Response) => void;
  const responsePromise = new Promise<Response>((r) => { resolveResponse = r; });

  const flush = (): void => {
    if (headersSent) return;
    headersSent = true;
    resolveResponse(new Response(readable, { status: statusCode, headers: resHeaders }));
  };

  const nodeRes = Object.assign(new EventEmitter(), {
    statusCode,
    setHeader(k: string, v: string | number | readonly string[]): void {
      resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    },
    getHeader(k: string): string | undefined {
      return resHeaders[k.toLowerCase()];
    },
    removeHeader(k: string): void {
      delete resHeaders[k.toLowerCase()];
    },
    writeHead(status: number, hdrs?: Record<string, string>): NodeResShim {
      statusCode = status;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) resHeaders[k.toLowerCase()] = v;
      flush();
      return nodeRes as unknown as NodeResShim;
    },
    flushHeaders(): void { flush(); },
    write(chunk: string | Uint8Array): boolean {
      flush();
      const buf = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      void writer.write(buf);
      return true;
    },
    end(chunk?: string | Uint8Array): void {
      flush();
      if (chunk !== undefined) {
        const buf = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        void writer.write(buf);
      }
      void writer.close();
    },
    get headersSent(): boolean { return headersSent; },
  }) as unknown as NodeResShim;

  // Sync statusCode writes back through the proxy: callers do `res.statusCode = 200`.
  Object.defineProperty(nodeRes, "statusCode", {
    get: () => statusCode,
    set: (v: number) => { statusCode = v; },
    configurable: true,
  });

  return { nodeReq, nodeRes, responsePromise };
}
