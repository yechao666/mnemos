#!/usr/bin/env bash
# =============================================================================
# Mnemos 备份 / 恢复演练
# -----------------------------------------------------------------------------
# 步骤：
#   1. 前置检查：node、curl、服务健康
#   2. 登录管理账号（默认 lin.wei@mnemos.dev / mnemos-demo）
#   3. 调用 POST /api/ops/backup 创建在线备份；API 不可用时回退为
#      对源库执行 VACUUM INTO（只读，片段一致性由 SQLite 保证）
#   4. 校验备份：integrity_check、schema_version、memories/agents/tasks 计数
#      与源库一致
#   5. 迁移器演练：在备份副本上执行 migrate(openDatabase(...))
#   6. 恢复演练：备份复制到临时数据目录，起一次性服务（默认 4398），
#      /readyz 200 → 登录 → 查询 1 个项目 → 关闭
#   7. 清理临时文件（不修改 data/）
#
# 用法：
#   bash scripts/backup-restore-drill.sh
#   MNEMOS_BASE=http://127.0.0.1:4380 DRILL_PORT=4398 bash scripts/backup-restore-drill.sh
#
# 退出码：0 全部 PASS（允许 SKIP）；1 存在 FAIL。
# 注意：/api/ops/backup 属于较新的运维 API，未上线时脚本会自动回退到
#       VACUUM INTO，并明确标注。
# 前提：脚本与服务同机（或能访问同一数据目录/挂载卷），否则无法定位备份文件、
#       无法执行 VACUUM INTO；仅能走备份下载场景需自行扩展。
# 计数比对是严格相等：请尽量在低峰/维护窗口执行，避免演练期间的新写入造成误报。
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

BASE="${MNEMOS_BASE:-http://127.0.0.1:4380}"
BASE="${BASE%/}"
EMAIL="${MNEMOS_EMAIL:-lin.wei@mnemos.dev}"
PASSWORD="${MNEMOS_PASSWORD:-mnemos-demo}"
PORT="${DRILL_PORT:-4398}"
DATA_DIR="$(abspath "${MNEMOS_DATA_DIR:-data}")"
SOURCE_DB="$(abspath "${MNEMOS_DB_PATH:-$DATA_DIR/mnemos.db}")"
BACKUP_DIR="$(abspath "${MNEMOS_BACKUP_DIR:-$DATA_DIR/backups}")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mnemos-drill.XXXXXX")"
BASE2="http://127.0.0.1:$PORT"
START_MARKER="$WORK/start.marker"
TOKEN=""
SERVICE_PID=""
BACKUP_FILE=""
BACKUP_SOURCE=""

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf '  \033[32m✓ PASS\033[0m  %s%s\n' "$1" "${2:+  — $2}"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31m✗ FAIL\033[0m  %s%s\n' "$1" "${2:+  — $2}"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[33m- SKIP\033[0m  %s%s\n' "$1" "${2:+  — $2}"; }
warn() { printf '  \033[33m! WARN\033[0m  %s\n' "$1"; }

stop_service() {
  if [[ -n "${SERVICE_PID:-}" ]] && kill -0 "$SERVICE_PID" 2>/dev/null; then
    kill -TERM "$SERVICE_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$SERVICE_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$SERVICE_PID" 2>/dev/null || true
  fi
  SERVICE_PID=""
}

