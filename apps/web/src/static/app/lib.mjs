// Preact + htm, vendored (no build step): `html` tagged templates render
// through Preact's diff, so the <video>, the TipTap editor and focused inputs
// survive every re-render.
import { h, render, Fragment, createRef } from "../vendor/preact.mjs";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer } from "../vendor/preact-hooks.mjs";
import htm from "../vendor/htm.mjs";

export const html = htm.bind(h);
export { h, render, Fragment, createRef, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer };

// Close a popover when the pointer goes down anywhere outside `ref`.
export function useOutside(ref, onOutside, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(e); };
    const t = setTimeout(() => document.addEventListener("pointerdown", fn), 0);
    return () => { clearTimeout(t); document.removeEventListener("pointerdown", fn); };
  }, [active, onOutside]);
}

export const stop = (e) => { if (e) e.stopPropagation(); };
