#!/usr/bin/env bash
# =============================================================================
# Mnemos 启动前预检
# -----------------------------------------------------------------------------
# 在启动/升级服务之前运行，逐项检查运行环境是否满足生产要求：
#   1. Node.js ≥ 22.18（原生 TypeScript 与 node:sqlite 需要）
#   2. 数据目录存在且可写
#   3. 备份目录存在且可写
#   4. 监听端口可用
#   5. 数据库完整性（存在时）：PRAGMA integrity_check + schema_version
#   6. 数据目录所在分区剩余空间 ≥ 1GB
#
# 用法：
#   bash scripts/preflight.sh
#   MNEMOS_DATA_DIR=/var/lib/mnemos MNEMOS_PORT=4380 bash scripts/preflight.sh
#
# 退出码：0 全部通过（允许 SKIP）；1 存在 FAIL。
# 本脚本只读：不会创建、迁移或修改数据库。
# =============================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

abspath() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s' "$ROOT/$1" ;;
  esac
}

HOST="${MNEMOS_HOST:-127.0.0.1}"
PORT="${MNEMOS_PORT:-4380}"
DATA_DIR="$(abspath "${MNEMOS_DATA_DIR:-data}")"
BACKUP_DIR="$(abspath "${MNEMOS_BACKUP_DIR:-$DATA_DIR/backups}")"
DB_PATH="$(abspath "${MNEMOS_DB_PATH:-$DATA_DIR/mnemos.db}")"
MIN_NODE="22.18.0"
MIN_DISK_KB=$((1024 * 1024)) # 1 GB

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf '  \033[32m✓ PASS\033[0m  %s%s\n' "$1" "${2:+  — $2}"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31m✗ FAIL\033[0m  %s%s\n' "$1" "${2:+  — $2}"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[33m- SKIP\033[0m  %s%s\n' "$1" "${2:+  — $2}"; }

# 数据库查询：优先 sqlite3，缺失时回退 node:sqlite（只读）。
query_db() {
  local db="$1"
  local sql="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -readonly -batch "$db" "$sql"
  else
    DB_PATH="$db" SQL="$sql" node --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
      try {
        const rows = db.prepare(process.env.SQL).all();
        for (const row of rows) {
          console.log(Object.values(row).map((value) => (value === null ? "" : String(value))).join("\t"));
        }
      } finally {
        db.close();
      }
    '
  fi
}

port_free() {
  HOST="$HOST" PORT="$PORT" node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.once("error", (error) => {
      console.error(error.code ?? error.message);
      process.exit(1);
    });
    server.listen(Number(process.env.PORT), process.env.HOST, () => {
      server.close(() => process.exit(0));
    });
  ' 2>/dev/null
}

echo ""
echo "Mnemos 启动前预检"
echo "  数据目录  $DATA_DIR"
echo "  数据库    $DB_PATH"
echo "  备份目录  $BACKUP_DIR"
echo "  监听      $HOST:$PORT"
echo ""

# --- 1. Node.js 版本 ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js" "未安装 node（需要 ≥ ${MIN_NODE}）"
else
  NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//')"
  if NODE_VERSION="$NODE_VERSION" MIN_NODE="$MIN_NODE" node --input-type=module -e '
    const parse = (text) => text.split(".").map((part) => Number(part));
    const [a, b, c] = parse(process.env.NODE_VERSION);
    const [x, y, z] = parse(process.env.MIN_NODE);
    const ok = a > x || (a === x && (b > y || (b === y && c >= z)));
    process.exit(ok ? 0 : 1);
  '; then
    pass "Node.js" "v${NODE_VERSION}（≥ ${MIN_NODE}）"
  else
    fail "Node.js" "v$NODE_VERSION 低于要求 $MIN_NODE"
  fi
fi

# --- 2. 数据目录 -------------------------------------------------------------
if [[ ! -d "$DATA_DIR" ]]; then
  fail "数据目录" "不存在：${DATA_DIR}（可执行 mkdir -p \"$DATA_DIR\"）"
