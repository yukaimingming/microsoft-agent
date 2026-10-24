#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
async_fetch.py — 异步并发抓取示例

功能：
  1. 使用 asyncio + aiohttp 并发抓取一组 URL
  2. 限制最大并发数（信号量）+ 总体超时（timeout）
  3. 自动重试（指数退避）
  4. 结果汇总并打印状态码 / 体长 / 耗时

运行：
  pip install aiohttp
  python async_fetch.py
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

import aiohttp


# ---------- 数据结构 ----------

@dataclass
class FetchResult:
    url: str
    status: int = 0
    length: int = 0
    elapsed: float = 0.0
    error: str | None = None
    retries: int = 0


@dataclass
class Fetcher:
    max_concurrency: int = 5          # 最大并发数
    per_request_timeout: float = 10.0 # 单个请求超时（秒）
    max_retries: int = 3              # 最大重试次数
    backoff: float = 0.5              # 退避基数（秒）
    results: list[FetchResult] = field(default_factory=list)

    async def _fetch_once(
        self,
        session: aiohttp.ClientSession,
        url: str,
    ) -> tuple[int, int]:
        async with session.get(url) as resp:
            body = await resp.read()  # 读取响应体以得到长度
            return resp.status, len(body)

    async def fetch(self, session: aiohttp.ClientSession, url: str) -> FetchResult:
        """抓取单个 URL，带重试与指数退避。"""
        result = FetchResult(url=url)
        semaphore = self._semaphore

        for attempt in range(self.max_retries + 1):
            try:
                async with semaphore:
                    start = time.perf_counter()
                    status, length = await asyncio.wait_for(
                        self._fetch_once(session, url),
                        timeout=self.per_request_timeout,
                    )
                    result.elapsed = time.perf_counter() - start
                result.status, result.length = status, length
                return result
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
                result.retries = attempt
                result.error = f"{type(exc).__name__}: {exc}"
                if attempt < self.max_retries:
                    await asyncio.sleep(self.backoff * (2 ** attempt))  # 指数退避
        return result

    async def run(self, urls: list[str]) -> list[FetchResult]:
        self._semaphore = asyncio.Semaphore(self.max_concurrency)
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            tasks = [self.fetch(session, url) for url in urls]
            self.results = await asyncio.gather(*tasks)
        return self.results


# ---------- 汇总打印 ----------

def report(results: list[FetchResult]) -> None:
    ok = [r for r in results if r.error is None]
    fail = [r for r in results if r.error is not None]

    for r in results:
        if r.error:
            print(f"[FAIL] {r.url} -> {r.error}")
        else:
            print(f"[ OK ] {r.url} -> status={r.status} len={r.length} "
                  f"elapsed={r.elapsed:.2f}s retries={r.retries}")

    print(f"\n成功 {len(ok)} / 失败 {len(fail)} / 总计 {len(results)}")


# ---------- 入口 ----------

URLS = [
    "https://httpbin.org/get",
    "https://httpbin.org/delay/2",
    "https://httpbin.org/status/200",
    "https://httpbin.org/status/404",
    "https://httpbin.org/status/500",
    # "https://httpbin.org/delay/20",  # 会触发单请求超时，可放开测试
]


def main() -> None:
    fetcher = Fetcher(max_concurrency=5, per_request_timeout=10, max_retries=2)
    start = time.perf_counter()
    results = asyncio.run(fetcher.run(URLS))
    report(results)
    print(f"总耗时 {time.perf_counter() - start:.2f}s")


if __name__ == "__main__":
    main()
