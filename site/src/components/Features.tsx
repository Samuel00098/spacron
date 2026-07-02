import { features } from '@/lib/config';

const spans = ['big', '', '', 'full', '', '', ''];
const delays = [0, 0.06, 0.12, 0.06, 0.18, 0.24, 0.30];

export function Features() {
  return (
    <section id="features">
      <div className="container">
        <div className="section-head reveal max-w-[640px]">
          <span className="eyebrow">Everything in one window</span>
          <h2 className="section-title">A whole workflow, no tab-hopping.</h2>
          <p className="section-sub">
            Terminal, editor, preview, and Git — unified and keyboard-driven, so you stay in flow
            instead of juggling apps.
          </p>
        </div>

        <div className="bento">
          {features.map((f, i) => (
            <article
              key={f.title}
              className={`tile glass reveal-lift ${spans[i] ?? ''}`}
              style={{
                ['--c' as string]: f.accent,
                transitionDelay: `${delays[i]}s`,
              }}
            >
              <span className="glyph" aria-hidden="true" />
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
