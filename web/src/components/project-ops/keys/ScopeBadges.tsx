import type { ApiScope } from '@shared';
import { SCOPES } from '@shared';
import { Badge, type Tone } from '@ui';

const SCOPE_TONES: Record<ApiScope, Tone> = {
  'memories:read': 'cyan',
  'memories:write': 'violet',
  'graph:read': 'pink',
  admin: 'amber',
};

const SCOPE_LABEL = new Map(SCOPES.map((scope) => [scope.value, scope.label]));

export function ScopeBadges({ scopes, size }: { scopes: ApiScope[]; size?: 'sm' }) {
  if (!scopes.length) return <span className="tiny dim">无作用域</span>;
  return (
    <span className="chip-row">
      {scopes.map((scope) => (
        <Badge key={scope} tone={SCOPE_TONES[scope] ?? 'slate'} size={size} outline>
          {SCOPE_LABEL.get(scope) ?? scope}
        </Badge>
      ))}
    </span>
  );
}
