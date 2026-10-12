import { formatSubshells, ionConfig } from '../chem/aufbau';
import { meanRadius, slaterZeff } from '../chem/orbitals';
import { element, isotope } from '../data/db';
import { useZoom } from '../game/zoomState';
import { microstructure, type ZoomLevel } from '../render/micro/zoomView';
import { elementName, formatNumber, type MessageKey } from '../i18n';
import { Nuclide } from './Nuclide';
import { SourceTag } from './SourceTag';
import { useApp } from './store';
import { useT } from './useT';

const LEVELS: ZoomLevel[] = ['bulk', 'molecules', 'atom', 'nucleus', 'nucleon', 'quark'];
const C0 = 273.15;
/** Mass excesses of ¹H and the neutron, keV (AME2020/NUBASE2020). */
const DELTA_H = 7288.971064;
const DELTA_N = 8071.3181;

function scaleText(lang: 'ru' | 'en', m: number): string {
  const units: [number, string, string][] = [
    [1e-3, 'мм', 'mm'], [1e-6, 'мкм', 'µm'], [1e-9, 'нм', 'nm'], [1e-12, 'пм', 'pm'], [1e-15, 'фм', 'fm'],
  ];
  const u = units.find(([f]) => m >= f) ?? units[units.length - 1];
  return `${formatNumber(lang, m / u[0], 3)} ${lang === 'ru' ? u[1] : u[2]}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

export function ZoomPanel() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const spec = useZoom((s) => s.spec);
  const info = useZoom((s) => s.info);
  const jump = useZoom((s) => s.requestJump);
  const mode = useZoom((s) => s.mode);
  const setMode = useZoom((s) => s.setMode);
  if (!spec) return null;
  const level = info?.level ?? 'bulk';
  const ms = microstructure(spec.substance, spec.phase);
  const z = info?.focusZ ?? 8;
  const el = element(z)!;
  const shells = ionConfig(z, z);
  const outer = shells[shells.length - 1];
  const zeff = slaterZeff(z, shells, outer);
  const A = info?.isotopeA ?? 16;
  const N = A - z;
  const iso = (() => {
    try {
      return isotope(z, A);
    } catch {
      return undefined;
    }
  })();
  const bindingPerNucleon = iso ? (z * DELTA_H + N * DELTA_N - iso.massExcess) / A / 1000 : null;

  return (
    <>
      <div className="hud zoom-top">
        <div className="zoom-scale">
          <span className="scale-bar" />
          {info ? scaleText(lang, info.width) : '…'}
          <span className="muted"> · {t(`zoom.level.${level}` as MessageKey)}</span>
        </div>
        <div className="seg">
          {LEVELS.map((l) => (
            <button key={l} className={level === l ? 'active' : ''} onClick={() => jump(l)}>
              {t(`zoom.level.${l}` as MessageKey)}
            </button>
          ))}
        </div>
        <div className="seg">
          {(['textbook', 'microscope'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {t(`zoom.mode.${m}`)}
            </button>
          ))}
        </div>
        <button onClick={() => useApp.getState().setView('lab')}>← {t('view.lab')} (Esc)</button>
      </div>

      <div className="panel zoom-info">
        <h3>
          {spec.substance[lang]} · {t(`state.${spec.phase}` as MessageKey)} · {formatNumber(lang, spec.temperature - C0, 4)} °C
        </h3>
        {spec.substance.note && <div className="small muted note">{spec.substance.note[lang]}</div>}
        {level === 'bulk' && (
          <div className="rows">
            {info && <Row label={t('zoom.spacing')}>{formatNumber(lang, info.spacing, 3)} Å</Row>}
            <div className="small muted note">
              {ms.kind === 'grains'
                ? t('zoom.bulk.grains', { size: scaleText(lang, ms.size) })
                : t(ms.kind === 'cells' ? 'zoom.bulk.cells' : 'zoom.bulk.none')}
            </div>
            <div className="small muted note">{t('zoom.bulk.light')}</div>
          </div>
        )}
        {level === 'molecules' && (
          <div className="rows">
            <Row label={t('zoom.particles')}>{info?.molecules ?? '…'}</Row>
            {info && <Row label={t('zoom.spacing')}>{formatNumber(lang, info.spacing, 3)} Å</Row>}
            {spec.substance.id === 'water' && spec.phase !== 'gas' && (
              <Row label={t('zoom.hbonds')}>{formatNumber(lang, info?.hbondsPerMolecule ?? 0, 2)}</Row>
            )}
            <div className="small muted note">{t(`zoom.structure.${spec.phase}` as MessageKey)}</div>
            <div className="small muted note">{t(mode === 'textbook' ? 'zoom.lookTb' : 'zoom.look')}</div>
            <div className="small muted note">{t('zoom.slowmo')}</div>
          </div>
        )}
        {level === 'atom' && (
          <div className="rows">
            <Row label={t('zoom.atom')}>
              {elementName(lang, el)} ({el.symbol}, Z = {z})
            </Row>
            <Row label={t('b.config')}>
              <span className="config">{formatSubshells(shells)}</span>
            </Row>
            <Row label={t('zoom.zeff')}>
              {formatNumber(lang, zeff, 3)} <SourceTag id="slater" />
            </Row>
            <Row label={t('zoom.radius')}>{formatNumber(lang, meanRadius(outer.n, outer.l, zeff) * 100, 3)} pm</Row>
            {el.ionization !== null && (
              <Row label={t('b.ionization')}>
                {formatNumber(lang, el.ionization, 5)} eV <SourceTag id="pubchem" />
              </Row>
            )}
            <div className="small muted note">{t(mode === 'textbook' ? 'zoom.atomTb' : 'zoom.cloudNote')}</div>
          </div>
        )}
        {level === 'nucleus' && (
          <div className="rows">
            <Row label={t('zoom.isotope')}>
              <Nuclide z={z} a={A} showZ /> <SourceTag id="nubase2020" />
            </Row>
            <Row label={t('zoom.composition')}>
              {z} p + {N} n
            </Row>
            <Row label={t('zoom.nucRadius')}>{formatNumber(lang, 1.2 * Math.cbrt(A), 3)} fm</Row>
            {bindingPerNucleon !== null && (
              <Row label={t('zoom.binding')}>{formatNumber(lang, bindingPerNucleon, 4)} MeV</Row>
            )}
            {iso?.abundance != null && <Row label={t('iso.abundance')}>{formatNumber(lang, iso.abundance, 4)}%</Row>}
            <div className="small muted note">{t('zoom.nucleusNote')}</div>
          </div>
        )}
        {level === 'nucleon' && (
          <div className="rows">
            <Row label={t('zoom.proton')}>uud · +⅔ +⅔ −⅓ = +1</Row>
            <Row label={t('zoom.protonMass')}>
              938,272 MeV/c² <SourceTag id="pdg" />
            </Row>
            <Row label={t('zoom.quarkMass')}>
              u 2,16 · d 4,70 MeV/c² <SourceTag id="pdg" />
            </Row>
            <div className="small muted note">{t('zoom.protonInside')}</div>
            <div className="small muted note">{t('zoom.massNote')}</div>
            <div className="small muted note">{t('zoom.colorNote')}</div>
          </div>
        )}
        {level === 'quark' && (
          <div className="rows">
            <Row label={t('zoom.quarkSize')}>&lt; 10⁻¹⁹ m</Row>
            <Row label={t('zoom.quarkMass')}>
              u 2,16 MeV/c² <SourceTag id="pdg" />
            </Row>
            <div className="small muted note">{t('zoom.quarkNote')}</div>
            <div className="small muted note">{t('zoom.quarkDeeper')}</div>
          </div>
        )}
      </div>
    </>
  );
}
