import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { formatSubshells, ionConfig, shellCounts } from '../chem/aufbau';
import { element, elementBySymbol, isotopeMass, isotopesOf } from '../data/db';
import { TIME_SCALES, useBuilder, type Particle } from '../game/builder';
import { useInventory } from '../game/inventory';
import { elementName, formatDuration, formatNumber, hasKey, prettyDecay, type MessageKey } from '../i18n';
import { nucleusStatus } from '../nuclear/nucleus';
import { EmittedList, Nuclide } from './Nuclide';
import { SourceTag } from './SourceTag';
import { useApp } from './store';
import { useT } from './useT';

const ELECTRON_MASS_U = 0.000548579909065; // CODATA 2018
const DRAG_TYPE = 'application/x-fromquark-particle';

const PARTICLES: { p: Particle; key: MessageKey; sym: string }[] = [
  { p: 'p', key: 'b.proton', sym: 'p⁺' },
  { p: 'n', key: 'b.neutron', sym: 'n⁰' },
  { p: 'e', key: 'b.electron', sym: 'e⁻' },
];

/** "O-16", "U238", "fe 56", "Fe" (most abundant, else longest-lived isotope). */
function parseQuick(text: string): { z: number; a: number } | null {
  const m = text.trim().match(/^([a-zA-Z]{1,2})\s*-?\s*(\d+)?$/);
  if (!m) return null;
  const sym = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const el = elementBySymbol(sym);
  if (!el) return null;
  if (m[2]) return +m[2] >= el.z ? { z: el.z, a: +m[2] } : null;
  if (!useApp.getState().isotopesReady) return null;
  const isos = isotopesOf(el.z);
  const natural = isos.filter((i) => i.abundance !== null).sort((x, y) => y.abundance! - x.abundance!);
  const best = natural[0] ?? [...isos].sort((x, y) => (y.halfLife ?? -1) - (x.halfLife ?? -1))[0];
  return best ? { z: el.z, a: best.a } : null;
}

function Palette() {
  const t = useT();
  const b = useBuilder(
    useShallow((s) => ({ protons: s.protons, neutrons: s.neutrons, electrons: s.electrons, add: s.add, setAtom: s.setAtom, clear: s.clear })),
  );
  const [quick, setQuick] = useState('');
  const [quickBad, setQuickBad] = useState(false);
  const count = { p: b.protons, n: b.neutrons, e: b.electrons };

  const onQuick = () => {
    const r = parseQuick(quick);
    setQuickBad(!r);
    if (r) b.setAtom(r.z, r.a);
  };

  return (
    <div className="panel palette-panel">
      <h3>{t('b.particles')}</h3>
      {PARTICLES.map(({ p, key, sym }) => (
        <div className="particle-row" key={p}>
          <span
            className={`chip chip-${p}`}
            draggable
            onDragStart={(e: ReactDragEvent) => {
              e.dataTransfer.setData(DRAG_TYPE, p);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => b.add(p, 1)}
            title={t(key)}
          >
            {sym}
          </span>
          <span className="particle-name">{t(key)}</span>
          <button onClick={() => b.add(p, -1)} aria-label="−">−</button>
          <span className="count mono">{count[p]}</span>
          <button onClick={() => b.add(p, 1)} aria-label="+">+</button>
        </div>
      ))}
      <form
        className="quick"
        onSubmit={(e) => {
          e.preventDefault();
          onQuick();
        }}
      >
        <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={t('b.quick')} />
        <button type="submit">↵</button>
      </form>
      {quickBad && <div className="warn small">{t('b.quickBad')}</div>}
      <button className="ghost" onClick={b.clear}>{t('b.clear')}</button>
    </div>
  );
}

function Info() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const ready = useApp((s) => s.isotopesReady);
  const { protons: z, neutrons: n, electrons: e, timeScale } = useBuilder(
    useShallow((s) => ({ protons: s.protons, neutrons: s.neutrons, electrons: s.electrons, timeScale: s.timeScale })),
  );
  const addAtom = useInventory((s) => s.addAtom);
  const [saveMsg, setSaveMsg] = useState<MessageKey | null>(null);
  useEffect(() => setSaveMsg(null), [z, n, e]);

  const a = z + n;
  const charge = z - e;
  const el = z >= 1 ? element(z) : undefined;
  const st = ready ? nucleusStatus(z, a, e) : null;
  const iso = st && 'iso' in st ? st.iso : null;
  const title =
    a === 0 && e === 0 ? t('b.empty') : z === 0 ? (a > 0 ? t('b.neutronsOnly') : t('b.electron')) : el ? elementName(lang, el) : t('b.unknownElement');

  const status = (() => {
    if (!st) return null;
    switch (st.kind) {
      case 'stable':
        return <div className="status ok">{t('b.status.stable')}</div>;
      case 'bareStable':
        return <div className="status ok">{t('b.status.bareStable')}</div>;
      case 'unknownElement':
        return <div className="status bad">{t('b.status.unknownElement')}</div>;
      case 'unbound':
        return <div className="status bad">{t(st.iso ? 'b.status.unbound' : 'b.status.unboundGuess')}</div>;
      case 'radioactive':
        return (
          <div className="status hot">
            {t('b.status.radioactive')} · {t('b.halfLife')} {formatDuration(lang, st.halfLife)}
            <div className="small muted">{t('b.realTime', { t: formatDuration(lang, st.halfLife / timeScale) })}</div>
          </div>
        );
      default:
        return null;
    }
  })();

  const shells = e > 0 ? ionConfig(z, e) : [];
  const ea = el?.electronAffinity ?? null;

  return (
    <div className="panel builder-info">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {a > 0 && (
            <div className="big-nuclide">
              <Nuclide z={z} a={a} charge={charge} showZ />
            </div>
          )}
        </div>
      </div>
      {status}
      <div className="rows">
        {e > 0 || z > 0 ? (
          <div className="row">
            <span className="label">{t('b.charge')}</span>
            <span className="value">
              {charge > 0 ? `+${charge}` : charge < 0 ? `−${-charge}` : '0'} ·{' '}
              {e === 0 && z > 0 ? t('b.bare') : charge === 0 ? t('b.neutral') : charge > 0 ? t('b.cation') : t('b.anion')}
            </span>
          </div>
        ) : null}
        {a > 0 && (
          <div className="row">
            <span className="label">{t('b.mass')}</span>
            <span className="value">
              {iso ? (
                <>
                  {(isotopeMass(iso) - (z - e) * ELECTRON_MASS_U).toFixed(6)} u
                  <SourceTag id="nubase2020" />
                </>
              ) : (
                t('b.noMass')
              )}
            </span>
          </div>
        )}
        {shells.length > 0 && (
          <>
            <div className="row">
              <span className="label">{t('b.shells')}</span>
              <span className="value mono">{shellCounts(shells).join(', ')}</span>
            </div>
            <div className="row">
              <span className="label">{t('b.config')}</span>
              <span className="value config">{formatSubshells(shells)}</span>
            </div>
          </>
        )}
        {el && charge === 0 && el.ionization !== null && (
          <div className="row">
            <span className="label">{t('b.ionization')}</span>
            <span className="value">
              {formatNumber(lang, el.ionization, 5)} eV
              <SourceTag id="pubchem" />
            </span>
          </div>
        )}
      </div>
      {charge < -1 && <div className="warn small note">{t('b.anionUnstable')}</div>}
      {charge === -1 && el && (ea === null || ea <= 0) && <div className="warn small note">{t('b.anionNoAffinity')}</div>}

      {iso && iso.decays.length > 0 && !iso.stable && (
        <>
          <h3>
            {t('b.decayModes')} <SourceTag id="nubase2020" />
          </h3>
          <div className="modes">
            {iso.decays.map((d, i) => (
              <span key={i} className="decay" title={hasKey(`decay.${d.mode}`) ? t(`decay.${d.mode}` as MessageKey) : d.mode}>
                {prettyDecay(d.mode)}
                {d.percent !== null ? ` ${d.rel === '=' ? '' : d.rel}${formatNumber(lang, d.percent)}%` : ' ?'}
              </span>
            ))}
          </div>
        </>
      )}

      <button
        className="primary"
        disabled={z < 1 || z > 118}
        onClick={() => setSaveMsg(addAtom(z, a, e) ? 'b.saved' : 'b.already')}
      >
        {saveMsg ? t(saveMsg) : t('b.save')}
      </button>
      <div className="small muted note">{t('b.notToScale')}</div>
    </div>
  );
}

