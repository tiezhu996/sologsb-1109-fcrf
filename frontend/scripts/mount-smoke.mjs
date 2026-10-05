import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
for (const key of ['ShadowRoot', 'DocumentFragment', 'MutationObserver', 'DOMParser', 'XMLSerializer', 'getSelection', 'scrollTo', 'scroll']) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = dom.window[key];
}
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = RO;
dom.window.ResizeObserver = RO;
dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = dom.window.matchMedia;

const errors = [];
dom.window.addEventListener('error', (e) => errors.push(e.error?.message ?? String(e.message)));
const origError = console.error;
console.error = (...args) => {
  const msg = String(args[0]);
  if (/React Router.*Future Flag/i.test(msg) || /reactrouter\.com/i.test(msg)) return;
  // jsdom 已知限制 / antd 弃用提示，非应用错误
  if (/Not implemented:.*getComputedStyle/i.test(msg) || /pseudo-elements?/i.test(msg)) return;
  if (/addonAfter.*deprecated/i.test(msg)) return;
  errors.push(msg);
  origError(...args);
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { createMemoryRouter, RouterProvider } = await import('react-router-dom');
const { App: AntApp } = await import('antd');
const { routes } = await import('../src/router/index.tsx');

const container = document.getElementById('root');
const router = createMemoryRouter(routes, { initialEntries: ['/batches'] });
createRoot(container).render(React.createElement(AntApp, null, React.createElement(RouterProvider, { router })));

const text = () => document.body.textContent ?? '';
const waitFor = async (check, { tries = 40, gap = 250 } = {}) => {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, gap));
  }
  return check();
};

const shellWords = ['炮制工序记录台', '恢复备份', '导出备份'];
for (const word of shellWords) {
  if (!(await waitFor(() => text().includes(word)))) throw new Error(`外壳未出现：${word}`);
  console.log(`PASS: 外壳包含「${word}」`);
}

// 工序记录台首屏（种子数据）应展示多来源相关文案
const pageWords = ['投料来源', '来源谱系', '导出投料台账', '拆批'];
for (const word of pageWords) {
  if (!(await waitFor(() => text().includes(word)))) throw new Error(`工序页未出现：${word}\n文本片段：${text().slice(0, 300)}`);
  console.log(`PASS: 工序页包含「${word}」`);
}

if (errors.length) throw new Error(`渲染期错误：${errors.slice(0, 3).join('; ')}`);
console.log('PASS: 渲染期无错误');

// 交互：打开「新建工序记录」弹窗，确认逐笔来源编辑器出现并可追加一笔
const { fireEvent } = await import('@testing-library/dom');
const openBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '新建工序记录');
if (!openBtn) throw new Error('找不到新建工序按钮');
fireEvent.pointerDown(openBtn);
fireEvent.mouseDown(openBtn);
fireEvent.click(openBtn);
if (!(await waitFor(() => text().includes('追加一笔来源')))) throw new Error('逐笔来源编辑器未出现：' + text().slice(-300));
console.log('PASS: 新建弹窗包含逐笔来源编辑器');

const addBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('追加一笔来源'));
if (!addBtn) throw new Error('找不到追加来源按钮');
fireEvent.click(addBtn);
await new Promise((r) => setTimeout(r, 400));
const typeCells = (document.body.textContent?.match(/上道工序成品|药材批次/g) ?? []).length;
if (typeCells < 2) throw new Error('追加来源笔次失败');
console.log('PASS: 可追加第二笔来源（支持拼批/拆分）');

if (errors.length) throw new Error(`交互期错误：${JSON.stringify(errors.slice(0, 3))}`);
console.log('PASS: 交互期无错误');
console.log('\n组件挂载冒烟通过');
process.exit(0);
