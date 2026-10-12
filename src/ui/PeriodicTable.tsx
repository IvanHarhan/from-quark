import { tableCell } from '../chem/periodic';
import { ELEMENTS } from '../data/db';
import { elementName, type MessageKey } from '../i18n';
import { useApp } from './store';
import { useT } from './useT';

export const BLOCK_COLORS: Record<string, string> = {
  'Nonmetal': '#3d8b6e',
  'Noble gas': '#6a58a8',
  'Alkali metal': '#b5523b',
  'Alkaline earth metal': '#b98236',
  'Metalloid': '#5f8a3a',
  'Halogen': '#2f8a9a',
  'Post-transition metal': '#55708a',
  'Transition metal': '#4a5f9c',
  'Lanthanide': '#9a4f86',
  'Actinide': '#a3485c',
};

export function PeriodicTable() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const selectedZ = useApp((s) => s.selectedZ);
  const select = useApp((s) => s.selectElement);
  const close = () => useApp.getState().setTableOpen(false);

  return (
    <div className={`panel table-panel${selectedZ !== null ? ' with-card' : ''}`}>
      <div className="panel-head">
        <h2>{t('table.title')}</h2>
        <button className="ghost" onClick={close} aria-label={t('table.close')}>✕</button>
      </div>
      <div className="ptable">
        {ELEMENTS.map((e) => {
          const { row, col } = tableCell(e.z);
          return (
            <button
              key={e.z}
              className={`cell${selectedZ === e.z ? ' selected' : ''}`}
              style={{ gridRow: row + (row > 7 ? 1 : 0), gridColumn: col, background: BLOCK_COLORS[e.block] }}
              title={`${elementName(lang, e)} · ${t(`block.${e.block}` as MessageKey)}`}
              onClick={() => select(e.z)}
            >
              <span className="z">{e.z}</span>
              <span className="sym">{e.symbol}</span>
            </button>
          );
        })}
      </div>
      <div className="legend">
        {Object.entries(BLOCK_COLORS).map(([block, color]) => (
          <span key={block}>
            <i style={{ background: color }} />
            {t(`block.${block}` as MessageKey)}
          </span>
        ))}
      </div>
    </div>
  );
}
