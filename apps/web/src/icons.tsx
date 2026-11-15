const paths = {
  town: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  agents: 'M8 3v3m8-3v3M6 6h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3ZM8 11h.01M16 11h.01M8 16h8',
  wallet: 'M20 7V4H5a3 3 0 0 0 0 6h16v10H5a3 3 0 0 1-3-3V7m19 5h-6v5h6m-3-2.5h.01',
  tasks: 'M9 5H5v16h14V5h-4M9 3h6v4H9Zm-1 9h8m-8 5h5',
  contributions: 'M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12-14a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM6 6v12m12-10v2a4 4 0 0 1-4 4H6',
  messages: 'M21 11a8 8 0 0 1-8 8H8l-5 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8ZM7 8h10M7 13h6',
  market: 'M3 9h18l-2-6H5Zm1 0v12h16V9M9 21v-7h6v7M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0',
  rewards: 'M3 8h18v5H3Zm2 5v8h14v-8M12 8v13m0-13H7a3 3 0 1 1 3-3Zm0 0h5a3 3 0 1 0-3-3Z',
  games: 'M7 7h10a4 4 0 0 1 4 4l1 6a3 3 0 0 1-5 2l-2-2H9l-2 2a3 3 0 0 1-5-2l1-6a4 4 0 0 1 4-4Zm0 3v5m-2-2.5h4m7-1h.01m3 3h.01',
  operations: 'M4 21V11m8 10V3m8 18V9M1 7h6m2 10h6m2-12h6',
  settings: 'm9 3-1 3-3 1-2 4 2 2v3l3 2 1 3h6l1-3 3-2v-3l2-2-2-4-3-1-1-3ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  directory: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  build: 'm14 3 7 7-11 11H3v-7Zm-3 3 7 7M3 17l4 4',
  locate: 'M12 2v4m0 12v4M2 12h4m12 0h4M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM12 10v4m-2-2h4',
  overview: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Zm6-3v15m6-12v15',
  walk: 'M14 4h.01M12 8l-3 5H5m7-5 4 5h4m-8-5 2 7-5 7m5-7 4 7',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
