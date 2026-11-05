import { useNavigate } from 'react-router-dom';
import { Button } from '@ui';

export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div
      className="center"
      style={{ minHeight: '62vh', flexDirection: 'column', textAlign: 'center', gap: 18 }}
    >
      <div
        className="text-gradient"
        style={{ fontSize: 96, fontWeight: 700, letterSpacing: '-0.06em', lineHeight: 1 }}
        aria-hidden="true"
      >
        404
      </div>
      <div className="vstack gap-6" style={{ alignItems: 'center' }}>
        <h1 className="page-title">页面不存在</h1>
        <p className="page-desc" style={{ maxWidth: 460 }}>
          你访问的页面可能已被移动、重命名或从未存在。返回概览继续浏览组织记忆与项目数据。
        </p>
      </div>
      <div className="hstack gap-10 wrap" style={{ justifyContent: 'center' }}>
        <Button variant="primary" icon="dashboard" onClick={() => navigate('/')}>
          返回概览
        </Button>
        <Button icon="folder" onClick={() => navigate('/projects')}>
          打开项目
        </Button>
      </div>
      <div className="tiny dim">如果链接来自通知或书签，可能对应的项目已被归档。</div>
    </div>
  );
}
