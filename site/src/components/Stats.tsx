import { stats } from '@/lib/config';

export function Stats() {
  return (
    <section className="!py-[clamp(40px,6vw,72px)]">
      <div className="container">
        <div className="section-head reveal max-w-[640px]">
          <span className="eyebrow">By the numbers</span>
          <h2 className="section-title">Built different, and it shows.</h2>
          <p className="section-sub">
            A fraction of the memory, instant startup, and one consistent space — no Electron, no bloat.
          </p>
        </div>

        <div className="stats-grid glass reveal">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className="stat-cell"
              style={{ transitionDelay: `${i * 0.08}s` }}
            >
              <span className="text-gradient-white block text-[clamp(1.5rem,3vw,2rem)] font-extrabold tracking-[-0.02em]">
                {s.value}
              </span>
              <span className="mt-1.5 block text-[0.92rem] font-semibold text-ink">{s.label}</span>
              <span className="mt-[3px] block text-[0.8rem] text-muted">{s.sub}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
