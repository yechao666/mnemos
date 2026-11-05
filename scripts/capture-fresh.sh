#!/usr/bin/env bash
# 逐个页面截图（每个页面使用独立 Chrome profile，规避 headless Chrome 的会话卡死）。
# 用法：bash scripts/capture-fresh.sh [baseUrl] [outDir]
set -uo pipefail

cd "$(dirname "$0")/.."
BASE="${1:-http://127.0.0.1:4380}"
OUT="${2:-docs/screenshots}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=9333

mkdir -p "$OUT" .chrome-home

launch() {
  pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true
  sleep 0.8
  local profile
  profile=$(mktemp -d "$PWD/.chrome-home/prof.XXXXXX")
  HOME="$PWD/.chrome-home" "$CHROME" \
    --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --disable-crash-reporter --disable-breakpad --no-sandbox \
    --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows --remote-debugging-port=${PORT} \
    --user-data-dir="$profile" --window-size=1600,1000 about:blank >/dev/null 2>&1 &
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/json/version" && { sleep 0.7; return 0; }
    sleep 0.25
  done
  return 1
}

shoot() {
  local path="$1" name="$2" attempt
  for attempt in 1 2 3; do
    node scripts/shot-one.mjs "$path" "$OUT/$name.png" "$BASE" >/dev/null 2>/tmp/mnemos-shot.err && {
      echo "  ✓ $name"
      return 0
    }
    echo "  … retry $name"
    launch
  done
  echo "  ✗ $name（$(tail -1 /tmp/mnemos-shot.err)）"
  return 1
}

login=$(curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"lin.wei@mnemos.dev","password":"mnemos-demo"}')
project=$(node -e '
  const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const me = body.token;
  fetch("'"$BASE"'/api/auth/me", { headers: { authorization: "Bearer " + me } })
    .then((r) => r.json())
    .then((d) => {
      const p = (d.projects || []).find((x) => x.slug === "orion-python") || (d.projects || [])[0];
      process.stdout.write(p ? p.id : "");
    });
' <<<"$login")

if [ -z "$project" ]; then
  echo "无法获取项目，请确认服务已启动：$BASE"
  exit 1
fi

echo "项目：$project"

launch

shoot /login 01-login
shoot / 02-dashboard
shoot /projects 03-projects
shoot "/projects/$project" 04-project-overview
shoot "/projects/$project/memories" 05-memories
shoot "/projects/$project/memories?q=%E5%B9%82%E7%AD%89" 06-memories-search
shoot "/projects/$project/graph" 07-graph
shoot "/projects/$project/agents" 08-agents
shoot "/projects/$project/tasks" 09-tasks
shoot "/projects/$project/playground" 10-playground
shoot "/projects/$project/keys" 11-keys
shoot "/projects/$project/usage" 12-usage
shoot "/projects/$project/audit" 13-audit
shoot "/projects/$project/settings" 14-settings
shoot "/projects/$project/docs" 15-docs
shoot /team 16-team
shoot /ops 17-ops
shoot "/projects/$project/webhooks" 18-webhooks

pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true
echo "完成：$OUT"
