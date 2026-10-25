import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real doc module, DOM helpers and Markdown parser. Replace canvas services
// (their imports boot the application) and the browser/editor boundaries only.
const services = vi.hoisted(() => ({
  gone: (_el: HTMLElement) => {},
  theme: () => {},
  refs: {} as { copy(el: HTMLElement): string; content(el: HTMLElement, label: string): { text: string } },
  tool: {} as { update(el: HTMLElement, args: { text: string }): void },
  save: () => [] as { text: string }[],
  load: (_docs: { id: string; title: string; text: string; rect: object }[]) => {},
  quit: () => {},
  draft: '',
  destroy: vi.fn(),
  changed: vi.fn(),
}));

vi.mock('../src/canvas/core/items', () => ({
  items: () => [...document.querySelectorAll('.mdoc')],
  savedRect: () => ({ x: 0, y: 0, w: 420, h: 360 }),
  onGone: (fn: typeof services.gone) => {
    services.gone = fn;
  },
}));
vi.mock('../src/canvas/core/placement', () => ({ centerOn: vi.fn(), freeSpot: (rect: object) => rect }));
vi.mock('../src/canvas/core/refs', () => ({
  referable: (_kind: string, refs: typeof services.refs) => {
    services.refs = refs;
  },
}));
vi.mock('../src/canvas/core/tools', () => ({
  creatable: (_kind: string, tool: typeof services.tool) => {
    services.tool = tool;
  },
}));
vi.mock('../src/canvas/core/view', () => ({ changed: services.changed, viewCenter: () => ({ x: 0, y: 0 }) }));
vi.mock('../src/canvas/core/window', () => ({
  makeWindow: ({ title, actions }: { title: string; actions: HTMLElement[] }) => {
    const el = document.createElement('section');
    el.className = 'mdoc';
    el.innerHTML = '<header class="win-h"><span class="t"></span></header><div class="body"></div>';
    el.querySelector('.t')!.textContent = title;
    el.querySelector('header')!.append(...actions);
    document.body.append(el);
    return { el, body: el.querySelector('.body')! };
  },
  removeButton: () => document.createElement('button'),
  winTitle: (el: HTMLElement) => el.querySelector('.t')!.textContent,
}));
vi.mock('../src/lib/prefs', () => ({ onPrefs: vi.fn(), prefs: () => ({ vim: 'off' }) }));
vi.mock('../src/lib/theme', () => ({
  onTheme: (fn: typeof services.theme) => {
    services.theme = fn;
  },
}));
vi.mock('../src/lib/store', () => ({
  persist: (_key: string, save: typeof services.save, load: typeof services.load) => {
    services.save = save;
    services.load = load;
  },
  each: (docs: object[], fn: (doc: object) => void) => docs.forEach(fn),
}));
vi.mock('../src/lib/codeedit', () => ({
  codeEditor: vi.fn(async (_box: HTMLElement, opts: { text: string; quit(): void }) => {
    services.draft = opts.text;
    services.quit = opts.quit;
    return {
      text: () => services.draft,
      setText: (text: string) => {
        services.draft = text;
      },
      destroy: services.destroy,
      focus: vi.fn(),
    };
  }),
}));
vi.mock('../src/lib/markdown', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/markdown')>();
  return { ...original, md: vi.fn(original.md), enhance: vi.fn() };
});

