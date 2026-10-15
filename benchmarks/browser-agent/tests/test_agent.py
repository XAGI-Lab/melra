# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from melra_browser_bench.agent import AgentContext, BrowserActionDecision, OpenAICompatibleAgent


class _CompletionHandler(BaseHTTPRequestHandler):
    request_body: dict[str, object] | None = None

    def do_POST(self) -> None:
        length = int(self.headers["content-length"])
        type(self).request_body = json.loads(self.rfile.read(length))
        response = {
            "id": "completion-fixture",
            "model": "provider-model-snapshot-2026-07-28",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {
                                    "name": "browser_action",
                                    "arguments": json.dumps(
                                        {
                                            "goal": "Submit the form",
                                            "action": "click",
                                            "target": {
                                                "role": "button",
                                                "name": "Submit",
                                            },
                                        }
                                    ),
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {
                "prompt_tokens": 120,
                "prompt_tokens_details": {"cached_tokens": 40},
                "completion_tokens": 18,
            },
        }
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextmanager
def completion_server() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _CompletionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.asyncio
async def test_openai_compatible_agent_parses_one_strict_action() -> None:
    with completion_server() as base_url:
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
        )
        decision = await agent.decide(
            AgentContext(
                goal="Submit the form",
                observation={"text": "Ready", "elements": [{"role": "button", "name": "Submit"}]},
            )
        )
    assert decision.action == "click"
    assert decision.target == {"role": "button", "name": "Submit"}
    assert decision.usage.input_tokens == 120
    assert decision.usage.cached_input_tokens == 40
    assert decision.usage.output_tokens == 18
    assert decision.model_id == "provider-model-snapshot-2026-07-28"
    assert len(agent.prompt_sha256) == 64
    assert len(agent.tool_schema_sha256) == 64
    request = _CompletionHandler.request_body
    assert request is not None
    assert request["temperature"] == 0
    assert request["parallel_tool_calls"] is False


class _RateLimitedHandler(BaseHTTPRequestHandler):
    """Answers 429 a fixed number of times, then returns one valid tool call."""

    remaining_rejections: int = 0
    attempts: int = 0
    retry_after: str | None = None

    def do_POST(self) -> None:
        length = int(self.headers["content-length"])
        self.rfile.read(length)
        type(self).attempts += 1
        if type(self).remaining_rejections > 0:
            type(self).remaining_rejections -= 1
            body = json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}}).encode()
            self.send_response(429)
            if type(self).retry_after is not None:
                self.send_header("retry-after", type(self).retry_after)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        response = {
            "id": "completion-fixture",
            "model": "provider-model-snapshot-2026-07-28",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {
                                    "name": "browser_action",
                                    "arguments": json.dumps(
                                        {
                                            "goal": "Submit the form",
                                            "action": "click",
                                            "target": {"role": "button", "name": "Submit"},
                                        }
                                    ),
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }
        body = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextmanager
def rate_limited_server(
    *, rejections: int, retry_after: str | None = None
) -> Iterator[str]:
    _RateLimitedHandler.remaining_rejections = rejections
    _RateLimitedHandler.attempts = 0
    _RateLimitedHandler.retry_after = retry_after
    server = ThreadingHTTPServer(("127.0.0.1", 0), _RateLimitedHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


_CONTEXT = AgentContext(goal="Submit the form", observation={"text": "Ready", "elements": []})


@pytest.mark.asyncio
async def test_agent_retries_through_rate_limiting_and_records_waits() -> None:
    waits: list[float] = []

    async def record(seconds: float) -> None:
        waits.append(seconds)

    with rate_limited_server(rejections=3) as base_url:
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            backoff_base_seconds=2,
            backoff_cap_seconds=5,
            sleep=record,
        )
        decision = await agent.decide(_CONTEXT)
    assert decision.action == "click"
    assert _RateLimitedHandler.attempts == 4
    # Exponential, capped: a provider that answers 429 without Retry-After must
    # not be retried in a tight loop.
    assert waits == [2, 4, 5]


@pytest.mark.asyncio
async def test_agent_honors_retry_after_header_when_present() -> None:
    waits: list[float] = []

    async def record(seconds: float) -> None:
        waits.append(seconds)

    with rate_limited_server(rejections=1, retry_after="34") as base_url:
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            sleep=record,
        )
        await agent.decide(_CONTEXT)
    assert waits == [34]


