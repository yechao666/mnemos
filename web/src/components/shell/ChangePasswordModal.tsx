import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@lib/api.ts';
import { useAuth } from '@lib/auth.tsx';
import {
  Button,
  Callout,
  Field,
  IconButton,
  Input,
  Modal,
  Progress,
  useToast,
  type Tone,
} from '@ui';

interface Strength {
  score: number;
  label: string;
  tone: Tone;
}

function passwordStrength(value: string): Strength {
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  const bounded = Math.min(5, score);
  const width = bounded * 20;
  if (bounded <= 2) return { score: width, label: '弱', tone: 'red' };
  if (bounded <= 3) return { score: width, label: '中', tone: 'amber' };
  return { score: width, label: '强', tone: 'green' };
}

function newPasswordError(value: string): string | null {
  if (!value) return '请输入新密码';
  if (value.length < 10) return '新密码至少需要 10 位';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '新密码需同时包含字母与数字';
  return null;
}

/** 修改密码：成功后服务端重置会话，控制台主动登出并要求重新登录。 */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { logout } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showNext, setShowNext] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setShowNext(false);
    setTouched(false);
    setSubmitting(false);
    setError(null);
  }, [open]);

  const currentError = current.length === 0 ? '请输入当前密码' : null;
  const nextError = newPasswordError(next);
  const sameError = next.length > 0 && next === current ? '新密码不能与当前密码相同' : null;
  const confirmError = confirm === next ? null : '两次输入的新密码不一致';
  const nextFieldError = nextError ?? sameError;
  const strength = passwordStrength(next);
  const valid = !currentError && !nextFieldError && !confirmError;

  const submit = async () => {
    setTouched(true);
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.authPassword.change({ currentPassword: current, newPassword: next });
      toast.success('密码已更新，请使用新密码重新登录', '密码修改成功');
      onClose();
      await logout();
      navigate('/login', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '修改密码失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="修改密码"
      description="修改后当前会话会失效，需要使用新密码重新登录。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" icon="check" loading={submitting} onClick={() => void submit()}>
            更新密码
          </Button>
        </>
      }
    >
      <Field
        label="当前密码"
        htmlFor="pwd-current"
        required
        error={touched && currentError ? currentError : undefined}
      >
        <Input
          id="pwd-current"
          type="password"
          value={current}
          autoComplete="current-password"
          placeholder="输入当前登录密码"
          onChange={(event) => setCurrent(event.target.value)}
        />
      </Field>

      <Field
        label="新密码"
        htmlFor="pwd-new"
        required
        error={touched && nextFieldError ? nextFieldError : undefined}
        hint="至少 10 位，且同时包含字母与数字。"
      >
        <Input
          id="pwd-new"
          type={showNext ? 'text' : 'password'}
          value={next}
          autoComplete="new-password"
          placeholder="设置新的登录密码"
          style={{ paddingRight: 44 }}
          suffix={
            <IconButton
              icon="eye"
              label={showNext ? '隐藏密码' : '显示密码'}
              size="sm"
              onClick={() => setShowNext((value) => !value)}
            />
          }
          onChange={(event) => setNext(event.target.value)}
        />
      </Field>

      {next ? (
        <div className="vstack gap-6">
          <div className="between tiny dim">
            <span>密码强度</span>
            <span style={{ color: `var(--${strength.tone})` }}>{strength.label}</span>
          </div>
          <Progress value={strength.score} thin tone={strength.tone} />
        </div>
      ) : null}

      <Field
        label="确认新密码"
        htmlFor="pwd-confirm"
        required
        error={touched && confirmError ? confirmError : undefined}
      >
        <Input
          id="pwd-confirm"
          type="password"
          value={confirm}
          autoComplete="new-password"
          placeholder="再次输入新密码"
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>

      {error ? (
        <Callout tone="red" icon="alert">{error}</Callout>
      ) : null}
    </Modal>
  );
}
