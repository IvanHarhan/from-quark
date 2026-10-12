// Downloads raw reference data into data-raw/. Run once; build-db.ts works offline afterwards.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RAW = join(import.meta.dirname, '../../data-raw');

const files: { name: string; url: string }[] = [
  { name: 'pubchem-periodictable.json', url: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/periodictable/JSON' },
  { name: 'nubase_4.mas20.txt', url: 'https://www-nds.iaea.org/amdc/ame2020/nubase_4.mas20.txt' },
  { name: 'ciaaw-abridged.htm', url: 'https://www.ciaaw.org/abridged-atomic-weights.htm' },
  // mendeleev package DB (SQLite): Pyykkö single/double/triple covalent radii with citations.
  { name: 'mendeleev-elements.db', url: 'https://github.com/lmmentel/mendeleev/raw/master/mendeleev/elements.db' },
];

await mkdir(RAW, { recursive: true });
for (const f of files) {
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (new TextDecoder().decode(body.subarray(0, 4096)).includes('challenge-platform')) {
    throw new Error(`${f.url}: blocked by a bot challenge page`);
  }
  await writeFile(join(RAW, f.name), body);
  console.log(`${f.name}: ${body.length} bytes`);
}
