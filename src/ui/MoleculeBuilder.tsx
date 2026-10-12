import { useState } from 'react';
import { bondLength, bondKey, centerGeometry, measureAngle } from '../chem/geometry';
import {
  allowedValences,
  bondType,
  moleculeMass,
  neighbors,
  totalCharge,
  validate,
  type Issue,
  type Molecule,
} from '../chem/molecule';
import { moleculeFromEntry } from '../chem/lookup';
import { element, elementBySymbol } from '../data/db';
import { MOLECULES } from '../data/molecules';
import { useInventory } from '../game/inventory';
import { structureOf, useMolecule } from '../game/moleculeBuilder';
import { elementName, formatNumber, type MessageKey } from '../i18n';
import { Formula } from './Formula';
import { Nuclide } from './Nuclide';
import { SourceTag } from './SourceTag';
import { useApp } from './store';
import { useT } from './useT';

const QUICK = ['H', 'C', 'N', 'O', 'F', 'P', 'S', 'Cl', 'Br', 'I', 'Na', 'K', 'Mg', 'Ca', 'Al', 'Si', 'Fe', 'Cu', 'Xe'];
const ORDER_SIGN = ['', '–', '=', '≡'];

const label = (m: Molecule, i: number) => `${element(m.atoms[i].z)!.symbol}${i + 1}`;

function chargeText(q: number) {
  return q === 0 ? '0' : `${q > 0 ? '+' : '−'}${Math.abs(q)}`;
}

function Palette() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const items = useInventory((s) => s.items);
  const { molecule, selected, addAtom, saturate, clear, load, removeSelected, changeCharge } = useMolecule();
  const atoms = items.filter((i) => i.kind === 'atom');
  const sel = selected !== null ? molecule.atoms[selected] : null;

  return (
    <div className="panel palette-panel mol-palette">
      {atoms.length > 0 && (
        <>
          <h3>{t('m.fromInventory')}</h3>
          <div className="el-grid">
            {atoms.map((a) => (
              <button key={a.id} onClick={() => addAtom(a.z, a.z - a.electrons)} title={elementName(lang, element(a.z)!)}>
                <Nuclide z={a.z} a={a.a} charge={a.z - a.electrons} />
              </button>
            ))}
          </div>
        </>
      )}
      <h3>{t('m.elements')}</h3>
      <div className="el-grid">
        {QUICK.map((s) => {
          const el = elementBySymbol(s)!;
          return (
            <button key={s} onClick={() => addAtom(el.z)} title={elementName(lang, el)} style={{ borderColor: el.cpk }}>
              {s}
            </button>
          );
        })}
      </div>
      <h3>{t('m.presets')}</h3>
      <select
        value=""
        onChange={(e) => {
          const entry = MOLECULES.find((x) => x.id === e.target.value);
          if (entry) load(moleculeFromEntry(entry));
        }}
      >
        <option value="">{t('m.choosePreset')}</option>
        <optgroup label={t('m.inorganic')}>
          {MOLECULES.filter((x) => !x.organic).map((x) => (
            <option key={x.id} value={x.id}>{x[lang]}</option>
          ))}
        </optgroup>
        <optgroup label={t('m.organic')}>
          {MOLECULES.filter((x) => x.organic).map((x) => (
            <option key={x.id} value={x.id}>{x[lang]}</option>
          ))}
        </optgroup>
      </select>
      <div className="btn-row">
        <button onClick={saturate} disabled={molecule.atoms.length === 0}>{t('m.saturate')}</button>
        <button className="ghost" onClick={clear}>{t('b.clear')}</button>
      </div>

      {sel && selected !== null && (
        <div className="selected-atom">
          <h3>
            {t('m.selected')}: {label(molecule, selected)} · {elementName(lang, element(sel.z)!)}
          </h3>
          <div className="particle-row">
            <span className="particle-name">{t('b.charge')}</span>
            <button onClick={() => changeCharge(-1)}>−</button>
            <span className="count mono">{chargeText(sel.charge)}</span>
            <button onClick={() => changeCharge(1)}>+</button>
          </div>
          <div className="small muted">
            {t('m.valence')}: {allowedValences(sel.z, sel.charge).join(' / ')}
          </div>
          <button className="ghost danger" onClick={removeSelected}>{t('m.delete')} (Del)</button>
        </div>
      )}
    </div>
  );
}

function issueText(t: ReturnType<typeof useT>, lang: 'ru' | 'en', m: Molecule, is: Issue): string {
  switch (is.kind) {
    case 'empty':
      return t('m.issue.empty');
    case 'disconnected':
      return t('m.issue.disconnected', { n: is.parts });
    case 'tooManyBonds': {
      const a = m.atoms[is.atom];
      return t('m.issue.tooMany', {
        atom: label(m, is.atom),
        name: elementName(lang, element(a.z)!),
        bonds: is.bonds,
        max: is.max,
        allowed: allowedValences(a.z, a.charge).join(', '),
      });
    }
    case 'unsaturated':
      return t('m.issue.unsaturated', { atom: label(m, is.atom), missing: is.missing });
  }
}

