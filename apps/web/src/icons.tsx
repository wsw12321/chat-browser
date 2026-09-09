type Name =
  | 'chat'
  | 'plus'
  | 'send'
  | 'paperclip'
  | 'stop'
  | 'menu'
  | 'close'
  | 'file'
  | 'arrow'
  | 'key'
  | 'download'
  | 'settings'
  | 'check'
  | 'trash';
const paths: Record<Name, string> = {
  chat: 'M5 4h14v12h-8l-6 4V4m4 5h6m-6 3h4',
  plus: 'M12 5v14M5 12h14',
  send: 'm5 12 14-8-4 16-4-6-6-2Zm0 0 6 2 8-10',
  paperclip: 'm8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',
  stop: 'M6 6h12v12H6z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  file: 'M6 3h8l4 4v14H6V3m8 0v5h4M9 12h6m-6 4h6',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  key: 'M15 10a4 4 0 1 0 0 .01M8 13l-5 5v3h3v-3h3l3-3',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  check: 'm5 12 4 4 10-10',
  trash: 'M4 6h16M9 3h6m-9 3 1 15h10l1-15M10 10v7m4-7v7',
};
export function Icon({ name, size = 20 }: { name: Name; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
