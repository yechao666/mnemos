import { useState, type ReactNode } from 'react';
import type { AttachmentKind, MemoryAttachment, MemoryAttachmentInput } from '@lib/types.ts';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABEL,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CAPTION,
  MAX_ATTACHMENT_URL,
} from '@lib/constants.ts';
import { Badge, Button, Icon, IconButton, Input, Select, type Tone } from '@ui';

/**
 * v6.1 P2 多模态附件 UI：
 *  - 详情抽屉：图片缩略图、音视频链接/播放器、文件下载、caption 与 kind 徽标；
 *  - 新建记忆：附件编辑器（kind / url / caption，≤10，校验 http(s) URL）。
 *
 * 只展示 URL 指向的媒体（媒体本体由调用方托管），控制台不代理下载。
 */

const KIND_TONE: Record<AttachmentKind, Tone> = {
  image: 'violet',
  audio: 'cyan',
  video: 'pink',
  file: 'slate',
};

export function attachmentKindLabel(kind: string | undefined): string {
  return (kind && ATTACHMENT_KIND_LABEL[kind as AttachmentKind]) || kind || '附件';
}

export function AttachmentKindBadge({ kind, size }: { kind: string | undefined; size?: 'sm' }) {
  const tone = (kind && KIND_TONE[kind as AttachmentKind]) || 'slate';
  return (
    <Badge tone={tone} size={size} dot>
      {attachmentKindLabel(kind)}
    </Badge>
  );
}