function Info() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const molecule = useMolecule((s) => s.molecule);
  const addMolecule = useInventory((s) => s.addMolecule);
  const [saved, setSaved] = useState<{ m: Molecule; key: MessageKey } | null>(null);
  const { ref, positions } = structureOf(molecule);
  const v = validate(molecule);
  const empty = molecule.atoms.length === 0;

  // Group identical bonds: "C–H ×4".
  const bondRows = new Map<string, { key: string; order: number; z1: number; z2: number; count: number; len: ReturnType<typeof bondLength> }>();
  for (const b of molecule.bonds) {
    const key = bondKey(molecule, b);
    const row = bondRows.get(key);
    if (row) row.count++;
    else bondRows.set(key, { key, order: b.order, z1: molecule.atoms[b.a].z, z2: molecule.atoms[b.b].z, count: 1, len: bondLength(molecule, b, ref) });
  }

  const centers = molecule.atoms
    .map((_, i) => i)
    .filter((i) => neighbors(molecule, i).length >= 2)
    .map((i) => {
      const cg = centerGeometry(molecule, i, ref);
      const nb = neighbors(molecule, i);
      const angles: number[] = [];
      for (let k = 0; k < nb.length; k++)
        for (let l = k + 1; l < nb.length; l++) {
          const a = measureAngle(positions, i, nb[k], nb[l]);
          if (!angles.some((x) => Math.abs(x - a) < 1.5)) angles.push(a);
        }
      return { i, cg, angles: angles.sort((a, b) => a - b) };
    });

  return (
    <div className="panel builder-info mol-info">
      {empty ? (
        <div className="muted">{t('m.empty')}</div>
      ) : (
        <>
          <div className="big-nuclide">
            <Formula m={molecule} />
          </div>
          <div className="mol-name">
            {ref ? (
              <>
                {ref[lang]}{' '}
                <a className="src" href={`https://pubchem.ncbi.nlm.nih.gov/compound/${ref.cid}`} target="_blank" rel="noreferrer">
                  PubChem {ref.cid}
                </a>
              </>
            ) : (
              <span className="muted">{t('m.unknown')}</span>
            )}
          </div>
          {v.errors.length > 0 ? (
            <div className="status bad">
              {v.errors.map((e, k) => (
                <div key={k}>{issueText(t, lang, molecule, e)}</div>
              ))}
            </div>
          ) : v.warnings.length > 0 ? (
            <div className="status hot">
              {v.warnings.map((e, k) => (
                <div key={k}>{issueText(t, lang, molecule, e)}</div>
              ))}
            </div>
          ) : (
            <div className="status ok">{t('m.valid')}</div>
          )}
          <div className="rows">
            <div className="row">
              <span className="label">{t('m.molarMass')}</span>
              <span className="value">
                {formatNumber(lang, moleculeMass(molecule), 6)} g/mol
                <SourceTag id="ciaaw2024" />
              </span>
            </div>
            <div className="row">
              <span className="label">{t('b.charge')}</span>
              <span className="value">{chargeText(totalCharge(molecule))}</span>
            </div>
          </div>

          {bondRows.size > 0 && (
            <>
              <h3>{t('m.bonds')}</h3>
              <table className="iso">
                <tbody>
                  {[...bondRows.values()].map((r) => {
                    const bt = bondType(r.z1, r.z2);
                    const [s1, s2] = r.key.split(/[-=#]/);
                    return (
                      <tr key={r.key}>
                        <td className="nuc">
                          {s1}
                          {ORDER_SIGN[r.order]}
                          {s2}
                          {r.count > 1 && <span className="muted"> ×{r.count}</span>}
                        </td>
                        <td title={bt.dEN !== null ? `ΔEN = ${formatNumber(lang, bt.dEN, 2)}` : undefined}>
                          {t(`m.bond.${bt.type}` as MessageKey)}
                          {bt.dEN !== null && <span className="muted"> · Δχ {formatNumber(lang, bt.dEN, 2)}</span>}
                        </td>
                        <td>
                          {formatNumber(lang, r.len.value, 4)} Å
                          <SourceTag id={r.len.source} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {centers.length > 0 && v.errors.length === 0 && (
            <>
              <h3>{t('m.geometry')}</h3>
              <table className="iso">
                <tbody>
                  {centers.map(({ i, cg, angles }) => (
                    <tr key={i}>
                      <td className="nuc">{label(molecule, i)}</td>
                      <td>
                        {cg.geometry ? t(`geo.${cg.geometry}` as MessageKey) : '—'}
                        {cg.lonePairs > 0 && <span className="muted"> · {t('m.lonePairs', { n: cg.lonePairs })}</span>}
                      </td>
                      <td>
                        {angles.map((a) => `${formatNumber(lang, a, 4)}°`).join(', ')}
                        <SourceTag id={cg.source} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <button
            className="primary"
            disabled={!v.ok}
            onClick={() => setSaved({ m: molecule, key: addMolecule(molecule) ? 'b.saved' : 'b.already' })}
          >
            {saved?.m === molecule ? t(saved.key) : t('b.save')}
          </button>
          {!v.ok && <div className="small muted note">{t('m.saveHint')}</div>}
        </>
      )}
    </div>
  );
}

export function MoleculeBuilder() {
  const t = useT();
  const hovered = useMolecule((s) => s.hovered);
  const molecule = useMolecule((s) => s.molecule);
  const lang = useApp((s) => s.lang);
  const h = hovered !== null ? molecule.atoms[hovered] : null;
  return (
    <>
      <Palette />
      <Info />
      {h && hovered !== null && (
        <div className="hover-tip">
          {label(molecule, hovered)} · {elementName(lang, element(h.z)!)}
          {h.charge !== 0 && ` (${chargeText(h.charge)})`} · {t('m.bondsCount', { n: neighbors(molecule, hovered).length })}
        </div>
      )}
    </>
  );
}
