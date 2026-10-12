import { hillFormula, totalCharge, type Molecule } from '../chem/molecule';

/** Hill formula with subscripts and the net charge as a superscript. */
export function Formula({ m }: { m: Molecule }) {
  const q = totalCharge(m);
  return (
    <span className="formula">
      {hillFormula(m).map((p) => (
        <span key={p.symbol}>
          {p.symbol}
          {p.count > 1 && <sub>{p.count}</sub>}
        </span>
      ))}
      {q !== 0 && <sup>{`${Math.abs(q) > 1 ? Math.abs(q) : ''}${q > 0 ? '+' : '−'}`}</sup>}
    </span>
  );
}
