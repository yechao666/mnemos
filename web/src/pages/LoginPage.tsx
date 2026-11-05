import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { APP_NAME, APP_TAGLINE, APP_VERSION, DEMO_ACCOUNTS } from '@shared';
import { ROLE_LABEL, toneForRole } from '@lib/tone.ts';
import { api, ApiError } from '@lib/api.ts';
import { useAuth } from '@lib/auth.tsx';
import { useAsync, useDocumentTitle, useInterval } from '@lib/hooks.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Icon,
  IconButton,
  Input,
  useToast,
  type Tone,
} from '@ui';

const VALUE_POINTS = [
  {
    tone: 'violet',
    icon: 'layers',
    title: '多项目隔离',
    desc: '记忆、密钥与用量按项目强制隔离，互不串味。',
  },
  {
    tone: 'cyan',
    icon: 'brain',
    title: '混合检索可解释',
    desc: '语义、关键词、实体与时效加权融合，命中信号逐条可查。',
  },
  {
    tone: 'amber',
    icon: 'shield',
    title: '企业级治理与审计',
    desc: '权限按项目授予，写操作全量留痕，审计可回放。',
  },
] as const;

type LoginIssueKind = 'generic' | 'locked' | 'rate' | 'disabled';

interface LoginIssue {
  kind: LoginIssueKind;
  tone: Tone;
  message: string;
  /** 锁定或限流的截止时间；存在时提交按钮禁用 */
  blockedUntil?: number;
}

const LOCK_FALLBACK_MS = 15 * 60 * 1000;

function readDetailNumber(details: unknown, keys: string[]): number | null {
  if (!details || typeof details !== 'object') return null;
  const record = details as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function readDetailBoolean(details: unknown, key: string): boolean {
  if (!details || typeof details !== 'object') return false;
  return (details as Record<string, unknown>)[key] === true;
}

function readDetailString(details: unknown, keys: string[]): string | null {
  if (!details || typeof details !== 'object') return null;
  const record = details as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** 解析登录错误：把状态码与 details 归一为可直接展示的中文提示。 */
function describeLoginError(error: unknown): LoginIssue {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'generic',
      tone: 'red',
      message: error instanceof Error ? error.message : '登录失败，请稍后重试。',
    };
  }

  const code = error.code.toLowerCase();
  const details = error.details;

  if (code.includes('disabled') || code === 'account_disabled') {
    return {
      kind: 'disabled',
      tone: 'red',
      message: '账号已被管理员禁用，请联系组织管理员恢复访问。',
    };
  }

  if (error.status === 423 || code.includes('locked')) {
    const lockedUntil = readDetailString(details, ['lockedUntil', 'locked_until']);
    const parsed = lockedUntil ? Date.parse(lockedUntil) : Number.NaN;
    const retrySeconds = readDetailNumber(details, ['retryAfterSeconds', 'retry_after_seconds', 'retryAfter']);
    const remainingMinutes = readDetailNumber(details, ['remainingMinutes', 'remaining_minutes']);
    let until = Number.isFinite(parsed) ? parsed : Number.NaN;
    if (!Number.isFinite(until) && retrySeconds !== null && retrySeconds > 0) {
      until = Date.now() + retrySeconds * 1000;
    }
    if (!Number.isFinite(until) && remainingMinutes !== null && remainingMinutes > 0) {
      until = Date.now() + remainingMinutes * 60 * 1000;
    }
    if (!Number.isFinite(until)) until = Date.now() + LOCK_FALLBACK_MS;
    const active = until > Date.now();
    return {
      kind: 'locked',
      tone: 'amber',
      message: '账号已锁定，请稍后重试。',
      blockedUntil: active ? until : undefined,
    };
  }

  if (error.status === 429 || code.includes('rate_limited') || code.includes('too_many')) {
    const retrySeconds = readDetailNumber(details, ['retryAfterSeconds', 'retry_after_seconds', 'retryAfter']);
    return {
      kind: 'rate',
      tone: 'amber',
      message: '尝试过于频繁，请稍后重试。',
      blockedUntil: retrySeconds !== null && retrySeconds > 0 ? Date.now() + retrySeconds * 1000 : undefined,
    };
  }

  if (error.status === 401) {
    const remaining = readDetailNumber(details, [
      'remainingAttempts',
      'remaining_attempts',
      'attemptsRemaining',
      'attempts_remaining',
    ]);
    const locked = readDetailBoolean(details, 'locked');
    const lockedUntilRaw = readDetailString(details, ['lockedUntil', 'locked_until']);
    const lockedUntil = lockedUntilRaw ? Date.parse(lockedUntilRaw) : Number.NaN;
    if (locked && Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
      return {
        kind: 'locked',
        tone: 'amber',
        message: '账号已锁定，请稍后重试。',
        blockedUntil: lockedUntil,
      };
    }
    const suffix =
      remaining === null
        ? ''
        : remaining <= 0
          ? '尝试次数已用尽，请联系管理员解锁。'
          : `还可尝试 ${remaining} 次。`;
    return {
      kind: 'generic',
      tone: remaining !== null && remaining <= 2 ? 'amber' : 'red',
      message: `${error.message || '邮箱或密码不正确。'}${suffix ? ` ${suffix}` : ''}`,
    };
  }

  return {
    kind: 'generic',
    tone: 'red',
    message: error.message || '登录失败，请稍后重试。',
  };
}

