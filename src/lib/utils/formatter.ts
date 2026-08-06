// Prettier and its parsers are imported DYNAMICALLY, and only the parsers the
// file at hand actually needs. Statically importing them cost ~1.7 MB in the
// chunk seeded by `stores/editor.ts` — paid on startup by every session, for a
// command most never run. Formatting is already async and only fires on an
// explicit format action, so there is no reason to load any of it earlier.

type PluginLoader = () => Promise<any>;

const babel: PluginLoader = () => import('prettier/plugins/babel');
const estree: PluginLoader = () => import('prettier/plugins/estree');
const postcss: PluginLoader = () => import('prettier/plugins/postcss');
const htmlPlugin: PluginLoader = () => import('prettier/plugins/html');
const markdownPlugin: PluginLoader = () => import('prettier/plugins/markdown');
const yamlPlugin: PluginLoader = () => import('prettier/plugins/yaml');
const sveltePlugin: PluginLoader = () => import('prettier-plugin-svelte/browser');

/** Prettier parser name + the plugins it needs, keyed by file extension. */
const FORMATTERS: Record<string, { parser: string; plugins: PluginLoader[] }> = {
  js: { parser: 'babel', plugins: [babel, estree] },
  jsx: { parser: 'babel', plugins: [babel, estree] },
  mjs: { parser: 'babel', plugins: [babel, estree] },
  cjs: { parser: 'babel', plugins: [babel, estree] },
  ts: { parser: 'babel-ts', plugins: [babel, estree] },
  tsx: { parser: 'babel-ts', plugins: [babel, estree] },
  json: { parser: 'json', plugins: [babel, estree] },
  css: { parser: 'css', plugins: [postcss] },
  scss: { parser: 'scss', plugins: [postcss] },
  less: { parser: 'less', plugins: [postcss] },
  html: { parser: 'html', plugins: [htmlPlugin, postcss, babel, estree] },
  htm: { parser: 'html', plugins: [htmlPlugin, postcss, babel, estree] },
  svelte: { parser: 'svelte', plugins: [sveltePlugin, babel, estree, postcss] },
  md: { parser: 'markdown', plugins: [markdownPlugin] },
  markdown: { parser: 'markdown', plugins: [markdownPlugin] },
  yaml: { parser: 'yaml', plugins: [yamlPlugin] },
  yml: { parser: 'yaml', plugins: [yamlPlugin] },
};

export async function formatCode(content: string, filepath: string): Promise<string> {
  const ext = filepath.split('.').pop()?.toLowerCase();
  const config = ext ? FORMATTERS[ext] : undefined;

  // Unsupported extension, return original content as-is
  if (!config) return content;

  // Fetch prettier and the needed parsers together, so formatting a .css file
  // never pulls in the babel/html/markdown/yaml/svelte parsers.
  const [prettier, plugins] = await Promise.all([
    import('prettier/standalone'),
    Promise.all(config.plugins.map((load) => load())),
  ]);

  try {
    const formatted = await prettier.format(content, {
      parser: config.parser,
      plugins,
      semi: true,
      singleQuote: true,
      tabWidth: 2,
      trailingComma: 'es5',
      printWidth: 80,
    });
    return formatted;
  } catch (err) {
    console.error('Formatter error:', err);
    throw err;
  }
}
