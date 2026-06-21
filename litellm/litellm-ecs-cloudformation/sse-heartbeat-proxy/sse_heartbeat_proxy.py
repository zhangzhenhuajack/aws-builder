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

Two silences must be covered (confirmed against CloudFront docs — the origin
Response timeout is ONE value covering BOTH the wait for the first response
byte/headers AND every inter-packet gap, reset per packet):

  1. Time-to-first-byte (TTFB): LiteLLM does NOT send the 200 response headers
     until its first token — for long thinking that's 30-120+s of total origin
     silence (no headers, no body). If that exceeds the origin timeout,
     CloudFront 504s before anything streams. To cover it, for requests we can
     identify as streaming we send our OWN 200 + SSE headers to the client
     IMMEDIATELY (before contacting LiteLLM) and start the heartbeat right away.
  2. Inter-token gaps once streaming has begun (covered by the same heartbeat).

Scope (see ../README.md timeout section / the design doc):
  - Streaming requests (detected from the request: Accept: text/event-stream or
    a JSON body with "stream": true) get early 200 headers + heartbeat.
  - Everything else is passed through byte-for-byte with the upstream's real
    status/headers (so non-stream error codes propagate correctly).
  - Does NOT help the server-side web-search (SearXNG) path: LiteLLM downgrades
    that to non-streaming internally, so there is no SSE stream to inject into.
  - Heartbeats only feed the *idle* timers (CloudFront Response timeout, ALB
    idle). They do NOT cover CloudFront Response Completion timeout.

Trade-off of early headers: once we've sent 200 to the client we can no longer
change the status code. If the upstream then returns a non-200 / non-SSE
response, we surface it as an SSE error event in the already-open stream (which
is how OpenAI-compatible streaming clients receive errors anyway).
"""
import asyncio
import json
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

_SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",  # ask any intermediary proxy not to buffer
}


async def _wants_stream(request: web.Request) -> bool:
    """Decide if this request will produce an SSE stream, so we can send early
    headers + heartbeat to cover the upstream's time-to-first-byte. We peek at
    the buffered body; aiohttp re-serves it to the forwarded request below."""
    if "text/event-stream" in request.headers.get("Accept", ""):
        return True
    ctype = request.headers.get("Content-Type", "")
    if request.method == "POST" and "json" in ctype:
        try:
            body = await request.read()  # buffered; .read() again returns same bytes
            data = json.loads(body)
            return bool(data.get("stream"))
        except Exception:
            return False
    return False


async def handler(request: web.Request) -> web.StreamResponse:
    url = UPSTREAM + request.rel_url.raw_path_qs
    early = await _wants_stream(request)

    # If we already buffered the body for stream detection, forward those bytes;
    # otherwise stream the body through (don't buffer large non-stream uploads).
    if request.method == "POST" and "json" in request.headers.get("Content-Type", ""):
        fwd_data = await request.read()
    else:
        fwd_data = request.content if request.body_exists else None
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}

    if not early:
        # ---- Non-streaming path: wait for upstream, propagate real status ----
        upstream = await request.app["session"].request(
            request.method, url, headers=fwd_headers, data=fwd_data,
            allow_redirects=False,
        )
        is_sse = "text/event-stream" in upstream.headers.get("Content-Type", "")
        resp = web.StreamResponse(
            status=upstream.status, reason=upstream.reason,
            headers={k: v for k, v in upstream.headers.items()
                     if k.lower() not in _STRIP_RESP_HEADERS},
        )
        await resp.prepare(request)
        if is_sse:
            # Upstream surprised us with a stream — still inject heartbeats.
            await _pump_with_heartbeat(upstream, resp)
        else:
            async for chunk in upstream.content.iter_any():
                await resp.write(chunk)
            upstream.release()
        await resp.write_eof()
        return resp

    # ---- Streaming path: send our own 200 + SSE headers NOW, before LiteLLM ----
    # This satisfies CloudFront's first-byte timeout immediately and lets the
    # heartbeat cover the whole time-to-first-token, not just inter-token gaps.
    resp = web.StreamResponse(status=200, headers=dict(_SSE_HEADERS))
    await resp.prepare(request)

    # Contact upstream concurrently; heartbeat the client until its headers land.
    req_task = asyncio.ensure_future(request.app["session"].request(
        request.method, url, headers=fwd_headers, data=fwd_data,
        allow_redirects=False,
    ))
    try:
        while not req_task.done():
            done, _ = await asyncio.wait({req_task}, timeout=HEARTBEAT_INTERVAL)
            if not done:
                await resp.write(HEARTBEAT)  # upstream headers not here yet — keep alive
        upstream = req_task.result()
    except Exception as exc:
        # Couldn't even reach upstream — report as an SSE error event.
        await _write_sse_error(resp, f"upstream connection error: {exc}")
        await resp.write_eof()
        return resp

    is_sse = "text/event-stream" in upstream.headers.get("Content-Type", "")
    if upstream.status != 200 or not is_sse:
        # We already committed 200 + SSE to the client, so we can't change the
        # status. Surface the upstream failure as an SSE error event instead.
        detail = (await upstream.read()).decode(errors="replace")[:2000]
        await _write_sse_error(resp, f"upstream returned {upstream.status}", detail)
        upstream.release()
        await resp.write_eof()
        return resp

    await _pump_with_heartbeat(upstream, resp)
    await resp.write_eof()
    return resp


async def _pump_with_heartbeat(upstream, resp: web.StreamResponse) -> None:
    """Stream upstream bytes to the client, injecting a heartbeat whenever the
    upstream is silent for HEARTBEAT_INTERVAL. A dedicated reader task owns the
    StreamReader so a heartbeat-driven timeout never cancels an in-flight read()
    (the aiohttp wait_for(read) cancellation pitfall)."""
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


async def _write_sse_error(resp: web.StreamResponse, message: str, detail: str = "") -> None:
    payload = {"error": {"message": message, "type": "upstream_error"}}
    if detail:
        payload["error"]["detail"] = detail
    await resp.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
    await resp.write(b"data: [DONE]\n\n")


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
