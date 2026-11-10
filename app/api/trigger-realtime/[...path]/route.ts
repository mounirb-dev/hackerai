import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

const triggerBaseUrl = () =>
  (
    process.env.TRIGGER_INTERNAL_URL ??
    process.env.TRIGGER_API_URL ??
    "https://api.trigger.dev"
  ).replace(/\/$/, "");

async function proxy(request: NextRequest, path: string[]) {
  const target = `${triggerBaseUrl()}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const headers = new Headers();

  for (const [name, value] of request.headers) {
    if (!hopByHopHeaders.has(name.toLowerCase())) headers.set(name, value);
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const response = await fetch(target, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    signal: request.signal,
  });

  const responseHeaders = new Headers();
  for (const [name, value] of response.headers) {
    if (!hopByHopHeaders.has(name.toLowerCase()))
      responseHeaders.set(name, value);
  }
  responseHeaders.delete("access-control-allow-origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxy(request, (await context.params).path);
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
