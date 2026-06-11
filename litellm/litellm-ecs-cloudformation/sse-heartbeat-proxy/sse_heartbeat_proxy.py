#!/usr/bin/env python3
"""
SSE heartbeat reverse proxy (sidecar).

  ALB -> :8080 (this proxy) -> LiteLLM 127.0.0.1:4000

Purpose: during long extended-thinking silences, Bedrock emits no bytes for
seconds-to-minutes. CloudFront's origin Response timeout (a packet-interval
idle timeout, default 30s) treats that silence as a dead origin and cuts the
connection. This proxy injects an SSE comment line (": keepalive\\n\\n") into
the response stream whenever the upstream goes quiet, resetting that idle
timer so the gap can be arbitrarily long.

Scope (see ../README.md timeout section / the design doc):
  - Only touches *streaming* responses (Content-Type: text/event-stream).
    Non-stream responses are passed through byte-for-byte, untouched.
  - Does NOT help the server-side web-search (SearXNG) path: LiteLLM downgrades
    that to non-streaming internally, so there is no SSE stream to inject into.
  - Heartbeats only feed the *idle* timers (CloudFront Response timeout, ALB
    idle). They do NOT cover upstream hard aborts (LiteLLM stream_timeout,
    Bedrock botocore read_timeout) or CloudFront Response Completion timeout.
"""
import asyncio
import os

from aiohttp import web, ClientSession, ClientTimeout

UPSTREAM = os.environ.get("UPSTREAM_BASE", "http://127.0.0.1:4000")
HEARTBEAT_INTERVAL = float(os.environ.get("HEARTBEAT_INTERVAL", "15"))  # < CloudFront origin Response timeout
HEARTBEAT = b": keepalive\n\n"  # SSE comment line; spec-compliant clients ignore it
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))
READ_CHUNK = 65536

# Headers we must not copy verbatim: framing headers (we re-chunk and may inject
# bytes) and hop-by-hop headers. content-encoding is intentionally preserved so
# the body is forwarded as-is.
_STRIP_RESP_HEADERS = {
    "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "upgrade",
}


async def handler(request: web.Request) -> web.StreamResponse:
    url = UPSTREAM + request.rel_url.raw_path_qs

    # Forward the request body as a stream (don't buffer the whole thing in
    # memory — long-context requests can be large).
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}

    upstream = await request.app["session"].request(
        request.method,
        url,
        headers=fwd_headers,
        data=request.content if request.body_exists else None,
        allow_redirects=False,
    )

    is_sse = "text/event-stream" in upstream.headers.get("Content-Type", "")

    resp = web.StreamResponse(
        status=upstream.status,
        reason=upstream.reason,
        headers={k: v for k, v in upstream.headers.items()
                 if k.lower() not in _STRIP_RESP_HEADERS},
    )
    await resp.prepare(request)

    if not is_sse:
        # Non-streaming: pass through byte-for-byte, no heartbeat.
        async for chunk in upstream.content.iter_any():
            await resp.write(chunk)
        await resp.write_eof()
        return resp

    # Streaming: read upstream in a background task feeding a queue, so a
    # heartbeat timeout never cancels an in-flight read() on the StreamReader
    # (the aiohttp wait_for(read) cancellation pitfall). The reader task owns
    # the StreamReader exclusively; the writer only ever touches the queue.
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _DONE = object()

    async def pump():
        try:
            async for chunk in upstream.content.iter_chunked(READ_CHUNK):
                await queue.put(chunk)
        except Exception as exc:  # surface upstream read errors to the writer
            await queue.put(exc)
        else:
            await queue.put(_DONE)

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_INTERVAL)
            except asyncio.TimeoutError:
                await resp.write(HEARTBEAT)  # upstream is silent — feed the idle timers
                continue
            if item is _DONE:
                break
            if isinstance(item, Exception):
                break  # upstream died; close the downstream stream
            await resp.write(item)
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
        upstream.release()

    await resp.write_eof()
    return resp


async def make_app() -> web.Application:
    app = web.Application(client_max_size=0)  # 0 = unlimited; body is streamed, not buffered
    # total=None: never let the client session abort a long-running stream.
    app["session"] = ClientSession(timeout=ClientTimeout(total=None, connect=30))

    async def _close_session(app):
        await app["session"].close()

    app.on_cleanup.append(_close_session)
    app.router.add_route("*", "/{tail:.*}", handler)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), port=LISTEN_PORT, access_log=None)