cleanup() {
  stop_service
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

json_get() {
  local file="$1"
  local expr="$2"
  FILE="$file" EXPR="$expr" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    let data;
    try {
      data = JSON.parse(readFileSync(process.env.FILE, "utf8"));
    } catch {
      process.exit(1);
    }
    let value = data;
    for (const key of process.env.EXPR.split(".")) {
      if (value === null || value === undefined) break;
      value = value[key];
    }
    if (typeof value === "string") process.stdout.write(value);
    else if (typeof value === "number" || typeof value === "boolean") process.stdout.write(String(value));
    else if (value && typeof value === "object") process.stdout.write(JSON.stringify(value));
  '
}

# 只读查询：优先 sqlite3，缺失时回退 node:sqlite。
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

http_code() {
  curl -sS -o "$1" -w '%{http_code}' --max-time 10 "${@:2}" 2>/dev/null || printf '000'
}

count_of() {
  local db="$1"
  local table="$2"
  query_db "$db" "SELECT COUNT(*) FROM $table;" 2>/dev/null | head -n 1 | tr -d '[:space:]'
}

echo ""
echo "Mnemos 备份 / 恢复演练"
echo "  服务      $BASE"
echo "  源库      $SOURCE_DB"
echo "  临时目录  $WORK"
echo ""

# --- 1. 前置检查 -------------------------------------------------------------
for command_name in node curl; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "依赖命令：$command_name"
  else
    fail "依赖命令：$command_name" "未安装"
  fi
done
if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "缺少依赖，终止演练。"
  exit 1
fi

HEALTH_CODE="$(http_code "$WORK/health.json" "$BASE/api/health")"
if [[ "$HEALTH_CODE" == "200" ]] && [[ "$(json_get "$WORK/health.json" ok 2>/dev/null)" == "true" ]]; then
  pass "服务健康检查" "$BASE/api/health 200 (ok=true)"
else
  fail "服务健康检查" "HTTP ${HEALTH_CODE}；请先启动服务（node server/src/main.ts）"
  echo ""
  echo "服务未就绪，终止演练。"
  exit 1
fi

if [[ ! -f "$SOURCE_DB" ]]; then
  warn "源库不可访问：${SOURCE_DB}（将跳过与源库的计数比对）"
fi

# --- 2. 登录（获取 admin 会话） ----------------------------------------------
LOGIN_CODE="$(http_code "$WORK/login.json" -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
if [[ "$LOGIN_CODE" == "200" ]]; then
  TOKEN="$(json_get "$WORK/login.json" token 2>/dev/null || true)"
fi

if [[ -n "$TOKEN" ]]; then
  pass "管理员登录" "$EMAIL"
else
  skip "管理员登录" "HTTP ${LOGIN_CODE}（无会话令牌，将只走本地 VACUUM INTO 回退）"
fi

touch "$START_MARKER"

# --- 3. 创建备份 -------------------------------------------------------------
create_backup_via_api() {
  local code
  code="$(http_code "$WORK/backup.json" -X POST "$BASE/api/ops/backup" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d '{"reason":"backup-restore-drill"}')"

  # 部分实现不接受请求体，再试一次不带 body
  if [[ "$code" == "400" || "$code" == "415" ]]; then
    code="$(http_code "$WORK/backup.json" -X POST "$BASE/api/ops/backup" \
      -H "authorization: Bearer $TOKEN")"
  fi

  case "$code" in
    200|201|202)
      local candidate
      candidate="$(json_get "$WORK/backup.json" path 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$(json_get "$WORK/backup.json" file 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$(json_get "$WORK/backup.json" backup.path 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$(json_get "$WORK/backup.json" backup.file 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$(json_get "$WORK/backup.json" backupPath 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$(json_get "$WORK/backup.json" filename 2>/dev/null || true)"
      [[ -n "$candidate" ]] || candidate="$(json_get "$WORK/backup.json" name 2>/dev/null || true)"

      # 相对路径依次尝试：仓库根、备份目录
      if [[ -n "$candidate" ]]; then
        if [[ ! -f "$candidate" ]]; then
          [[ -f "$ROOT/$candidate" ]] && candidate="$ROOT/$candidate"
          [[ ! -f "$candidate" && -f "$BACKUP_DIR/$candidate" ]] && candidate="$BACKUP_DIR/$candidate"
        fi
        if [[ -f "$candidate" ]]; then
          BACKUP_FILE="$candidate"
          BACKUP_SOURCE="POST /api/ops/backup"
          return 0
        fi
      fi

      # 响应没给路径：在备份目录里找本次演练后生成的最新 .db
      if [[ -d "$BACKUP_DIR" ]]; then
        local newest=""
        local file
        for file in "$BACKUP_DIR"/*.db; do
          [[ -f "$file" ]] || continue
          if [[ "$file" -nt "$START_MARKER" ]]; then
            if [[ -z "$newest" || "$file" -nt "$newest" ]]; then
              newest="$file"
            fi
          fi
        done
        if [[ -n "$newest" ]]; then
          BACKUP_FILE="$newest"
          BACKUP_SOURCE="POST /api/ops/backup（按备份目录最新文件定位）"
          return 0
        fi
      fi
      return 1
      ;;
    404|405|501|000)
      warn "备份 API 不可用（HTTP ${code}），回退到 VACUUM INTO"
      return 1
      ;;
    401|403)
      warn "备份 API 鉴权失败（HTTP ${code}），回退到 VACUUM INTO"
      return 1
      ;;
    *)
      warn "备份 API 返回 HTTP ${code}，回退到 VACUUM INTO"
      return 1
      ;;
  esac
}

create_backup_via_vacuum() {
  local target="$WORK/fallback.db"
  if [[ ! -f "$SOURCE_DB" ]]; then
    return 1
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    local escaped="${target//\'/\'\'}"
    sqlite3 -readonly "$SOURCE_DB" "VACUUM INTO '$escaped';" >/dev/null 2>&1 || return 1
  else
    SRC_DB="$SOURCE_DB" OUT_DB="$target" node --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const source = new DatabaseSync(process.env.SRC_DB, { readOnly: true });
      try {
        source.prepare("VACUUM INTO ?").run(process.env.OUT_DB);
      } finally {
        source.close();
      }
    ' || return 1
  fi
  [[ -s "$target" ]] || return 1
  BACKUP_FILE="$target"
  BACKUP_SOURCE="VACUUM INTO（本地源库只读副本）"
}

if [[ -n "$TOKEN" ]] && create_backup_via_api; then
  pass "创建备份" "$BACKUP_SOURCE → $BACKUP_FILE"
elif create_backup_via_vacuum; then
  skip "创建备份 API" "已回退为 VACUUM INTO"
  pass "创建备份（回退）" "$BACKUP_SOURCE → $BACKUP_FILE"
else
  fail "创建备份" "API 与 VACUUM INTO 均失败（源库：${SOURCE_DB}）"
fi

if [[ "$FAIL" -gt 0 || -z "$BACKUP_FILE" ]]; then
  echo ""
  echo "备份创建失败，终止演练。"
  exit 1
fi

BACKUP_SIZE="$(wc -c <"$BACKUP_FILE" | tr -d '[:space:]')"
if [[ "${BACKUP_SIZE:-0}" -gt 0 ]]; then
  pass "备份文件非空" "$(awk -v bytes="$BACKUP_SIZE" 'BEGIN { printf "%.1f MB", bytes / 1048576 }')"
else
  fail "备份文件非空" "$BACKUP_FILE 大小为 0"
fi

# --- 4. 校验备份 -------------------------------------------------------------
INTEGRITY="$(query_db "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1 | head -n 1 || true)"
if [[ "$INTEGRITY" == "ok" ]]; then
  pass "备份完整性" "PRAGMA integrity_check = ok"
else
  fail "备份完整性" "integrity_check：${INTEGRITY:-无输出}"
fi

SCHEMA_VERSION="$(query_db "$BACKUP_FILE" "SELECT value FROM meta WHERE key = 'schema_version';" 2>/dev/null | head -n 1 || true)"
if [[ "$SCHEMA_VERSION" =~ ^[0-9]+$ ]] && [[ "$SCHEMA_VERSION" -gt 0 ]]; then
  pass "备份 schema_version" "版本 $SCHEMA_VERSION"
else
  fail "备份 schema_version" "无法读取（得到：${SCHEMA_VERSION:-空}）"
fi

TABLE_COUNTS_OK=1
for table_name in memories agents tasks; do
  backup_count="$(count_of "$BACKUP_FILE" "$table_name" || true)"
  if [[ ! "$backup_count" =~ ^[0-9]+$ ]]; then
    fail "备份计数：$table_name" "无法读取"
    TABLE_COUNTS_OK=0
    continue
  fi
  pass "备份计数：$table_name" "$backup_count"
done

if [[ -f "$SOURCE_DB" ]]; then
  for table_name in memories agents tasks; do
    source_count="$(count_of "$SOURCE_DB" "$table_name" || true)"
    backup_count="$(count_of "$BACKUP_FILE" "$table_name" || true)"
    if [[ ! "$source_count" =~ ^[0-9]+$ || ! "$backup_count" =~ ^[0-9]+$ ]]; then
      skip "源库/备份计数比对：$table_name" "读取失败"
      continue
    fi
    if [[ "$source_count" == "$backup_count" ]]; then
      pass "源库/备份计数一致：$table_name" "$source_count 条"
    else
      fail "源库/备份计数一致：$table_name" "源库 $source_count ≠ 备份 $backup_count"
    fi
  done
else
  skip "源库/备份计数比对" "源库不可访问：$SOURCE_DB"
fi

# --- 5. 迁移器演练 -----------------------------------------------------------
cp "$BACKUP_FILE" "$WORK/migrate.db"
if MIGRATE_OUT="$(MNEMOS_DRILL_DB="$WORK/migrate.db" node --input-type=module -e '
  import { getSchemaVersion, migrate, openDatabase } from "./server/src/db/index.ts";
  const db = openDatabase(process.env.MNEMOS_DRILL_DB);
  try {
    migrate(db);
    const version = getSchemaVersion(db);
    if (!Number.isInteger(version) || version <= 0) {
      console.error("schema_version 非法：" + version);
      process.exit(1);
    }
    console.log("migrate ok, schema_version=" + version);
  } finally {
    db.close();
  }
' 2>&1)"; then
  pass "迁移器演练" "$MIGRATE_OUT"
else
  fail "迁移器演练" "${MIGRATE_OUT:-迁移执行失败}"
fi

# --- 6. 恢复演练 -------------------------------------------------------------
port_free() {
  PORT="$PORT" node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.env.PORT), "127.0.0.1", () => server.close(() => process.exit(0)));
  ' 2>/dev/null
}

if ! port_free; then
  skip "恢复演练" "端口 $PORT 已被占用（可用 DRILL_PORT 指定其他端口）"
else
  RESTORE_DIR="$WORK/restore-data"
  mkdir -p "$RESTORE_DIR"
  cp "$BACKUP_FILE" "$RESTORE_DIR/mnemos.db"
  rm -f "$RESTORE_DIR/mnemos.db-wal" "$RESTORE_DIR/mnemos.db-shm"

  (
    cd "$ROOT"
    exec env \
      NODE_ENV=test \
      MNEMOS_HOST=127.0.0.1 \
      MNEMOS_PORT="$PORT" \
      MNEMOS_DATA_DIR="$RESTORE_DIR" \
      MNEMOS_DB_PATH="$RESTORE_DIR/mnemos.db" \
      MNEMOS_DEMO=0 \
      node server/src/main.ts
  ) >"$WORK/service.log" 2>&1 &
  SERVICE_PID=$!

  READY_ENDPOINT=""
  READY_CODE=""
  for _ in $(seq 1 300); do
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
      break
    fi
    READY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE2/readyz" 2>/dev/null || true)"
    if [[ "$READY_CODE" == "200" ]]; then
      READY_ENDPOINT="/readyz"
      break
    fi
    if [[ "$READY_CODE" == "404" ]]; then
      READY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE2/api/health" 2>/dev/null || true)"
      if [[ "$READY_CODE" == "200" ]]; then
        READY_ENDPOINT="/api/health"
        break
      fi
    fi
    sleep 0.2
  done

  if [[ -n "$READY_ENDPOINT" ]]; then
    if [[ "$READY_ENDPOINT" == "/readyz" ]]; then
      pass "恢复服务就绪" "$BASE2/readyz 200"
    else
      skip "恢复服务 /readyz" "返回 404，已回退以 $BASE2/api/health 200 判定"
      pass "恢复服务就绪" "$BASE2/api/health 200"
    fi

    # 登录恢复实例：优先重新登录；失败则复用主实例会话（备份中包含 sessions 表）
    RESTORE_TOKEN=""
    RESTORE_LOGIN_CODE="$(http_code "$WORK/restore-login.json" -X POST "$BASE2/api/auth/login" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
    if [[ "$RESTORE_LOGIN_CODE" == "200" ]]; then
      RESTORE_TOKEN="$(json_get "$WORK/restore-login.json" token 2>/dev/null || true)"
    fi
    if [[ -z "$RESTORE_TOKEN" && -n "$TOKEN" ]]; then
      RESTORE_TOKEN="$TOKEN"
    fi

    if [[ -z "$RESTORE_TOKEN" ]]; then
      fail "恢复实例查询项目" "无法获得会话令牌（登录 HTTP ${RESTORE_LOGIN_CODE}）"
    else
      PROJECTS_CODE="$(http_code "$WORK/restore-projects.json" "$BASE2/api/projects" \
        -H "authorization: Bearer $RESTORE_TOKEN")"
      if [[ "$PROJECTS_CODE" == "200" ]]; then
        PROJECT_ID="$(json_get "$WORK/restore-projects.json" '0.id' 2>/dev/null || true)"
        PROJECT_NAME="$(json_get "$WORK/restore-projects.json" '0.name' 2>/dev/null || true)"
        if [[ -z "$PROJECT_ID" ]]; then
          fail "恢复实例查询项目" "项目列表为空"
        else
          OVERVIEW_CODE="$(http_code "$WORK/restore-overview.json" \
            "$BASE2/api/projects/$PROJECT_ID/overview" \
            -H "authorization: Bearer $RESTORE_TOKEN")"
          if [[ "$OVERVIEW_CODE" == "200" ]]; then
            pass "恢复实例查询项目" "${PROJECT_NAME:-$PROJECT_ID} 概览 200"
          else
            fail "恢复实例查询项目" "概览接口返回 HTTP $OVERVIEW_CODE"
          fi
        fi
      else
        fail "恢复实例查询项目" "项目列表返回 HTTP $PROJECTS_CODE"
      fi
    fi
  else
    fail "恢复演练" "临时服务在 60s 内未就绪（最后 HTTP ${READY_CODE:-无响应}）"
    echo ""
    echo "  --- 临时服务日志（末尾 30 行）---"
    tail -n 30 "$WORK/service.log" 2>/dev/null | sed 's/^/  /' || true
    echo ""
  fi

  stop_service
fi

# --- 7. 汇总 ----------------------------------------------------------------
TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo "────────────────────────────────────────────────────────────"
printf '  结果   %d 项：PASS %d / FAIL %d / SKIP %d\n' "$TOTAL" "$PASS" "$FAIL" "$SKIP"
echo "  备份    ${BACKUP_SOURCE:-无}"
echo "────────────────────────────────────────────────────────────"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "恢复演练未通过。"
  exit 1
fi

if [[ "$SKIP" -gt 0 ]]; then
  echo "恢复演练通过（含 SKIP 项，请确认是否符合预期）。"
else
  echo "恢复演练全部通过。"
fi
exit 0