@pytest.mark.asyncio
async def test_agent_gives_up_after_bounded_rate_limit_attempts() -> None:
    async def instant(_seconds: float) -> None:
        return None

    with rate_limited_server(rejections=99) as base_url:
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            max_attempts=3,
            sleep=instant,
        )
        with pytest.raises(httpx.HTTPStatusError):
            await agent.decide(_CONTEXT)
    assert _RateLimitedHandler.attempts == 3


@pytest.mark.asyncio
async def test_agent_paces_requests_to_respect_a_request_budget() -> None:
    """A provider budget must be respected before it is exceeded.

    Retrying after 429 is not enough on a small per-minute allowance: the
    rejected requests keep the window saturated. The agent must space requests
    so the budget is not exceeded in the first place.
    """
    waits: list[float] = []
    now = [1000.0]

    async def record(seconds: float) -> None:
        waits.append(seconds)
        now[0] += seconds

    with rate_limited_server(rejections=0) as base_url:
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            min_request_interval_seconds=3,
            sleep=record,
            clock=lambda: now[0],
        )
        await agent.decide(_CONTEXT)
        assert waits == []  # first request is immediate
        await agent.decide(_CONTEXT)
        await agent.decide(_CONTEXT)
    assert waits == [3, 3]
    assert _RateLimitedHandler.attempts == 3


@pytest.mark.asyncio
async def test_agent_pacing_does_not_wait_when_enough_time_already_passed() -> None:
    waits: list[float] = []
    now = [1000.0]

    async def record(seconds: float) -> None:
        waits.append(seconds)
        now[0] += seconds

    with rate_limited_server(rejections=0) as base_url:
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            min_request_interval_seconds=3,
            sleep=record,
            clock=lambda: now[0],
        )
        await agent.decide(_CONTEXT)
        now[0] += 10  # caller was slow; no extra pacing needed
        await agent.decide(_CONTEXT)
    assert waits == []


@pytest.mark.asyncio
async def test_agent_retries_transient_transport_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dropped connection is transient and must not lose the task.

    A read error or protocol error mid-request carries no HTTP status, so status
    handling alone leaves it uncaught and the whole task is discarded.
    """
    waits: list[float] = []

    async def record(seconds: float) -> None:
        waits.append(seconds)

    with completion_server() as base_url:
        real_post = httpx.AsyncClient.post
        calls = {"n": 0}

        async def flaky(self: httpx.AsyncClient, url: str, **kwargs: object) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ReadError("connection reset")
            if calls["n"] == 2:
                raise httpx.RemoteProtocolError("server disconnected")
            return await real_post(self, url, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(httpx.AsyncClient, "post", flaky)
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            backoff_base_seconds=2,
            backoff_cap_seconds=5,
            sleep=record,
        )
        decision = await agent.decide(_CONTEXT)
    assert decision.action == "click"
    assert calls["n"] == 3
    assert waits == [2, 4]


@pytest.mark.asyncio
async def test_agent_reraises_transport_error_after_bounded_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def instant(_seconds: float) -> None:
        return None

    with completion_server() as base_url:
        async def always_fail(self: httpx.AsyncClient, url: str, **kwargs: object) -> object:
            raise httpx.ReadError("connection reset")

        monkeypatch.setattr(httpx.AsyncClient, "post", always_fail)
        agent = OpenAICompatibleAgent(
            base_url=base_url,
            api_key="test-only",
            model_id="provider-model-snapshot-2026-07-28",
            max_attempts=3,
            sleep=instant,
        )
        with pytest.raises(httpx.TransportError):
            await agent.decide(_CONTEXT)


def test_decision_sends_a_list_only_to_the_action_that_reads_it() -> None:
    target = {"selector": "#t"}
    click = BrowserActionDecision(
        goal="g", action="click", target=target, values=(), file_paths=("a",)
    )
    assert "values" not in click.operation()
    assert "filePaths" not in click.operation()
    select = BrowserActionDecision(goal="g", action="select", target=target, values=("x",))
    assert select.operation()["values"] == ["x"]
    upload = BrowserActionDecision(goal="g", action="upload", target=target, file_paths=("a",))
    assert upload.operation()["filePaths"] == ["a"]


def test_decision_sends_a_url_only_where_it_navigates() -> None:
    target = {"selector": "#t"}
    click = BrowserActionDecision(goal="g", action="click", target=target, url="https://a.test/")
    assert "url" not in click.operation()
    go = BrowserActionDecision(goal="g", action="navigate", url="https://a.test/")
    assert go.operation()["url"] == "https://a.test/"
