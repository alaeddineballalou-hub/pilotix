// The app's JSX while developing (vite dev): see jsx-runtime.ts.
import * as D from 'react/jsx-dev-runtime';
import { linkProps } from '../route';

export type { JSX } from 'react/jsx-dev-runtime';
export const Fragment = D.Fragment;
export const jsxDEV: typeof D.jsxDEV = (type, props, key, isStatic, source, self) => D.jsxDEV(type, linkProps(type, props), key, isStatic, source, self);
