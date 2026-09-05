import { Marked } from 'marked';
import { getChangelogContent, parseChangelog } from '@/lib/changelog';

const marked = new Marked({ gfm: true });

export default async function ChangelogPage() {
  const raw = await getChangelogContent();
  const entries = parseChangelog(raw);

  const renderBody = (body: string) => {
    const html = marked.parse(body, { async: false }) as string;
    return { __html: html };
  };

  return (
    <section className="changelog-page">
      <h1>Changelog</h1>
      <p className="subtitle">All notable changes to Spacron.</p>
      <div className="changelog-content">
        {entries.map((entry) => (
          <article key={entry.version}>
            <h2 id={`v${entry.version}`}>
              <a href={`#v${entry.version}`}>v{entry.version}</a>
              <span style={{ fontWeight: 400, fontSize: '0.85rem', color: 'var(--text-dim)', marginLeft: '0.75rem' }}>
                {entry.date}
              </span>
            </h2>
            <div dangerouslySetInnerHTML={renderBody(entry.body)} />
          </article>
        ))}
      </div>
    </section>
  );
}
