import { useEffect, useRef } from 'react';

/**
 * The phone's back button for stacked layers (the full-screen parcel, a sheet above it): each layer adds one
 * history entry and back closes only the top one. A back that lands on a layer's own entry means a layer above it
 * was closed: that layer stays. A layer closed in the app (✕, done) takes its entry away; layers closed together go
 * back once, by as many entries, and a layer opened meanwhile (one sheet leading to the next) adds its entry once
 * that is done.
 */
let pending = 0;
let timer = 0;
/** our own going back is on its way: its popstate is not a back press */
let traversing = false;
const waiting = new Set<() => void>();

function settle() {
  traversing = false;
  const fns = [...waiting];
  waiting.clear();
  for (const f of fns) f();
}
function flush() {
  timer = 0;
  const n = pending;
  pending = 0;
  if (!n) return settle();
  traversing = true;
  let fallback = 0;
  const done = () => {
    window.removeEventListener('popstate', done);
    window.clearTimeout(fallback);
    window.setTimeout(settle, 0);
  };
  window.addEventListener('popstate', done);
  fallback = window.setTimeout(done, 400);
  history.go(-n);
}
function dropEntry() {
  pending++;
  if (!timer) timer = window.setTimeout(flush, 0);
}

let seq = 0;
/** `onBack` may answer false: the layer stays (a sheet that must be finished first), and keeps its entry. */
export function useBackLayer(onBack: () => void | boolean) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    const id = `l${++seq}`;
    let pushed = false;
    let gone = false;
    const push = () => {
      pushed = true;
      history.pushState({ pxLayer: id }, '');
    };
    if (pending > 0 || traversing) waiting.add(push);
    else push();
    const pop = (e: PopStateEvent) => {
      if (!pushed || gone || traversing || e.state?.pxLayer === id) return;
      gone = true;
      if (ref.current() === false) {
        gone = false;
        history.pushState({ pxLayer: id }, '');
      }
    };
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      waiting.delete(push);
      if (pushed && !gone) dropEntry();
    };
  }, []);
}
