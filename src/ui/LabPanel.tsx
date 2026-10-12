import { useState } from 'react';
import { SUBSTANCES, substance } from '../data/substances';
import { BRUSH } from '../game/labSim';
import {
  GRAVITY_PRESETS,
  PRESS_GAP_MAX,
  THERMAL_SPEEDS,
  useLab,
  type GravityPreset,
  type SpawnPlace,
} from '../game/labState';
import { ATM, boilingPoint } from '../sim/thermo';
import { formatDuration, formatNumber, type MessageKey } from '../i18n';
import { SourceTag } from './SourceTag';
import { useApp } from './store';
import { useT } from './useT';

const C0 = 273.15;

/** "H2O" → H<sub>2</sub>O */
function formulaText(f: string) {
  return f.split(/(\d+)/).map((part, i) => (/^\d+$/.test(part) ? <sub key={i}>{part}</sub> : <span key={i}>{part}</span>));
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange(v: number): void }) {
  return (
    <label className="slider">
      <span>
        {props.label}: <b className="mono">{props.value}{props.unit}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(+e.target.value)} />
    </label>
  );
}

function SpawnForm() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const spawn = useLab((s) => s.spawn);
  const [id, setId] = useState('iron');
  const [sizeCm, setSize] = useState(4);
  const [tempC, setTemp] = useState(20);
  const [place, setPlace] = useState<SpawnPlace>('press');
  const s = substance(id);
  const massG = s.rhoLiquid * (sizeCm / 100) ** 3 * 1000;
  return (
    <div className="spawn">
      <div className="row-2">
        <select value={id} onChange={(e) => setId(e.target.value)}>
          {SUBSTANCES.map((x) => (
            <option key={x.id} value={x.id}>{x[lang]}</option>
          ))}
        </select>
        <select value={place} onChange={(e) => setPlace(e.target.value as SpawnPlace)}>
          {(['press', 'tray', 'beaker'] as SpawnPlace[]).map((p) => (
            <option key={p} value={p}>{t(`lab.place.${p}` as MessageKey)}</option>
          ))}
        </select>
      </div>
      <Slider label={t('lab.size')} value={sizeCm} min={1} max={6} step={0.5} unit=" cm" onChange={setSize} />
      <Slider label={t('lab.temperature')} value={tempC} min={-196} max={2000} step={1} unit=" °C" onChange={setTemp} />
      <div className="small muted">
        ≈ {formatNumber(lang, massG, 3)} g · {t(tempC + C0 < s.tm ? 'state.solid' : tempC + C0 < s.tb ? 'state.liquid' : 'state.gas')}
      </div>
      {s.note && <div className="small muted note">{s.note[lang]}</div>}
      <button className="primary" onClick={() => spawn({ substance: id, size: sizeCm / 100, temperature: tempC + C0, place })}>
        {t('lab.spawn')}
      </button>
    </div>
  );
}

