import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('Home is the initial view and logo, icon and keyboard navigation select it', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../web/app.ts', import.meta.url), 'utf8');
  let focused: unknown;
  const elements = new Map<string, {
    hidden: boolean; tabIndex: number; attributes: Map<string, string>; onclick?: () => void;
    focus: () => void; click: () => void; setAttribute: (name: string, value: string) => void;
    addEventListener: (name: string, listener: (event: any) => void) => void;
    querySelectorAll: () => unknown[];
  }>();
  const listeners = new Map<string, (event: any) => void>();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const attributes = new Map(Array.from(match[0].matchAll(/([\w-]+)="([^"]*)"/g), m => [m[1], m[2]]));
    const el = {
      hidden: /\bhidden\b/.test(match[0]), tabIndex: Number(attributes.get('tabindex') ?? 0), attributes,
      onclick: undefined as (() => void) | undefined,
      focus() { focused = el; }, click() { el.onclick?.(); },
      setAttribute(name: string, value: string) { attributes.set(name, value); },
      addEventListener(name: string, listener: (event: any) => void) { listeners.set(`${match[1]}:${name}`, listener); },
      querySelectorAll() { return tabs; },
    };
    elements.set(match[1], el);
  }
  const tabs = ['home', 'containers', 'files', 'build-processes', 'github'].map(id => elements.get(`${id}-tab`)!);
  const document = { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [], get activeElement() { return focused; } };
  const js = ts.transpileModule(source.replace(/^import .*;\n/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(js, { document, createGitHubView: () => ({ setActive() {}, refresh() {}, close() {} }), window: { addEventListener() {} }, fetch: () => new Promise(() => {}), clearTimeout, setTimeout });
  const expectView = (selected: string) => {
    for (const id of ['home', 'containers', 'files', 'build-processes', 'github']) {
      assert.equal(elements.get(`${id}-panel`)!.hidden, id !== selected);
      assert.equal(elements.get(`${id}-tab`)!.attributes.get('aria-selected'), String(id === selected));
      assert.equal(elements.get(`${id}-tab`)!.tabIndex, id === selected ? 0 : -1);
    }
  };
  expectView('home');
  elements.get('containers-tab')!.click(); expectView('containers');
  elements.get('home-logo')!.click(); expectView('home');
  assert.equal(focused, tabs[0]);
  elements.get('files-tab')!.click(); expectView('files');
  elements.get('home-tab')!.click(); expectView('home');
  const key = (value: string) => listeners.get('tabs:keydown')!({ key: value, preventDefault() {} });
  tabs[0].focus(); key('ArrowRight'); expectView('containers');
  key('Home'); expectView('home');
  key('ArrowLeft'); expectView('github');
  key('ArrowRight'); expectView('home');
  assert.equal(tabs[0].attributes.get('aria-label'), 'Home');
  assert.match(html, /id="home-tab"[^>]*><svg/);
});
