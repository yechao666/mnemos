#!/usr/bin/env python3
"""Mnemos v6.1 Python SDK 可运行示例。

准备一个运行中的 Mnemos（默认 http://127.0.0.1:4380）、一个分区（如 ws-demo）
和至少带 memories:read / memories:write 的 API Key，然后：

    MNEMOS_API_KEY=mnemos_live_… \
    MNEMOS_BASE_URL=http://127.0.0.1:4380 \
    MNEMOS_PARTITION=ws-demo \
    python3 sdk/python/examples/basic.py

脚本会：建人 → 写记忆（含去重事件）→ 检索 → 历史/反馈 → 简报/上下文 → 统计。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 未安装 SDK 时也能从仓库直接运行。
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mnemos import MnemosApiError, MnemosClient, MnemosNetworkError  # noqa: E402


def main() -> int:
    api_key = os.environ.get("MNEMOS_API_KEY")
    if not api_key:
        print("请先设置 MNEMOS_API_KEY（mnemos_live_…）", file=sys.stderr)
        return 2

    partition = os.environ.get("MNEMOS_PARTITION", "ws-demo")
    person_id = os.environ.get("MNEMOS_PERSON", "example-user")
    client = MnemosClient(api_key=api_key, base_url=os.environ.get("MNEMOS_BASE_URL"), partition=partition)

    try:
        client.health()
        print(f"✔ 服务可达：{client.base_url}")

        person = client.persons.upsert(
            person_id,
            type="human",
            display_name="示例用户",
            attributes={"from": "sdk-python-example"},
        )
        print(f"✔ 人：{person.id} ({person.external_id})")

        first = client.memories.add(
            person_id,
            text="示例用户偏好中文回复，先看结论再看细节。",
            scope="partition",
            category="preference",
            importance=0.8,
            tags=["示例", "偏好"],
        )
        print(f"✔ 写入：event={first.event} memory={first.memory.id}")

        # 完全重复写入会得到 NOOP，不会新增。
        duplicate = client.memories.add(person_id, text="示例用户偏好中文回复，先看结论再看细节。")
        print(f"✔ 重复写入：event={duplicate.event} memory={duplicate.memory.id}")

        # 同 fact_key 写入会取代旧事实。
        updated = client.memories.add(
            person_id,
            text="示例用户偏好英文回复。",
            fact_key="preference.language",
            supersedes_id=first.memory.id,
        )
        print(f"✔ 取代：event={updated.event} superseded={updated.superseded_id}")

        response = client.memories.search("回复偏好", top_k=5)
        print(f"✔ 检索：mode={response.mode} took={response.took_ms}ms strategy={response.strategy}")
        for hit in response.hits:
            signals = hit.signals
            print(
                f"  - {hit.score:.3f} vector={signals.vector:.2f} keyword={signals.keyword:.2f}"
                f" {hit.content}"
            )

        if response.hits:
            history = client.memories.history(response.hits[0].id)
            print(f"✔ 历史：{[entry.event for entry in history]}")
            feedback = client.memories.feedback(response.hits[0].id, True, query="回复偏好")
            print(f"✔ 反馈：up={feedback.feedback_up} confidence={feedback.confidence:.2f}")

        brief = client.brief(person_id, max_chars=400)
        print(f"✔ 简报（{brief.count} 条，cached={brief.cached}）：\n{brief.text}")

        context = client.context(person_id, query="回复偏好", budget_tokens=600)
        print(f"✔ 上下文：token≈{context.token_estimate} citations={context.citations}")
        print(context.prompt)

        stats = client.stats()
        print(
            f"✔ 分区统计：人 {stats.persons_total} / 记忆 {stats.memories_total}"
            f" / 共享 {stats.shared_total}"
        )
        return 0
    except MnemosApiError as error:
        print(f"✘ API 错误：{error}", file=sys.stderr)
        return 1
    except MnemosNetworkError as error:
        print(f"✘ 网络错误：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
