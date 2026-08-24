import type { Theme } from './contract.js';

export const darkTheme: Theme = {
  name: 'dark',
  background: '#1a1a19',
  ink: { primary: '#ffffff', secondary: '#c3c2b7', muted: '#898781' },
  palette: [
    '#3987e5', // 1 blue
    '#d95926', // 2 orange
    '#199e70', // 3 aqua
    '#c98500', // 4 yellow
    '#d55181', // 5 magenta
    '#008300', // 6 green
    '#9085e9', // 7 violet
    '#e66767', // 8 red
  ],
  other: '#898781',
  link: { color: '#3a3a37', active: '#c3c2b7' },
  selection: '#ffffff',
  hover: '#c3c2b7',
  pin: '#c3c2b7',
  label: '#c3c2b7',
  labelHalo: '#1a1a19',
  dimOpacity: 0.16,
};
