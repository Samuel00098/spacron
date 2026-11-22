import type { DeviceProfile } from './deviceProfile';
import './FoldableExterior.css';

/** Outer face of an opened book-style foldable. The cover is inactive while
 * the inner screen owns the stream; never mirror inner content onto it. */
export function FoldableExterior({ brand }: { brand: DeviceProfile['brand'] }) {
  const lenses = brand === 'apple' ? 2 : 3;
  return <div className="fold-exterior" data-brand={brand} aria-hidden="true">
    <div className="fold-exterior-back">
      <div className="fold-exterior-cameras">
        {Array.from({ length: lenses }, (_, index) => <span key={index} className="fold-exterior-lens"><i /></span>)}
        <span className="fold-exterior-flash" />
      </div>
      {brand !== 'generic' && <span className="fold-exterior-brand">{brand === 'google' ? 'G' : brand === 'samsung' ? 'SAMSUNG' : brand === 'xiaomi' ? 'Xiaomi' : 'iPhone'}</span>}
    </div>
    <div className="fold-exterior-hinge" />
    <div className="fold-exterior-cover"><span className="fold-exterior-camera" /></div>
  </div>;
}
