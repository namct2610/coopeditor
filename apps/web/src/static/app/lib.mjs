// Preact + htm, vendored (no build step): `html` tagged templates render
// through Preact's diff, so the <video>, the TipTap editor and focused inputs
// survive every re-render.
import { h, render, Fragment, createRef } from "../vendor/preact.mjs";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer } from "../vendor/preact-hooks.mjs";
import htm from "../vendor/htm.mjs";

export const html = htm.bind(h);
export { h, render, Fragment, createRef, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer };

export const stop = (e) => { if (e) e.stopPropagation(); };

// Enter that submits — not the Enter that commits a word in an input method
// (macOS Vietnamese Telex/VNI, CJK…), which would send half-typed text.
export const isEnter = (e) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
