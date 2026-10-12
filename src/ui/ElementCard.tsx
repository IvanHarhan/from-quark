import { useEffect, useState, type ReactNode } from 'react';
import { followsMadelung, formatSubshells, madelung } from '../chem/aufbau';
import { element, isotopeMass, isotopesOf, loadIsotopes } from '../data/db';
import { ELEMENT_FIELD_SOURCE } from '../data/sources';
import type { Isotope, SourceId } from '../data/types';
import { elementName, formatDuration, formatNumber, hasKey, prettyDecay, type Lang, type MessageKey } from '../i18n';
import { BLOCK_COLORS } from './PeriodicTable';
import { SourceTag } from './SourceTag';
import { useApp } from './store';
import { useT } from './useT';

const ISOTOPES_SHOWN = 12;

function Row({ label, src, children }: { label: string; src?: SourceId; children: ReactNode }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className="value">
        {children}
        {src && <SourceTag id={src} />}
      </span>
    </div>
  );
}

function kelvin(lang: Lang, k: number) {
  return `${formatNumber(lang, k - 273.15, 4)} °C (${formatNumber(lang, k, 4)} K)`;
}

/** Natural isotopes by abundance first, then the rest by half-life, longest first. */
function sortIsotopes(list: Isotope[]): Isotope[] {
  const life = (i: Isotope) => (i.stable ? Infinity : (i.halfLife ?? -1));
  return [...list].sort((a, b) => (b.abundance ?? -1) - (a.abundance ?? -1) || life(b) - life(a));
}

export function ElementCard() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const z = useApp((s) => s.selectedZ);
  const select = useApp((s) => s.selectElement);
  const [loaded, setLoaded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    loadIsotopes().then(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => setShowAll(false), [z]);

  const e = z ? element(z) : undefined;
  if (!e) return null;
  const src = ELEMENT_FIELD_SOURCE;
  const madelungOk = followsMadelung(e.config);
  const isotopes = loaded ? sortIsotopes(isotopesOf(e.z)) : [];
  const shown = showAll ? isotopes : isotopes.slice(0, ISOTOPES_SHOWN);

  return (
    <div className="panel card-panel">
      <div className="panel-head">
        <div className="card-title">
          <div className="big-sym" style={{ background: BLOCK_COLORS[e.block] }}>
            <span className="z">{e.z}</span>
            {e.symbol}
          </div>
          <div>
            <h2>{elementName(lang, e)}</h2>
            <div className="muted">{t(`block.${e.block}` as MessageKey)}</div>
          </div>
        </div>
        <button className="ghost" onClick={() => select(null)} aria-label={t('table.close')}>✕</button>
      </div>

      <div className="rows">
        <Row label={t('card.mass')} src={e.massSource}>
          {e.massNumber === null
            ? `${formatNumber(lang, e.mass, 6)}${e.massUncertainty ? ` ± ${formatNumber(lang, e.massUncertainty)}` : ''}`
            : `[${formatNumber(lang, e.mass, 6)}] — ${t('card.massLongest', { a: `${e.symbol}-${e.massNumber}` })}`}
        </Row>
        <Row label={t('card.config')} src={src.config}>
          {e.config}
          {e.configPredicted && <span className="muted"> ({t('card.configPredicted')})</span>}
        </Row>
        {!madelungOk && (
          <Row label={t('card.madelung')}>
            <span className="warn">{formatSubshells(madelung(e.z))} — {t('card.madelungException')}</span>
          </Row>
        )}
        {e.electronegativity !== null && (
          <Row label={t('card.electronegativity')} src={src.electronegativity}>{formatNumber(lang, e.electronegativity)}</Row>
        )}
        {e.ionization !== null && (
          <Row label={t('card.ionization')} src={src.ionization}>{formatNumber(lang, e.ionization, 5)} eV</Row>
        )}
        {e.electronAffinity !== null && (
          <Row label={t('card.electronAffinity')} src={src.electronAffinity}>{formatNumber(lang, e.electronAffinity)} eV</Row>
        )}
        {e.radius !== null && <Row label={t('card.radius')} src={src.radius}>{e.radius} pm</Row>}
        {e.oxidationStates.length > 0 && (
          <Row label={t('card.oxidation')} src={src.oxidationStates}>
            {e.oxidationStates.map((n) => (n > 0 ? `+${n}` : String(n))).join(', ')}
          </Row>
        )}
        {e.standardState && (
          <Row label={t('card.state')} src={src.standardState}>{t(`state.${e.standardState}`)}</Row>
        )}
        {e.meltingPoint !== null && <Row label={t('card.melting')} src={src.meltingPoint}>{kelvin(lang, e.meltingPoint)}</Row>}
        {e.boilingPoint !== null && <Row label={t('card.boiling')} src={src.boilingPoint}>{kelvin(lang, e.boilingPoint)}</Row>}
        {e.density !== null && (
          <Row label={t('card.density')} src={src.density}>{formatNumber(lang, e.density, 4)} g/cm³</Row>
        )}
      </div>

      <h3>
        {t('card.isotopes')} {loaded && <span className="muted">({isotopes.length})</span>} <SourceTag id="nubase2020" />
      </h3>
      {!loaded ? (
        <div className="muted">{t('card.isotopesLoading')}</div>
      ) : (
        <>
          <table className="iso">
            <thead>
              <tr>
                <th />
                <th>{t('iso.mass')}</th>
                <th>{t('iso.abundance')}</th>
                <th>{t('iso.halfLife')}</th>
                <th>{t('iso.decay')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.a} className={i.stable ? 'stable' : ''}>
                  <td className="nuc">
                    <sup>{i.a}</sup>
                    {e.symbol}
                  </td>
                  <td title={i.estimated ? t('iso.estimated') : undefined}>
                    {isotopeMass(i).toFixed(i.estimated ? 3 : 6)}
                    {i.estimated && '#'}
                  </td>
                  <td>{i.abundance !== null ? `${formatNumber(lang, i.abundance, 4)}%` : ''}</td>
                  <td>
                    {i.stable
                      ? t('iso.stable')
                      : i.halfLife !== null
                        ? formatDuration(lang, i.halfLife)
                        : t('iso.unbound')}
                  </td>
                  <td>
                    {i.decays.map((d, k) => (
                      <span key={k} className="decay" title={hasKey(`decay.${d.mode}`) ? t(`decay.${d.mode}` as MessageKey) : d.mode}>
                        {prettyDecay(d.mode)}
                        {d.percent !== null && d.percent < 100 && ` ${d.rel === '=' ? '' : d.rel}${formatNumber(lang, d.percent)}%`}
                        {d.percent === null && ' ?'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isotopes.length > ISOTOPES_SHOWN && (
            <button className="ghost more" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('card.showLess') : t('card.showAll', { n: isotopes.length })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
