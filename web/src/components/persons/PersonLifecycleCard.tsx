import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Person } from '@lib/types.ts';
import type { Role } from '@lib/types.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  Input,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { ROLE_RANK } from '@lib/constants.ts';
import { downloadText, fmtInt } from '@lib/format.ts';

type Busy = 'merge' | 'archive' | 'export' | 'delete' | 'hard' | null;

/**
 * v6.1 P1 人生命周期操作区：
 *  - 合并到另一人（输入目标 externalId / 内部 id，二次确认；成功后源人被归档并返回人列表）
 *  - 归档（刷新当前页）
 *  - 导出 JSON（下载 person + facts + memories）
 *  - 删除：软删（记忆保留）/ 硬删（仅 owner，级联删除）
 * 权限：合并/归档/删除需 admin+；导出只读即可；硬删仅 owner（后端同样校验）。
 */
export function PersonLifecycleCard({
  partitionId,
  personRef,
  person,
  role,
  onChanged,
}: {
  partitionId: string;
  personRef: string;
  person: Person;
  role: Role;
  onChanged?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const canManage = ROLE_RANK[role] >= ROLE_RANK.admin;
  const isOwner = role === 'owner';

  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [hardOpen, setHardOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);

  const backToList = () => navigate(`/partitions/${partitionId}/persons`);
  const merged = Boolean(person.mergedInto);
  const deleted = person.status === 'deleted';

  const runMerge = async () => {
    const target = mergeTarget.trim();
    if (!target || busy) return;
    setBusy('merge');
    try {
      const result = await api.persons.merge(partitionId, personRef, target);
      setMergeOpen(false);
      toast.success(
        `已合并：迁移 ${fmtInt(result.movedMemories)} 条记忆、${fmtInt(result.movedFacts)} 条事实到 ${result.person.externalId || target}`,
      );
      // 源人已归档并指向 canonical；返回人列表，避免继续停留在合并源上。
      backToList();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '合并失败');
    } finally {
      setBusy(null);
    }
  };

  const runArchive = async () => {
    if (busy) return;
    setBusy('archive');
    try {
      await api.persons.archive(partitionId, personRef);
      setArchiveOpen(false);
      toast.success('已归档该人：记忆与画像保留，写入将被拒绝');
      onChanged?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '归档失败');
    } finally {
      setBusy(null);
    }
  };

  const runExport = async () => {
    if (busy) return;
    setBusy('export');
    try {
      const payload = await api.persons.export(partitionId, personRef);
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `person-${(person.externalId || person.id || 'export').replace(/[^\w.-]+/g, '_')}-${stamp}.json`;
      downloadText(filename, JSON.stringify(payload, null, 2));
      if (payload.truncated) {
        toast.warning(`导出已截断（记忆上限 10000 条），文件：${filename}`);
      } else {
        toast.success(`已导出 ${fmtInt(payload.memories.length)} 条记忆、${fmtInt(payload.facts.length)} 条事实`);
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '导出失败');
    } finally {
      setBusy(null);
    }
  };

  const runDelete = async (hard: boolean) => {
    if (busy) return;
    setBusy(hard ? 'hard' : 'delete');
    try {
      await api.persons.remove(partitionId, personRef, { hard });
      setDeleteOpen(false);
      setHardOpen(false);
      toast.success(hard ? '已硬删除该人及其记忆/事实（不可恢复）' : '已删除该人（软删）');
      backToList();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(null);
    }
  };

  const mergeDisabled = !canManage || merged || deleted || !mergeTarget.trim();
  const archiveDisabled = !canManage || merged || deleted || person.status === 'archived';

  return (
    <Card pad>
      <div className="between wrap gap-10">
        <div>
          <div className="section-title">生命周期与数据</div>
          <div className="tiny dim mt-4">
            合并 / 归档 / 导出 / 删除。合并与删除会把源人从人列表默认结果中移除（后端按 merged_into / deleted_at 过滤）。
          </div>
        </div>
        <div className="hstack gap-8 wrap">
          <Badge tone="slate" size="sm">external ID: {person.externalId}</Badge>
          <CopyButton value={person.externalId} label="复制 external ID" />
        </div>
      </div>

      {merged ? (
        <div className="mt-12">
          <Callout tone="amber" icon="info">
            该人已被合并到 canonical 人 <span className="mono">{person.mergedInto}</span>；新记忆/画像请写入目标人。合并源默认不在人列表展示。
          </Callout>
        </div>
      ) : null}
      {deleted ? (
        <div className="mt-12">
          <Callout tone="red" icon="alert">
            该人已软删除（deleted）：默认不再出现在人列表与检索中，记忆仍保留；owner 可硬删除。
          </Callout>
        </div>
      ) : null}

      <div className="lifecycle-grid mt-12">
        <div className="lifecycle-block">
          <div className="lifecycle-title">合并到另一人</div>
          <div className="tiny dim">
            把该人的 memories / facts / feedback 迁移到目标人（external ID 或内部 ID），源人标记 merged_into 并归档。
          </div>
          <div className="hstack gap-6 mt-8 wrap">
            <Input
              value={mergeTarget}
              aria-label="合并目标人的 external ID"
              placeholder="目标人 external ID / 内部 ID"
              style={{ flex: 1, minWidth: 170 }}
              disabled={!canManage || merged || deleted}
              onChange={(event) => setMergeTarget(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !mergeDisabled) setMergeOpen(true);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              icon="users"
              disabled={mergeDisabled}
              onClick={() => setMergeOpen(true)}
            >
              合并
            </Button>
          </div>
          {!canManage ? <div className="tiny dim mt-6">需要 admin 及以上角色。</div> : null}
        </div>

        <div className="lifecycle-block">
          <div className="lifecycle-title">归档</div>
          <div className="tiny dim">
            归档后该人仍可读，但写入会被拒绝；可随时重新激活（PATCH status=active）。
          </div>
          <div className="mt-8">
            <Button
              size="sm"
              variant="secondary"
              icon="package"
              disabled={archiveDisabled}
              onClick={() => setArchiveOpen(true)}
            >
              {person.status === 'archived' ? '已归档' : '归档此人'}
            </Button>
          </div>
        </div>

        <div className="lifecycle-block">
          <div className="lifecycle-title">导出 JSON</div>
          <div className="tiny dim">
            下载该人的资料、facts（含历史版本）与全部记忆（上限 10000 条，超出标记 truncated）。
          </div>
          <div className="mt-8">
            <Button
              size="sm"
              variant="secondary"
              icon="download"
              loading={busy === 'export'}
              onClick={() => void runExport()}
            >
              下载导出
            </Button>
          </div>
        </div>

        <div className="lifecycle-block is-danger">
          <div className="lifecycle-title">删除</div>
          <div className="tiny dim">
            软删：status=deleted + deletedAt，记忆保留（可被 owner 恢复前查询）；硬删：级联删除该人全部记忆与 facts，不可恢复。
          </div>
          <div className="hstack gap-6 mt-8 wrap">
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              disabled={!canManage || deleted}
              loading={busy === 'delete'}
              onClick={() => setDeleteOpen(true)}
            >
              {deleted ? '已删除' : '软删除'}
            </Button>
            {isOwner ? (
              <Button
                size="sm"
                variant="ghost"
                icon="alert"
                disabled={busy === 'hard'}
                onClick={() => setHardOpen(true)}
              >
                硬删除（owner）
              </Button>
            ) : null}
          </div>
          {!canManage ? <div className="tiny dim mt-6">需要 admin 及以上角色。</div> : null}
        </div>
      </div>

      <ConfirmDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        onConfirm={() => void runMerge()}
        title={`合并「${person.displayName || person.externalId}」到 ${mergeTarget.trim() || '目标人'}？`}
        description={`将迁移该人的全部记忆、事实与反馈到目标人；源人标记 merged_into 并归档，之后不能继续作为写入目标。`}
        confirmLabel="确认合并"
        tone="amber"
        loading={busy === 'merge'}
      />

      <ConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={() => void runArchive()}
        title="归档该人？"
        description="归档后该人仍可读、记忆保留，但写入会被拒绝。"
        confirmLabel="归档"
        loading={busy === 'archive'}
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void runDelete(false)}
        title="软删除该人？"
        description="将 status 置为 deleted 并记录 deleted_at；默认不再出现在人列表与检索中，记忆仍保留。"
        confirmLabel="软删除"
        loading={busy === 'delete'}
      />

      <ConfirmDialog
        open={hardOpen}
        onClose={() => setHardOpen(false)}
        onConfirm={() => void runDelete(true)}
        title="硬删除该人（不可恢复）？"
        description={`将永久删除该人及其 ${fmtInt(person.memoryCount)} 条记忆/全部 facts，并清理计数与索引；仅 owner 可执行。`}
        confirmLabel="永久删除"
        loading={busy === 'hard'}
      />
    </Card>
  );
}
