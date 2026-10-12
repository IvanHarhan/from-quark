import { useRef, useState } from 'react';
import { formulaString } from '../chem/molecule';
import { lookupMolecule } from '../chem/lookup';
import { element } from '../data/db';
import { useBuilder } from '../game/builder';
import { useInventory, type InventoryItem } from '../game/inventory';
import { useMolecule } from '../game/moleculeBuilder';
import { elementName } from '../i18n';
import { Formula } from './Formula';
import { Nuclide } from './Nuclide';
import { useApp } from './store';
import { useT } from './useT';

export function Inventory() {
  const t = useT();
  const lang = useApp((s) => s.lang);
  const { items, remove, exportJson, importJson } = useInventory();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fromquark-inventory.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (file: File) => {
    try {
      setMsg(t('inv.imported', { n: importJson(await file.text()) }));
    } catch {
      setMsg(t('inv.importBad'));
    }
  };

  const open = (it: InventoryItem) => {
    if (it.kind === 'atom') {
      useBuilder.getState().setAtom(it.z, it.a, it.electrons);
      useApp.getState().setView('atom');
    } else {
      useMolecule.getState().load(it.molecule);
      useApp.getState().setView('molecule');
    }
  };

  const name = (it: InventoryItem) => {
    if (it.kind === 'atom') return elementName(lang, element(it.z)!);
    const ref = lookupMolecule(it.molecule);
    return ref ? ref[lang] : formulaString(it.molecule);
  };

  return (
    <div className="panel inventory-panel">
      <div className="panel-head">
        <h2>{t('inv.title')}</h2>
        <button className="ghost" onClick={() => useApp.getState().setInventoryOpen(false)} aria-label={t('table.close')}>✕</button>
      </div>
      {items.length === 0 ? (
        <div className="muted">{t('inv.empty')}</div>
      ) : (
        <div className="inv-list">
          {items.map((it) => (
            <div key={it.id} className="inv-row">
              <span className="inv-nuc">
                {it.kind === 'atom' ? <Nuclide z={it.z} a={it.a} charge={it.z - it.electrons} /> : <Formula m={it.molecule} />}
              </span>
              <span className="inv-name">{name(it)}</span>
              <button onClick={() => open(it)}>{t(it.kind === 'atom' ? 'inv.load' : 'inv.loadMolecule')}</button>
              <button className="ghost" onClick={() => remove(it.id)} title={t('inv.remove')}>🗑</button>
            </div>
          ))}
        </div>
      )}
      <div className="inv-actions">
        <button onClick={doExport} disabled={items.length === 0}>{t('inv.export')}</button>
        <button onClick={() => fileRef.current?.click()}>{t('inv.import')}</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImport(f);
            e.target.value = '';
          }}
        />
      </div>
      {msg && <div className="small muted">{msg}</div>}
    </div>
  );
}
