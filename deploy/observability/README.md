# 本地可观测性栈

Prometheus + Grafana + OpenTelemetry Collector 的最小本地组合，用于验证 Mnemos 的
`/metrics` 与 OTLP trace。**Mnemos 不在这个 Compose 里**，以宿主机进程方式运行，
默认监听 `127.0.0.1:4380`。

> ⚠️ 本机没有安装 Docker，以下 Compose 配置**未做真机启动验证**；镜像版本、挂载路径
> 与端口按官方文档编写。仅限本地使用，Grafana 的 `admin/admin` 不要用于生产。

## 1. 组件与端口

| 组件 | 端口 | 用途 |
| --- | --- | --- |
| Prometheus | `9090` | 每 15s 抓取宿主机 `:4380/metrics`，加载 `deploy/prometheus/alerts.yml` |
| Grafana | `3000` | 预置 Prometheus 数据源与 `Mnemos Overview` 仪表盘（深色主题） |
| OTel Collector | `4318` | OTLP/HTTP 接收 trace，`debug` exporter 输出到容器日志 |

## 2. 启动

在仓库根目录执行三条命令（前两条分别启动观测栈与 Mnemos，第三条验证进程存活）：

```bash
# 1) 启动观测栈
cd deploy/observability && docker compose up -d

# 2) 回到仓库根目录启动 Mnemos，并打开 trace 导出
cd ../.. && \
  MNEMOS_HOST=0.0.0.0 \
  MNEMOS_OTEL_ENABLED=1 \
  MNEMOS_OTEL_ENDPOINT=http://127.0.0.1:4318/v1/traces \
  MNEMOS_OTEL_SAMPLE_RATE=1 \
  pnpm start

# 3) 验证 Mnemos 存活（另开一个终端）
curl -s http://127.0.0.1:4380/healthz
```

> `MNEMOS_HOST=0.0.0.0` 是为了让 Prometheus 容器能通过 `host.docker.internal:4380`
> 抓取宿主机端口。只在可信的本地网络这样做，并注意本机防火墙。
> 如果 Mnemos 也放进同一个 Compose 网络，则把 `deploy/prometheus/prometheus.yml`
> 的 targets 改为 `mnemos:4380`，并把 OTLP endpoint 改为 `http://otel-collector:4318/v1/traces`。

## 3. 验证 trace

访问一个 API 触发 span（探针 `/healthz`、`/readyz`、`/metrics`、`/api/health`
已在 instrumentation 中忽略，不会产生 trace）：

```bash
curl -s -X POST http://127.0.0.1:4380/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"lin.wei@mnemos.dev","password":"mnemos-demo"}'
```

查看 collector 日志，应能看到 `POST` / `GET` 的 span（含 `http.request.method`、
`url.path`、`http.response.status_code` 等属性）：

```bash
docker compose -f deploy/observability/docker-compose.yml logs -f otel-collector
```

也可以直接比较 `x-request-id` 与 traceId：响应头里有 `x-request-id`，该 id 会写入 Mnemos
结构化日志；traceId 从 collector 输出中获取。当前日志**还没有**注入 traceId（见
[`docs/observability.md`](../../docs/observability.md) 的已知限制）。

## 4. 打开 Grafana / Prometheus

- Grafana：<http://localhost:3000>，账号 `admin` / `admin`（仅本地）。
  数据源 URL 由 `PROMETHEUS_URL` 注入；单独运行 Grafana（不使用本 Compose）时需要
  自行设置该环境变量为 `http://prometheus:9090`（或实际的 Prometheus 地址）。
  侧边栏 **Dashboards → Mnemos → Mnemos Overview**；右上角变量可选 `instance` 与 `route`。
- Prometheus：<http://localhost:9090>，在 **Status → Targets** 确认 `mnemos` 为 `UP`；
  在 **Alerts** 查看 `mnemos.rules` 告警状态。

## 5. 排障

| 现象 | 检查 |
| --- | --- |
| Prometheus target `DOWN` | Mnemos 是否以 `MNEMOS_HOST=0.0.0.0` 启动；宿主机 `curl localhost:4380/metrics`；`host.docker.internal` 是否可达 |
| Grafana 面板全空 | 数据源 URL 是否指向 Prometheus；`PROMETHEUS_URL` 是否设置正确；变量 `instance` 是否选到实例 |
| Collector 无 trace | `MNEMOS_OTEL_ENABLED=1`；endpoint 是否包含 `/v1/traces`；`curl -v localhost:4318/v1/traces` 看端口；collector 日志级别 |
| 重启后 Grafana 配置未更新 | provisioning 只在启动时读取；`docker compose restart grafana` |

## 6. 清理

```bash
docker compose -f deploy/observability/docker-compose.yml down
# 连数据卷一起删除（会清空本地 Prometheus/Grafana 数据）
docker compose -f deploy/observability/docker-compose.yml down -v
```
