// Some parser-adjacent modules touch `window`/`document` when they load (in dev, Vite injects
// component CSS through document). Workers have neither, so give them inert stand-ins; imported
// first by parseWorker so this runs before those modules. Nothing is rendered in the worker.
const scope = globalThis as unknown as { window?: unknown; document?: unknown };

/** Accepts any property access, call or assignment and does nothing. */
const inert: unknown = new Proxy(() => undefined, {
  get: (_target, prop) => {
    if (prop === Symbol.toPrimitive) {
      return () => '';
    }
    if (prop === Symbol.iterator) {
      return function* () {
        yield* [];
      };
    }
    return inert;
  },
  apply: () => inert,
  construct: () => inert as object,
  set: () => true,
});

scope.window ??= globalThis;
// Browser-only globals some modules call at load time.
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of [
  'getComputedStyle',
  'matchMedia',
  'localStorage',
  'sessionStorage',
  'HTMLElement',
  'Element',
  'Node',
  'CSS',
]) {
  globals[name] ??= inert;
}
// Dev only: the React Refresh preamble that Vite injects into pages isn't run in workers.
globals.$RefreshReg$ ??= () => undefined;
globals.$RefreshSig$ ??= () => (type: unknown) => type;
scope.document ??= new Proxy(
  { querySelector: () => null, querySelectorAll: () => [] },
  { get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : inert) },
);