// Stateful fake: models observe/unobserve and lets a test deliver browser events.
// deliver() also allows a queued entry after unobserve/removal, as browsers can do.
class FakeIntersectionObserver {
  static instance: FakeIntersectionObserver;
  observed = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instance = this;
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  deliver(el: Element, isIntersecting = true) {
    this.callback(
      [{ target: el, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

let docWindow: typeof import('../src/items/doc').docWindow;
let md: typeof import('../src/lib/markdown').md;
let observer: FakeIntersectionObserver;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.replaceChildren();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  ({ docWindow } = await import('../src/items/doc'));
  ({ md } = await import('../src/lib/markdown'));
  observer = FakeIntersectionObserver.instance;
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const preview = (el: HTMLElement) => el.querySelector<HTMLElement>('.mdoc-md')!;

describe('doc source preservation', () => {
  it('keeps the source without rendering a document before it is visible', () => {
    const el = docWindow({ text: '# Note' });
    expect(el.dataset.src).toBe('# Note');
    expect(preview(el).innerHTML).toBe('');
    expect(md).not.toHaveBeenCalled();
    expect(observer.observed.has(el)).toBe(true);
  });
});

describe('doc lazy rendering regressions', () => {
  it('renders only intersecting documents, once, using real Markdown output', () => {
    const visible = docWindow({ text: '# Visible' });
    const hidden = docWindow({ text: '# Hidden' });
    observer.deliver(hidden, false);
    expect(md).not.toHaveBeenCalled();
    observer.deliver(visible);
    expect(preview(visible).querySelector('h1')?.textContent).toBe('Visible');
    expect(preview(hidden).innerHTML).toBe('');
    expect(observer.observed.has(visible)).toBe(false);
    observer.deliver(visible, false);
    observer.deliver(visible);
    expect(md).toHaveBeenCalledTimes(1);
  });

  it('ignores a queued visibility event for a disconnected document', () => {
    const el = docWindow({ text: '# Removed' });
    el.remove();
    observer.deliver(el);
    expect(md).not.toHaveBeenCalled();
  });

  it('renders the latest source if a tool updates a document before first sight', () => {
    const el = docWindow({ text: 'Old' });
    services.tool.update(el, { text: '**Updated**' });
    expect(md).not.toHaveBeenCalled();
    observer.deliver(el);
    expect(preview(el).querySelector('strong')?.textContent).toBe('Updated');
  });

  it('redraws a rendered document only when its source changes', () => {
    const el = docWindow({ text: 'Original' });
    observer.deliver(el);
    services.tool.update(el, { text: 'Original' });
    expect(md).toHaveBeenCalledTimes(1);
    services.tool.update(el, { text: '**New**' });
    expect(md).toHaveBeenCalledTimes(2);
    expect(preview(el).querySelector('strong')?.textContent).toBe('New');
  });

  it('redraws only previously rendered documents on theme changes', () => {
    const visible = docWindow({ text: 'Visible' });
    const hidden = docWindow({ text: 'Hidden' });
    observer.deliver(visible);
    services.theme();
    expect(md).toHaveBeenCalledTimes(2);
    expect(preview(hidden).innerHTML).toBe('');
    observer.deliver(hidden);
    expect(md).toHaveBeenLastCalledWith('Hidden');
  });

  it('keeps references and persistence available before rendering, including restore', () => {
    const el = docWindow({ id: 'note-1', title: 'My note', text: '# Source' });
    expect(services.refs.copy(el)).toBe('# Source');
    expect(services.refs.content(el, 'My note').text).toContain('# Source');
    const saved = services.save();
    expect(saved).toEqual([{ id: 'note-1', title: 'My note', text: '# Source', rect: { x: 0, y: 0, w: 420, h: 360 } }]);
    document.body.replaceChildren();
    services.load(saved as Parameters<typeof services.load>[0]);
    const restored = document.querySelector<HTMLElement>('.mdoc')!;
    expect(restored.dataset.src).toBe('# Source');
    expect(md).not.toHaveBeenCalled();
    observer.deliver(restored);
    expect(preview(restored).querySelector('h1')?.textContent).toBe('Source');
  });

  it('shows a placeholder for an empty document', () => {
    const el = docWindow();
    observer.deliver(el);
    expect(preview(el).querySelector('em')?.textContent).toBe('Empty. Double-click to write.');
  });

  it('rejects an oversized tool update without changing the source', () => {
    const el = docWindow({ text: 'Original' });
    expect(() => services.tool.update(el, { text: 'x'.repeat(20_001) })).toThrow('at most');
    expect(el.dataset.src).toBe('Original');
    expect(md).not.toHaveBeenCalled();
  });

  it('defers redraws while editing, then shows the latest source after a theme change', async () => {
    const el = docWindow({ text: 'Original' });
    observer.deliver(el);
    el.querySelector<HTMLButtonElement>('button[aria-label^="Edit"]')!.click();
    await vi.waitFor(() => expect(el.querySelector<HTMLElement>('.mdoc-b')!.hidden).toBe(true));
    services.tool.update(el, { text: '**Edited**' });
    services.theme();
    expect(md).toHaveBeenCalledTimes(1);
    expect(services.draft).toBe('**Edited**');
    services.quit();
    expect(services.destroy).toHaveBeenCalledTimes(1);
    expect(preview(el).querySelector('strong')?.textContent).toBe('Edited');
    expect(el.querySelector<HTMLElement>('.mdoc-b')!.hidden).toBe(false);
    expect(md).toHaveBeenCalledTimes(2);
  });

  it('stops observing and destroys the editor when a document is deleted', async () => {
    const el = docWindow({ text: 'Editing', edit: true });
    await vi.waitFor(() => expect(el.querySelector<HTMLElement>('.mdoc-b')!.hidden).toBe(true));
    services.gone(el);
    el.remove();
    expect(observer.observed.has(el)).toBe(false);
    expect(services.destroy).toHaveBeenCalledTimes(1);
    observer.deliver(el);
    expect(md).not.toHaveBeenCalled();
  });
});