elif [[ -w "$DATA_DIR" ]]; then
  pass "数据目录可写" "$DATA_DIR"
else
  fail "数据目录可写" "当前用户无权写入：$DATA_DIR"
fi

# --- 3. 备份目录 -------------------------------------------------------------
if [[ ! -d "$BACKUP_DIR" ]]; then
  fail "备份目录" "不存在：${BACKUP_DIR}（可执行 mkdir -p \"$BACKUP_DIR\"）"
elif [[ -w "$BACKUP_DIR" ]]; then
  pass "备份目录可写" "$BACKUP_DIR"
else
  fail "备份目录可写" "当前用户无权写入：$BACKUP_DIR"
fi

# --- 4. 端口 -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  skip "端口可用性" "缺少 node，无法检测"
elif port_free; then
  pass "端口可用" "$HOST:$PORT 未被占用"
else
  fail "端口可用" "$HOST:$PORT 已被占用（若服务已在运行属正常，但预检应在启动前执行）"
fi

# --- 5. 数据库完整性 ---------------------------------------------------------
if [[ ! -f "$DB_PATH" ]]; then
  skip "数据库完整性" "数据库尚不存在，首次启动会创建：$DB_PATH"
else
  if ! command -v sqlite3 >/dev/null 2>&1; then
    DB_NOTE="（使用 node:sqlite）"
  else
    DB_NOTE=""
  fi

  if INTEGRITY="$(query_db "$DB_PATH" "PRAGMA integrity_check;" 2>&1)" && [[ "$INTEGRITY" == "ok" ]]; then
    pass "数据库完整性" "PRAGMA integrity_check = ok $DB_NOTE"
  else
    fail "数据库完整性" "integrity_check 返回：${INTEGRITY:-无输出}"
  fi

  if SCHEMA_VERSION="$(query_db "$DB_PATH" "SELECT value FROM meta WHERE key = 'schema_version';" 2>&1)"; then
    if [[ "$SCHEMA_VERSION" =~ ^[0-9]+$ ]] && [[ "$SCHEMA_VERSION" -gt 0 ]]; then
      pass "schema_version" "当前版本 $SCHEMA_VERSION"
    else
      fail "schema_version" "无法读取有效版本（得到：${SCHEMA_VERSION:-空}）"
    fi
  else
    fail "schema_version" "读取 meta 表失败：$SCHEMA_VERSION"
  fi
fi

# --- 6. 磁盘空间 -------------------------------------------------------------
DISK_CHECK_TARGET="$DATA_DIR"
[[ -d "$DISK_CHECK_TARGET" ]] || DISK_CHECK_TARGET="$ROOT"
if AVAILABLE_KB="$(df -Pk "$DISK_CHECK_TARGET" 2>/dev/null | awk 'NR==2 {print $4}')" && [[ -n "${AVAILABLE_KB:-}" ]]; then
  AVAILABLE_HUMAN="$(awk -v kb="$AVAILABLE_KB" 'BEGIN { printf "%.1f GB", kb / 1048576 }')"
  if [[ "$AVAILABLE_KB" -ge "$MIN_DISK_KB" ]]; then
    pass "磁盘空间" "$AVAILABLE_HUMAN 可用（阈值 1 GB）"
  else
    fail "磁盘空间" "仅 $AVAILABLE_HUMAN 可用（阈值 1 GB）"
  fi
else
  skip "磁盘空间" "无法读取 $DISK_CHECK_TARGET 的可用空间"
fi

# --- 汇总 --------------------------------------------------------------------
TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo "────────────────────────────────────────────────────────────"
printf '  结果   %d 项：PASS %d / FAIL %d / SKIP %d\n' "$TOTAL" "$PASS" "$FAIL" "$SKIP"
echo "────────────────────────────────────────────────────────────"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "预检未通过：请先修复上述 FAIL 项再启动服务。"
  exit 1
fi

echo "预检通过，可以启动：node server/src/main.ts"
exit 0
