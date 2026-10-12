import { SOURCES } from '../data/sources';
import type { SourceId } from '../data/types';
import { useT } from './useT';

export function SourceTag({ id }: { id: SourceId }) {
  const t = useT();
  const s = SOURCES[id];
  const title = `${t('source')}: ${s.citation}`;
  return s.url ? (
    <a className="src" href={s.url} target="_blank" rel="noreferrer" title={title}>
      {s.short}
    </a>
  ) : (
    <span className="src" title={title}>
      {s.short}
    </span>
  );
}
