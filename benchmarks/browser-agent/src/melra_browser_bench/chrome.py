# Copyright 2026 XAGI Labs Private Limited
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import asyncio
import shutil
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx


@dataclass(frozen=True)
class ChromeCdpProcess:
    endpoint: str
    user_data_directory: Path
    process: asyncio.subprocess.Process

    @classmethod
    @asynccontextmanager
    async def start(cls, executable: Path) -> AsyncIterator[ChromeCdpProcess]:
        if not executable.is_file():
            raise FileNotFoundError(f"browser executable not found: {executable}")
        user_data_directory = Path(tempfile.mkdtemp(prefix="melra-cdp-"))
        process = await asyncio.create_subprocess_exec(
            str(executable),
            "--headless=new",
            "--remote-debugging-port=0",
            f"--user-data-dir={user_data_directory}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        instance: ChromeCdpProcess | None = None
        try:
            deadline = asyncio.get_running_loop().time() + 10
            active_port = user_data_directory / "DevToolsActivePort"
            endpoint: str | None = None
            async with httpx.AsyncClient(timeout=1) as client:
                while asyncio.get_running_loop().time() < deadline:
                    if process.returncode is not None:
                        raise RuntimeError(f"chrome_cdp_process_exited:{process.returncode}")
                    if active_port.is_file():
                        lines = active_port.read_text(encoding="utf-8").splitlines()
                        if lines and lines[0].isdigit():
                            candidate = f"http://127.0.0.1:{lines[0]}"
                            try:
                                response = await client.get(f"{candidate}/json/version")
                                response.raise_for_status()
                                payload = response.json()
                                if isinstance(payload.get("webSocketDebuggerUrl"), str):
                                    endpoint = candidate
                                    break
                            except (httpx.HTTPError, ValueError):
                                pass
                    await asyncio.sleep(0.05)
            if endpoint is None:
                raise TimeoutError("chrome_cdp_endpoint_timeout")
            instance = cls(
                endpoint=endpoint,
                user_data_directory=user_data_directory,
                process=process,
            )
            yield instance
        finally:
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            shutil.rmtree(user_data_directory, ignore_errors=True)
