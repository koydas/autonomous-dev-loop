// site-kit renderer for Node-built sites. Pure: templates + nav.json in, HTML strings out. No dependency.
// A Python twin (render.py) implements the same template language; scripts/tests prove both give identical output.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), 'utf8');
const NAV = JSON.parse(read('nav.json'));
const TEMPLATES = { header: read('header.html'), footer: read('footer.html'), pagehead: read('pagehead.html') };

export const SITES = NAV.sites;
export const kitVersion = () => JSON.parse(read('KIT.json')).version;
export const tokensCss = () => read('tokens.css');
export const shellCss = () => read('shell.css');

const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function expand(template, vars, sites) {
  const looped = template.replace(/\{\{#sites\}\}([\s\S]*?)\{\{\/sites\}\}/g, (_, body) =>
    sites.map((s) => body.replace(/\{\{s\.(\w+)\}\}/g, (__, k) => (k === 'cur' ? s.cur : esc(s[k])))).join(''),
  );
  return looped.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`site-kit: unknown placeholder {{${k}}}`);
    return esc(vars[k]);
  });
}

function context(currentId) {
  const site = SITES.find((s) => s.id === currentId);
  if (!site) throw new Error(`site-kit: unknown site "${currentId}"`);
  return {
    vars: {
      version: kitVersion(),
      site_id: site.id,
      site_name: site.name,
      site_url: site.url,
      repo_url: `https://github.com/${site.repo}`,
      repo_name: site.repo,
      portfolio_url: SITES[0].url,
      identity: NAV.identity,
    },
    sites: SITES.map((s) => ({ ...s, cur: s.id === currentId ? ' aria-current="true"' : '' })),
  };
}

export const renderHeader = (currentId) => {
  const c = context(currentId);
  return expand(TEMPLATES.header, c.vars, c.sites);
};
export const renderFooter = (currentId) => {
  const c = context(currentId);
  return expand(TEMPLATES.footer, c.vars, c.sites);
};
export const renderPageHead = ({ eyebrow, title, lede }) => expand(TEMPLATES.pagehead, { eyebrow, title, lede }, []);
/** tokens + shell, ready for an inline <style>. */
export const kitCss = () => `${tokensCss()}\n${shellCss()}`;
