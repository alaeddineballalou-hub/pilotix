// The app's JSX: React's own, with one change — a link of the app written « #/page/sub » (<a href="#/commandes/tout">)
// gets its real address on the site (lib/route: /<boutique>/commandes/tout), so it shows and copies without « # ».
// Chosen in vite.config.ts and tsconfig.json (jsxImportSource « @pilotix/jsx »).
import * as R from 'react/jsx-runtime';
import { linkProps } from '../route';

export type { JSX } from 'react/jsx-runtime';
export const Fragment = R.Fragment;
export const jsx: typeof R.jsx = (type, props, key) => R.jsx(type, linkProps(type, props), key);
export const jsxs: typeof R.jsxs = (type, props, key) => R.jsxs(type, linkProps(type, props), key);