/** 只允许 http(s) URL：避免 javascript:/data: 注入，也避免打开本地路径。 */
export function safeAttachmentUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function fileNameFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  const segment = withoutQuery.split('/').filter(Boolean).pop() ?? '';
  if (!segment) return url;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function fmtFileSize(size: number | undefined): string {
  if (!size || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ExternalLink({
  href,
  children,
  title,
  className = 'link-button',
  download,
}: {
  href: string;
  children: ReactNode;
  title?: string;
  className?: string;
  download?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title ?? href}
      download={download}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

function ImageThumb({ attachment }: { attachment: MemoryAttachment }) {
  const [broken, setBroken] = useState(false);
  const safe = safeAttachmentUrl(attachment.url);
  if (!safe) {
    return (
      <div className="attachment-thumb is-broken">
        <Icon name="alert" size={16} />
        <span className="tiny dim">URL 不合法</span>
      </div>
    );
  }
  return (
    <a
      className="attachment-thumb"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      title={attachment.caption || attachment.url}
      onClick={(event) => event.stopPropagation()}
    >
      {broken ? (
        <div className="attachment-thumb-fallback">
          <Icon name="eye" size={16} />
          <span className="tiny dim">图片无法加载，点击打开</span>
        </div>
      ) : (
        <img
          src={safe}
          alt={attachment.caption || fileNameFromUrl(safe)}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      )}
    </a>
  );
}

function AttachmentMedia({ attachment }: { attachment: MemoryAttachment }) {
  const safe = safeAttachmentUrl(attachment.url);
  if (!safe) {
    return (
      <div className="attachment-media is-broken">
        <Icon name="alert" size={13} /> <span className="tiny dim">附件 URL 不合法（仅支持 http/https）</span>
      </div>
    );
  }
  if (attachment.kind === 'image') return <ImageThumb attachment={attachment} />;
  if (attachment.kind === 'audio') {
    return (
      <div className="attachment-media">
        <audio controls preload="none" src={safe} />
      </div>
    );
  }
  if (attachment.kind === 'video') {
    return (
      <div className="attachment-media">
        <video controls preload="none" src={safe} />
      </div>
    );
  }
  return (
    <div className="attachment-file">
      <Icon name="package" size={16} />
      <span className="truncate" title={safe}>{fileNameFromUrl(safe)}</span>
    </div>
  );
}

export function AttachmentItem({ attachment }: { attachment: MemoryAttachment }) {
  const safe = safeAttachmentUrl(attachment.url);
  const meta = [attachment.mime, fmtFileSize(attachment.size)].filter(Boolean).join(' · ');
  return (
    <div className={`attachment-card kind-${attachment.kind}`}>
      <AttachmentMedia attachment={attachment} />
      <div className="attachment-body">
        <div className="hstack gap-6 wrap">
          <AttachmentKindBadge kind={attachment.kind} size="sm" />
          {safe ? (
            <ExternalLink
              href={safe}
              className="link-button small truncate"
              title={safe}
              download={attachment.kind === 'file' ? fileNameFromUrl(safe) : undefined}
            >
              {attachment.kind === 'file' ? '下载 / 打开' : '打开原文件'}
            </ExternalLink>
          ) : null}
        </div>
        <div className="attachment-caption">{attachment.caption || <span className="dim">无描述</span>}</div>
        <div className="attachment-meta tiny dim">
          {meta ? <span className="mono">{meta}</span> : null}
          <span className="truncate mono" title={attachment.url}>{attachment.url}</span>
        </div>
      </div>
    </div>
  );
}

/** 记忆详情里的附件区（无附件时不渲染，由调用方决定是否占位）。 */
export function AttachmentGallery({
  attachments,
  count,
}: {
  attachments: MemoryAttachment[] | undefined;
  count?: number;
}) {
  if (!attachments || attachments.length === 0) {
    if (!count) return null;
    return (
      <div className="attachment-loading tiny dim">
        <Icon name="package" size={12} /> 这条记忆有 {count} 个附件，详情加载中…
      </div>
    );
  }
  return (
    <div className="attachment-grid">
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 附件编辑器（新建记忆）                                              */
/* ------------------------------------------------------------------ */

/** 表单里的附件草稿：数字在提交时再转，避免受控输入被 Number 吃掉中间态。 */
export interface AttachmentDraft {
  kind: AttachmentKind;
  url: string;
  caption: string;
}

export function newAttachmentDraft(kind: AttachmentKind = 'image'): AttachmentDraft {
  return { kind, url: '', caption: '' };
}

export function attachmentDraftError(draft: AttachmentDraft): string | null {
  const url = draft.url.trim();
  if (!url) return '请填写附件 URL';
  if (url.length > MAX_ATTACHMENT_URL) return `URL 最长 ${MAX_ATTACHMENT_URL} 字符`;
  const safe = safeAttachmentUrl(url);
  if (!safe) return 'URL 不合法：需要以 http:// 或 https:// 开头';
  if (draft.caption.length > MAX_ATTACHMENT_CAPTION) return `描述最长 ${MAX_ATTACHMENT_CAPTION} 字符`;
  return null;
}

/** 把草稿转为写入入参；配合 validateAttachmentDrafts 使用。 */
export function attachmentDraftsToInputs(drafts: AttachmentDraft[]): MemoryAttachmentInput[] {
  return drafts.map((draft) => {
    const input: MemoryAttachmentInput = {
      kind: draft.kind,
      url: draft.url.trim(),
    };
    const caption = draft.caption.trim();
    if (caption) input.caption = caption;
    return input;
  });
}

export function validateAttachmentDrafts(drafts: AttachmentDraft[]): string | null {
  if (drafts.length > MAX_ATTACHMENTS) return `附件最多 ${MAX_ATTACHMENTS} 个`;
  for (let index = 0; index < drafts.length; index += 1) {
    const error = attachmentDraftError(drafts[index]!);
    if (error) return `第 ${index + 1} 个附件：${error}`;
  }
  return null;
}

/**
 * 附件编辑器：kind / url / caption 三列，行内校验，最多 10 条。
 * `showErrors` 由父级在提交时置 true，避免空行一出现就报错。
 */
export function AttachmentEditor({
  value,
  onChange,
  showErrors = false,
  disabled = false,
}: {
  value: AttachmentDraft[];
  onChange: (next: AttachmentDraft[]) => void;
  showErrors?: boolean;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<AttachmentDraft>) => {
    onChange(value.map((draft, current) => (current === index ? { ...draft, ...patch } : draft)));
  };
  const remove = (index: number) => onChange(value.filter((_, current) => current !== index));
  const add = () => {
    if (value.length >= MAX_ATTACHMENTS) return;
    onChange([...value, newAttachmentDraft('image')]);
  };

  return (
    <div className="attachment-editor">
      <div className="between wrap gap-8">
        <div>
          <div className="small">附件（可选）</div>
          <div className="tiny dim">图片 / 音频 / 视频 / 文件，只存 URL；caption 会参与检索。</div>
        </div>
        <Badge tone={value.length >= MAX_ATTACHMENTS ? 'amber' : 'slate'} size="sm">
          {value.length} / {MAX_ATTACHMENTS}
        </Badge>
      </div>

      {value.length === 0 ? (
        <div className="attachment-editor-empty tiny dim">
          还没有附件。点击「添加附件」填写媒体 URL（例如 CDN / 对象存储链接）。
        </div>
      ) : (
        <div className="vstack gap-8 mt-8">
          {value.map((draft, index) => {
            const error = attachmentDraftError(draft);
            const showError = Boolean(error) && (showErrors || draft.url.trim().length > 0);
            return (
              <div className="attachment-row" key={index}>
                <div className="attachment-row-fields">
                  <Select
                    aria-label={`附件 ${index + 1} 类型`}
                    options={ATTACHMENT_KINDS.map((item) => ({ value: item.value, label: item.label }))}
                    value={draft.kind}
                    disabled={disabled}
                    onChange={(event) => update(index, { kind: event.target.value as AttachmentKind })}
                  />
                  <Input
                    aria-label={`附件 ${index + 1} URL`}
                    value={draft.url}
                    disabled={disabled}
                    placeholder="https://cdn.example.com/login.png"
                    className="mono"
                    onChange={(event) => update(index, { url: event.target.value })}
                  />
                  <Input
                    aria-label={`附件 ${index + 1} 描述`}
                    value={draft.caption}
                    disabled={disabled}
                    placeholder="可选：描述（参与检索）"
                    maxLength={MAX_ATTACHMENT_CAPTION}
                    onChange={(event) => update(index, { caption: event.target.value })}
                  />
                  <IconButton
                    icon="trash"
                    label={`删除第 ${index + 1} 个附件`}
                    size="sm"
                    disabled={disabled}
                    onClick={() => remove(index)}
                  />
                </div>
                {showError ? <div className="field-error">{error}</div> : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="hstack gap-8 mt-8">
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          disabled={disabled || value.length >= MAX_ATTACHMENTS}
          onClick={add}
        >
          添加附件
        </Button>
        {value.length >= MAX_ATTACHMENTS ? <span className="tiny dim">已达到 {MAX_ATTACHMENTS} 个上限</span> : null}
      </div>
    </div>
  );
}
