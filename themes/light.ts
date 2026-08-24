import type { Theme } from './contract.js';

export const lightTheme: Theme = {
  name: 'light',
  background: '#fcfcfb',
  ink: { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781' },
  palette: [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
  ],
  other: '#898781',
  link: { color: '#dedcd4', active: '#52514e' },
  selection: '#0b0b0b',
  hover: '#52514e',
  pin: '#52514e',
  label: '#52514e',
  labelHalo: '#fcfcfb',
  dimOpacity: 0.18,
};
