"""Python SDK 基础示例：写入记忆 → 构建任务简报 → 混合检索。

运行（仓库根目录）：
    python3 sdk/python/examples/basic.py

环境变量：
    MNEMOS_BASE_URL  默认 http://127.0.0.1:4380
    MNEMOS_API_KEY   默认使用演示项目 Atlas 的 Key
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from mnemos_sdk import MnemosApiError, MnemosClient
except ModuleNotFoundError:  # 仓库内直接运行示例时，把 sdk/python 加入路径
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from mnemos_sdk import MnemosApiError, MnemosClient


def main() -> None:
    api_key = os.environ.get("MNEMOS_API_KEY", "mnemos_live_demo_atlas_ci")
    base_url = os.environ.get("MNEMOS_BASE_URL", "http://127.0.0.1:4380")
    client = MnemosClient(api_key, base_url=base_url)
    print(f"→ 连接 Mnemos：{base_url}")

    # 1. 写入一条记忆
    added = client.memories.add(
        messages=[
            {
                "role": "user",
                "content": "我负责订单查询服务，评审时希望重点关注分片键与只读副本的一致性。",
            }
        ],
        user_id="sdk-example-user",
        metadata={"example": "basic", "channel": "sdk-python"},
        infer=False,
    )
    memory = added.results[0] if added.results else None
    if memory is not None:
        print(f"✓ 写入成功：{memory.id}（{added.took_ms:g}ms）")
        print(f"  正文：{memory.content}")

    # 2. 构建任务简报
    briefing = client.context.build(query="订单查询服务 分片键 评审", budget_tokens=800)
    hit_count = sum(len(section.hits) for section in briefing.sections)
    print(
        f"✓ 简报完成：{len(briefing.sections)} 个分区 / {hit_count} 条命中 / "
        f"约 {briefing.token_estimate} tokens"
    )
    for section in briefing.sections:
        if section.hits:
            print(f"  · {section.title}：{len(section.hits)} 条")

    # 3. 混合检索
    search = client.memories.search("查询服务评审关注点", user_id="sdk-example-user", top_k=3, threshold=0.1)
    strategy = search.signals.get("strategy", "default")
    print(f"✓ 检索完成：{len(search.results)} 条命中（{search.took_ms:g}ms，策略 {strategy}）")
    for hit in search.results:
        print(f"  - [{hit.score:.3f}] {hit.content}")


if __name__ == "__main__":
    try:
        main()
    except MnemosApiError as error:
        print(f"✗ API 错误：HTTP {error.status} {error.code} — {error.message}", file=sys.stderr)
        if error.request_id:
            print(f"  requestId: {error.request_id}", file=sys.stderr)
        if error.details is not None:
            print(f"  details: {error.details}", file=sys.stderr)
        sys.exit(1)
