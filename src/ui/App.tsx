import { QUALITY_LEVELS, type QualityLevel } from '../game/quality';
import type { Lang } from '../i18n';
import { AtomBuilder } from './AtomBuilder';
import { ElementCard } from './ElementCard';
import { Inventory } from './Inventory';
import { LabPanel } from './LabPanel';
import { ZoomPanel } from './ZoomPanel';
import { MoleculeBuilder } from './MoleculeBuilder';
import { PeriodicTable } from './PeriodicTable';
import { useApp, type View } from './store';
import { useLab } from '../game/labState';
import { useBuilder } from '../game/builder';
import { formatNumber } from '../i18n';
import { useT } from './useT';

const VIEWS: { view: View; key: 'view.lab' | 'view.atom' | 'view.molecule'; hotkey: string }[] = [
  { view: 'lab', key: 'view.lab', hotkey: '' },
  { view: 'atom', key: 'view.atom', hotkey: ' (B)' },
  { view: 'molecule', key: 'view.molecule', hotkey: ' (M)' },
];

/** Pulsing badge whenever game time runs faster than real time in the current view. */
function FastForward() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const view = useApp((s) => s.view);
  const thermal = useLab((s) => s.thermalSpeed);
  const atomScale = useBuilder((s) => s.timeScale);
  const speed = view === 'lab' ? thermal : view === 'atom' ? atomScale : 1;
  if (speed <= 1) return null;
  return (
    <span className="badge ff">
      ⏩ ×{speed >= 1e4 ? formatNumber(lang, speed) : speed} {view === 'lab' ? t('hud.ffHeat') : ''}
    </span>
  );
}

export function App() {
  const t = useT();
  const s = useApp();

  if (s.rendererError) return <div className="fatal">{t('app.noRenderer')}</div>;
  if (s.crash) return <div className="fatal">{t('app.crash')}<pre>{s.crash}</pre></div>;

  const hint =
    s.view === 'atom'
      ? t('hint.atom')
      : s.view === 'molecule'
        ? t('hint.molecule')
        : s.view === 'zoom'
          ? t('hint.zoom')
        : s.cameraMode === 'orbit'
        ? t('hint.orbit')
        : s.pointerLocked
          ? t('hint.fps.locked')
          : t('hint.fps.unlocked');

  return (
    <>
      <div className="hud top-left">
        <div className={`brand${s.view !== 'lab' ? ' dark-bg' : ''}`}>From Quark</div>
        <div className="badges">
          {s.backend ? (
            <span className={`badge ${s.backend}`}>{t(`hud.backend.${s.backend}`)}</span>
          ) : (
            <span className="badge">{t('app.loading')}</span>
          )}
          {s.view === 'lab' && <span className="badge">{t(s.cameraMode === 'orbit' ? 'camera.orbit' : 'camera.fps')}</span>}
          <span className="badge mono">{s.fps} {t('hud.fps')}</span>
          <FastForward />
        </div>
      </div>

      <div className="hud top-right">
        <div className="seg">
          {VIEWS.map((v) => (
            <button key={v.view} className={s.view === v.view ? 'active' : ''} onClick={() => s.setView(v.view)}>
              {t(v.key)}
              {v.hotkey}
            </button>
          ))}
        </div>
        <button className={s.inventoryOpen ? 'active' : ''} onClick={() => s.setInventoryOpen(!s.inventoryOpen)}>
          {t('inv.button')} (I)
        </button>
        <button className={s.tableOpen ? 'active' : ''} onClick={() => s.setTableOpen(!s.tableOpen)}>
          {t('table.button')} (T)
        </button>
        <label>
          {t('quality.label')}{' '}
          <select value={s.quality} onChange={(e) => s.setQuality(e.target.value as QualityLevel)}>
            {QUALITY_LEVELS.map((q) => (
              <option key={q} value={q}>{t(`quality.${q}`)}</option>
            ))}
          </select>
        </label>
        <div className="seg">
          {(['ru', 'en'] as Lang[]).map((l) => (
            <button key={l} className={s.lang === l ? 'active' : ''} onClick={() => s.setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {s.view === 'atom' && <AtomBuilder />}
      {s.view === 'molecule' && <MoleculeBuilder />}
      {s.view === 'lab' && <LabPanel />}
      {s.view === 'zoom' && <ZoomPanel />}
      {s.tableOpen && <PeriodicTable />}
      {s.selectedZ !== null && <ElementCard />}
      {s.inventoryOpen && <Inventory />}
      {s.view === 'lab' && s.cameraMode === 'fps' && s.pointerLocked && <div className="crosshair" />}
      <div className="hud bottom">{hint}</div>
    </>
  );
}