function TimeBar() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const { timeScale, paused, age, log, setTimeScale, setPaused } = useBuilder();
  return (
    <div className="panel timebar">
      <div className="time-controls">
        <label>
          {t('b.speed')}{' '}
          <select value={timeScale} onChange={(e) => setTimeScale(+e.target.value)}>
            {TIME_SCALES.map((s) => (
              <option key={s} value={s}>×{s === 1 ? '1' : formatNumber(lang, s)}</option>
            ))}
          </select>
        </label>
        <button onClick={() => setPaused(!paused)}>{paused ? `▶ ${t('b.resume')}` : `⏸ ${t('b.pause')}`}</button>
        <span className="muted">
          {t('b.age')}: <span className="mono">{formatDuration(lang, age)}</span>
        </span>
      </div>
      {log.length > 0 && (
        <div className="log">
          {log.slice(0, 6).map((ev) => (
            <div key={ev.id} className="log-row">
              <Nuclide z={ev.fromZ} a={ev.fromA} /> → <Nuclide z={ev.z} a={ev.a} />
              <EmittedList emitted={ev.emitted} />
              <span className="muted">
                {' '}
                · {prettyDecay(ev.mode)} · {t('b.lived', { t: formatDuration(lang, ev.age) })}
                {ev.simplified && ` · ${t('b.simplified')}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Accepts particles dragged from the palette anywhere onto the 3D view. */
function useCanvasDrop(onDrop: (p: Particle) => void, setOver: (v: boolean) => void) {
  useEffect(() => {
    const canvas = document.getElementById('scene')!;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    };
    const leave = () => setOver(false);
    const drop = (e: DragEvent) => {
      const p = e.dataTransfer?.getData(DRAG_TYPE) as Particle | undefined;
      setOver(false);
      if (p === 'p' || p === 'n' || p === 'e') {
        e.preventDefault();
        onDrop(p);
      }
    };
    canvas.addEventListener('dragover', over);
    canvas.addEventListener('dragleave', leave);
    canvas.addEventListener('drop', drop);
    return () => {
      canvas.removeEventListener('dragover', over);
      canvas.removeEventListener('dragleave', leave);
      canvas.removeEventListener('drop', drop);
    };
  }, [onDrop, setOver]);
}

export function AtomBuilder() {
  const t = useT();
  const add = useBuilder((s) => s.add);
  const [over, setOver] = useState(false);
  const onDrop = useCallback((p: Particle) => add(p, 1), [add]);
  useCanvasDrop(onDrop, setOver);
  return (
    <>
      <Palette />
      <Info />
      <TimeBar />
      {over && <div className="drop-hint">{t('b.dropHere')}</div>}
    </>
  );
}
