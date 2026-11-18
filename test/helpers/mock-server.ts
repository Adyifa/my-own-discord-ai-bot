import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON request body (loosely typed for convenient assertions). */
  body: any;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Tiny local HTTP server that imitates an LLM API, so providers are tested over real HTTP. */
export async function startMockServer(
  responder: (request: RecordedRequest) => MockReply | Promise<MockReply>
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined
    };
    requests.push(recorded);

    const reply = await responder(recorded);
    if (res.destroyed) return;
    const isText = typeof reply.body === "string";
    res.writeHead(reply.status ?? 200, {
      "Content-Type": isText ? "text/plain" : "application/json",
      ...reply.headers
    });
    res.end(isText ? reply.body as string : JSON.stringify(reply.body));
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}
