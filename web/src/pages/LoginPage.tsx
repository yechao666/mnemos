import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@lib/constants.ts';
import { ROLE_LABEL, toneForRole } from '@lib/tone.ts';
import { api, ApiError } from '@lib/api.ts';
import { useAuth } from '@lib/auth.tsx';
import { useAsync, useDocumentTitle, useInterval } from '@lib/hooks.ts';
import { Avatar, Badge, Button, Callout, Card, Field, Icon, IconButton, Input, useToast, type Tone } from '@ui';

const VALUE_POINTS = [
  {
    tone: 'violet',
    icon: 'layers',
    title: '分区隔离',
    desc: '一个 App / 项目 / 租户一个分区，记忆、密钥与用量互不串味。',
  },
  {
    tone: 'cyan',
    icon: 'users',
    title: '以人为中心',
    desc: '用户、员工、智能体都是「人」；记忆永远归属于一个人。',
  },
  {
    tone: 'amber',
    icon: 'sparkles',
    title: '百万级人列表',
    desc: '游标分页 + 窗口化渲染，百万级人也只渲染可视行。',
  },
] as const;

interface LoginIssue {
  tone: Tone;
  message: string;
  blockedUntil?: number;
}

function describeLoginError(error: unknown): LoginIssue {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return { tone: 'amber', message: '尝试过于频繁，请稍后重试。' };
    }
    if (error.status === 423) {
      return { tone: 'amber', message: '账号已锁定，请稍后重试。' };
    }
    return { tone: 'red', message: error.message || '登录失败，请稍后重试。' };
  }
  return {
    tone: 'red',
    message: error instanceof Error ? error.message : '登录失败，请稍后重试。',
  };
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

  useInterval(() => setNow(Date.now()), issue?.blockedUntil ? 1000 : null);
  useEffect(() => {
    if (issue?.blockedUntil && issue.blockedUntil <= now) setIssue(null);
  }, [issue, now]);

  // 演示账号来自 /api/auth/demo-accounts；v6 若未启用该端点则不展示（不伪造账号）。
  const demo = useAsync(() => api.auth.demoAccounts(), []);
  const demoAccounts = demo.data ?? [];
  const blocked = Boolean(issue?.blockedUntil && issue.blockedUntil > now);

  const locationState = location.state as { from?: unknown } | null;
  const from = locationState && typeof locationState.from === 'string' ? locationState.from : '/partitions';

  if (user) return <Navigate to={from} replace />;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || blocked) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setIssue({ tone: 'red', message: '请输入工作邮箱与密码。' });
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
            记住每个人 <span className="text-gradient">该记住的</span>
          </h1>
          <p className="auth-sub">
            面向百万人的中立记忆服务：分区隔离、以人为中心、共享与私有由 scope 决定。
            写入一次，跨会话稳定召回，把上下文成本留给真正重要的事实。
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
              <div className="brand-sub">分区 · 人 · 记忆</div>
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
                <Callout tone={issue.tone} icon={issue.tone === 'red' ? 'alert' : 'lock'}>
                  {issue.blockedUntil
                    ? `请 ${Math.max(1, Math.ceil((issue.blockedUntil - now) / 60_000))} 分钟后重试。`
                    : issue.message}
                </Callout>
              ) : null}

              <Button type="submit" variant="primary" block loading={submitting} disabled={blocked} iconRight="arrowRight">
                {submitting ? '正在登录…' : blocked ? '暂时无法登录' : '登录控制台'}
              </Button>
            </form>

            {demoAccounts.length > 0 ? (
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
            ) : null}

            <div className="between tiny dim mt-16">
              <span>版本 {APP_VERSION}</span>
              <span>分区 → 人 → 记忆</span>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
