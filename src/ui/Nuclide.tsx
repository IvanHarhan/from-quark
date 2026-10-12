import { element } from '../data/db';
import type { Emitted } from '../nuclear/decay';

export function symbolOf(z: number): string {
  return z === 0 ? 'n' : (element(z)?.symbol ?? `E${z}`);
}

function chargeText(charge: number): string {
  if (charge === 0) return '';
  const n = Math.abs(charge);
  return `${n > 1 ? n : ''}${charge > 0 ? '+' : '−'}`;
}

/** ᴬ_Z X^charge in standard nuclide notation. */
export function Nuclide({ z, a, charge = 0, showZ = false }: { z: number; a: number; charge?: number; showZ?: boolean }) {
  return (
    <span className="nuclide">
      <span className="nuclide-idx">
        <sup>{a}</sup>
        {showZ && <sub>{z}</sub>}
      </span>
      {symbolOf(z)}
      {charge !== 0 && <sup>{chargeText(charge)}</sup>}
    </span>
  );
}

const PARTICLE_SYMBOL: Record<Exclude<Emitted['kind'], 'fragment'>, string> = {
  alpha: 'α',
  electron: 'e⁻',
  positron: 'e⁺',
  antineutrino: 'ν̄ₑ',
  neutrino: 'νₑ',
  neutron: 'n',
  proton: 'p',
  deuteron: 'd',
  triton: 't',
  gamma: 'γ',
};

export function EmittedList({ emitted }: { emitted: Emitted[] }) {
  return (
    <>
      {emitted.map((e, i) => (
        <span key={i}>
          {' + '}
          {e.kind === 'fragment' ? <Nuclide z={e.z} a={e.a} /> : PARTICLE_SYMBOL[e.kind]}
        </span>
      ))}
    </>
  );
}