export function LabPanel() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const s = useLab();
  const tb = boilingPoint(substance('water'), s.pressureAtm * ATM) - C0;
  return (
    <>
      <div className="panel lab-panel">
        {!s.fluidSupported && <div className="warn small note">{t('lab.noWebgpu')}</div>}
        <h3>{t('lab.beaker')}</h3>
        <Slider label={t('lab.tilt')} value={Math.round(s.tilt)} min={0} max={125} step={1} unit="°" onChange={s.setTilt} />
        <div className="btn-row">
          <button className={s.shaking ? 'active' : ''} onClick={() => s.setShaking(!s.shaking)}>{t('lab.shake')}</button>
          <button className={s.plateOn ? 'active' : ''} onClick={() => s.setPlate(!s.plateOn)}>{t('lab.plate')}</button>
        </div>
        <Slider label={t('lab.plateT')} value={s.plateC} min={-60} max={400} step={5} unit=" °C" onChange={(v) => s.setPlate(true, v)} />

        <h3>{t('lab.press')}</h3>
        <Slider
          label={t('lab.pressGap')}
          value={Math.round(s.pressGap * 1000) / 10}
          min={0.5}
          max={PRESS_GAP_MAX * 100}
          step={0.5}
          unit=" cm"
          onChange={(v) => s.setPressGap(v / 100)}
        />

        <h3>{t('lab.add')}</h3>
        <SpawnForm />

        <div className="small muted note">{t('lab.brushHint', { hot: BRUSH.heat, cold: BRUSH.cool })}</div>
        <div className="btn-row">
          <button onClick={() => s.setPaused(!s.paused)}>{s.paused ? `▶ ${t('b.resume')}` : `⏸ ${t('b.pause')}`}</button>
          <button className="ghost" onClick={s.reset}>{t('lab.reset')}</button>
        </div>
      </div>

      <div className="panel env-panel">
        <h3>{t('lab.environment')}</h3>
        <Slider label={t('lab.room')} value={s.roomC} min={-40} max={60} step={1} unit=" °C" onChange={s.setRoomC} />
        <Slider
          label={t('lab.pressure')}
          value={s.pressureAtm}
          min={0.05}
          max={3}
          step={0.05}
          unit=" atm"
          onChange={s.setPressure}
        />
        <div className="small muted">
          {t('lab.waterBoils', { t: formatNumber(lang, tb, 4) })} <SourceTag id="nistWebbook" />
        </div>
        <label className="row-label">
          {t('lab.gravity')}{' '}
          <select value={s.gravity} onChange={(e) => s.setGravity(e.target.value as GravityPreset)}>
            {(Object.keys(GRAVITY_PRESETS) as GravityPreset[]).map((g) => (
              <option key={g} value={g}>
                {t(`lab.g.${g}` as MessageKey)} · {formatNumber(lang, GRAVITY_PRESETS[g], 4)} m/s²
              </option>
            ))}
          </select>
        </label>
        <label className="row-label">
          {t('lab.thermalSpeed')}{' '}
          <select value={s.thermalSpeed} onChange={(e) => s.setThermalSpeed(+e.target.value)}>
            {THERMAL_SPEEDS.map((v) => (
              <option key={v} value={v}>×{v}</option>
            ))}
          </select>
        </label>
        <div className="clock">
          🕒 {t('lab.clock')}: <b className="mono">{formatDuration(lang, s.elapsed)}</b>
        </div>
        <div className="small muted">{t('lab.thermalNote')}</div>

        {s.stats.length > 0 && (
          <>
            <h3>{t('lab.contents')}</h3>
            <table className="iso">
              <tbody>
                {s.stats.map((st) => {
                  const sub = substance(st.substance);
                  const g = (kg: number) => (kg > 0.0005 ? `${formatNumber(lang, kg * 1000, 3)} g` : '—');
                  return (
                    <tr key={st.substance}>
                      <td className="nuc">
                        {sub[lang]} <span className="formula">{formulaText(sub.formula)}</span>
                      </td>
                      <td title={t('state.solid')}>❄ {g(st.solid)}</td>
                      <td title={t('state.liquid')}>💧 {g(st.liquid)}</td>
                      <td title={t('lab.evaporated')}>♨ {g(st.vapor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        {s.fluidSupported && (
          <div className="small muted note">
            {t('lab.particles', { n: s.particles })} · {t('lab.model')}
          </div>
        )}
      </div>
      <Inspector />
    </>
  );
}

function Inspector() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const inspect = useLab((s) => s.inspect);
  const pressureAtm = useLab((s) => s.pressureAtm);
  if (!inspect) return null;
  const sub = substance(inspect.substance);
  const phaseKey: MessageKey = inspect.steam
    ? 'state.gas'
    : inspect.liquid >= 0.999
      ? 'state.liquid'
      : inspect.liquid <= 0.001
        ? 'state.solid'
        : 'lab.melting';
  const rho = inspect.liquid > 0.5 ? sub.rhoLiquid : sub.rhoSolid;
  return (
    <div className="hover-tip inspector">
      <b>{sub[lang]}</b> (<span className="formula">{formulaText(sub.formula)}</span>) · {t(phaseKey)}
      {phaseKey === 'lab.melting' && ` ${Math.round(inspect.liquid * 100)}%`}
      <br />
      T = {formatNumber(lang, inspect.T - C0, 4)} °C · P = {formatNumber(lang, pressureAtm, 3)} atm · ρ ={' '}
      {formatNumber(lang, rho, 4)} kg/m³ <SourceTag id={sub.sources.default} />
      <br />
      <span className="muted">
        {t('lab.tm')} {formatNumber(lang, sub.tm - C0, 4)} °C · {t('lab.tb')}{' '}
        {formatNumber(lang, boilingPoint(sub, pressureAtm * ATM) - C0, 4)} °C
      </span>
      <br />
      <span className="muted">{t('hint.labZoom')}</span>
    </div>
  );
}