function loginIssueMessage(issue: LoginIssue, now: number): string {
  if (issue.blockedUntil) {
    const remaining = Math.max(0, issue.blockedUntil - now);
    if (issue.kind === 'locked') {
      return `账号已锁定，请 ${Math.max(1, Math.ceil(remaining / 60_000))} 分钟后重试。`;
    }
    if (issue.kind === 'rate') {
      const seconds = Math.max(1, Math.ceil(remaining / 1000));
      return seconds >= 60
        ? `尝试过于频繁，请 ${Math.ceil(seconds / 60)} 分钟后重试。`
        : `尝试过于频繁，请 ${seconds} 秒后重试。`;
    }
  }
  return issue.message;
}

export function LoginPage() {
  useDocumentTitle('登录');

  const { user, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [issue, setIssue] = useState<LoginIssue | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const blockedUntil = issue?.blockedUntil ?? null;
  const blocked = blockedUntil !== null && blockedUntil > now;

  useInterval(() => setNow(Date.now()), blockedUntil !== null ? 1000 : null);

  useEffect(() => {
    if (blockedUntil !== null && blockedUntil <= now) setIssue(null);
  }, [blockedUntil, now]);

  const demo = useAsync(() => api.auth.demoAccounts(), []);
  const demoAccounts = demo.data && demo.data.length > 0 ? demo.data : DEMO_ACCOUNTS;

  const locationState = location.state as { from?: unknown } | null;
  const from = locationState && typeof locationState.from === 'string' ? locationState.from : '/';

  if (user) return <Navigate to={from} replace />;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || blocked) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setIssue({ kind: 'generic', tone: 'red', message: '请输入工作邮箱与密码。' });
      return;
    }
    setSubmitting(true);
    setIssue(null);
    try {
      await login(trimmedEmail, password);
      toast.success('登录成功，正在进入控制台。');
      navigate(from, { replace: true });
    } catch (err) {
      setIssue(describeLoginError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const fillDemoAccount = (accountEmail: string, accountPassword: string) => {
    if (blocked) return;
    setEmail(accountEmail);
    setPassword(accountPassword);
    setIssue(null);
  };

  return (
    <div className="auth">
      <section className="auth-visual" aria-label="产品介绍">
        <div className="auth-grid-lines" aria-hidden="true" />
        <span
          className="auth-orb"
          aria-hidden="true"
          style={{
            width: 220,
            height: 220,
            top: '9%',
            left: '6%',
            background: 'radial-gradient(circle at 35% 30%, rgba(139, 124, 255, 0.55), transparent 70%)',
          }}
        />
        <span
          className="auth-orb"
          aria-hidden="true"
          style={{
            width: 300,
            height: 300,
            right: '-8%',
            bottom: '2%',
            background: 'radial-gradient(circle at 50% 50%, rgba(56, 212, 240, 0.42), transparent 70%)',
            animationDelay: '1.4s',
          }}
        />

        <div className="auth-copy">
          <div className="hstack gap-10" style={{ marginBottom: 34 }}>
            <div className="brand-mark" aria-hidden="true">M</div>
            <div>
              <div className="brand-name">{APP_NAME}</div>
              <div className="brand-sub">{APP_TAGLINE}</div>
            </div>
          </div>

          <h1 className="auth-title">
            让 AI <span className="text-gradient">记住该记住的</span>
          </h1>
          <p className="auth-sub">
            为你的 AI 应用提供可隔离、可解释、可审计的长期记忆层。写入一次，跨会话稳定召回，
            把上下文成本留给真正重要的事实。
          </p>

          <div className="auth-points">
            {VALUE_POINTS.map((point) => (
              <div className={`auth-point tone-${point.tone}`} key={point.title}>
                <span className="auth-point-icon" aria-hidden="true">
                  <Icon name={point.icon} size={15} />
                </span>
                <div>
                  <div className="auth-point-title">{point.title}</div>
                  <div className="auth-point-desc">{point.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="auth-copy tiny dim" style={{ letterSpacing: '0.02em' }}>
          自托管部署 · 数据不出域 · 审计全留痕
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="hstack gap-10">
            <div className="brand-mark" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 14 }} aria-hidden="true">
              M
            </div>
            <div>
              <div className="brand-name">登录 {APP_NAME}</div>
              <div className="brand-sub">企业记忆基础设施</div>
            </div>
          </div>

          <Card pad>
            <form onSubmit={onSubmit} className="vstack gap-16" noValidate>
              <Field label="工作邮箱" htmlFor="login-email">
                <Input
                  id="login-email"
                  type="email"
                  icon="mail"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  autoFocus
                />
              </Field>

              <Field label="密码" htmlFor="login-password">
                <Input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="输入登录密码"
                  autoComplete="current-password"
                  style={{ paddingRight: 44 }}
                  suffix={
                    <IconButton
                      icon="eye"
                      label={showPassword ? '隐藏密码' : '显示密码'}
                      size="sm"
                      onClick={() => setShowPassword((value) => !value)}
                    />
                  }
                />
              </Field>

              {issue ? (
                <Callout
                  tone={issue.tone}
                  icon={issue.kind === 'locked' || issue.kind === 'disabled' ? 'lock' : 'alert'}
                >
                  {loginIssueMessage(issue, now)}
                </Callout>
              ) : null}

              <Button
                type="submit"
                variant="primary"
                block
                loading={submitting}
                disabled={blocked}
                iconRight="arrowRight"
              >
                {submitting ? '正在登录…' : blocked ? '暂时无法登录' : '登录控制台'}
              </Button>
            </form>

            <div className="auth-demo mt-16">
              <div className="between mb-8">
                <span className="tiny dim">演示账号 · 点击一键填充</span>
                <Badge tone="violet" size="sm">演示环境</Badge>
              </div>
              <div className="vstack gap-2">
                {demoAccounts.map((account) => (
                  <button
                    type="button"
                    key={account.email}
                    className="demo-account"
                    onClick={() => fillDemoAccount(account.email, account.password)}
                    disabled={submitting}
                  >
                    <Avatar name={account.name} tone={toneForRole(account.role)} size="sm" />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="hstack gap-6">
                        <span className="small strong">{account.name}</span>
                        <span className="tiny dim">{ROLE_LABEL[account.role]}</span>
                      </span>
                      <span className="tiny dim truncate" style={{ display: 'block' }}>{account.email}</span>
                    </span>
                    <Icon name="arrowRight" size={13} />
                  </button>
                ))}
              </div>
            </div>

            <div className="between tiny dim mt-16">
              <span>版本 {APP_VERSION}</span>
              <span>演示密码 mnemos-demo</span>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
