// Small line icons for the writing tools. Stroke uses currentColor; the pen and
// highlighter tips take the ink colour you've picked (passed as `tip`).

type P = { tip?: string; size?: number };
const S = ({ size = 20, children }: { size?: number; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const Icon = {
  type: ({ size }: P) => (
    <S size={size}>
      <path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6" />
    </S>
  ),
  select: ({ size }: P) => (
    <S size={size}>
      <path d="M5 4l13 6.5-5.6 1.6L10.8 18z" />
    </S>
  ),
  text: ({ size }: P) => (
    <S size={size}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" strokeDasharray="2.5 2.2" />
      <path d="M8.5 9.5h7M12 9.5v6" />
    </S>
  ),
  pen: ({ size, tip = "currentColor" }: P) => (
    <S size={size}>
      <path d="M15.5 4.5l4 4L9 19l-5 1 1-5z" />
      <path d="M4 20l1-5 4 4z" fill={tip} stroke={tip} />
      <path d="M13.5 6.5l4 4" />
    </S>
  ),
  highlighter: ({ size, tip = "var(--draw-yellow)" }: P) => (
    <S size={size}>
      <path d="M14 4.5l5.5 5.5-7 7-5.5-5.5z" />
      <path d="M7 11.5l5.5 5.5-2 2H6.5l-2-2z" fill={tip} stroke="currentColor" />
      <path d="M3.5 20.5h7" stroke={tip} strokeWidth={2.4} />
    </S>
  ),
  eraser: ({ size }: P) => (
    <S size={size}>
      <path d="M8.5 19.5L3.8 14.8a1.6 1.6 0 010-2.3l8-8a1.6 1.6 0 012.3 0l5.4 5.4a1.6 1.6 0 010 2.3l-7.6 7.3z" />
      <path d="M8 9l7 7M8.5 19.5H20" />
    </S>
  ),
  lasso: ({ size }: P) => (
    <S size={size}>
      <ellipse cx="12" cy="9.5" rx="8" ry="5.5" strokeDasharray="3 2.4" />
      <path d="M7.5 13.5c-1.5 2.2-1 4.5 1.2 5 1.8.4 2.3-1.3 1.3-2.4" />
    </S>
  ),
  undo: ({ size }: P) => (
    <S size={size}>
      <path d="M9 7L4.5 11.5 9 16" />
      <path d="M4.5 11.5H14a5.5 5.5 0 010 11h-2" transform="translate(0 -3)" />
    </S>
  ),
  redo: ({ size }: P) => (
    <S size={size}>
      <path d="M15 7l4.5 4.5L15 16" />
      <path d="M19.5 11.5H10a5.5 5.5 0 000 11h2" transform="translate(0 -3)" />
    </S>
  ),
  more: ({ size }: P) => (
    <S size={size}>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </S>
  ),
  shapes: ({ size }: P) => (
    <S size={size}>
      <circle cx="8" cy="8.5" r="4" />
      <path d="M14.5 19.5h6l-3-5.5z" />
      <rect x="4" y="15" width="6" height="5" rx="0.8" />
    </S>
  ),
  page: ({ size }: P) => (
    <S size={size}>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M12 10.5v6M9 13.5h6" />
    </S>
  ),
  hand: ({ size }: P) => (
    <S size={size}>
      <path d="M8 12.5V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7.5c0 4-2.5 6.5-6 6.5-2.5 0-4-1.2-5.3-3.3L4 13.5a1.4 1.4 0 012.3-1.6L8 14" />
    </S>
  ),
  menu: ({ size }: P) => (
    <S size={size}>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </S>
  ),
  back: ({ size }: P) => (
    <S size={size}>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </S>
  ),
  plus: ({ size }: P) => (
    <S size={size}>
      <path d="M12 5v14M5 12h14" />
    </S>
  ),
  upload: ({ size }: P) => (
    <S size={size}>
      <path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9" />
      <path d="M4.5 14.5v3a2 2 0 002 2h11a2 2 0 002-2v-3" />
    </S>
  ),
  plug: ({ size }: P) => (
    <S size={size}>
      <path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 01-11 0zM12 16v4.5" />
    </S>
  ),
  search: ({ size }: P) => (
    <S size={size}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </S>
  ),
  trash: ({ size }: P) => (
    <S size={size}>
      <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
    </S>
  ),
  download: ({ size }: P) => (
    <S size={size}>
      <path d="M12 4.5v11M7.5 11L12 15.5 16.5 11" />
      <path d="M4.5 19.5h15" />
    </S>
  ),
  book: ({ size }: P) => (
    <S size={size}>
      <path d="M5 4.5h11.5a2 2 0 012 2v13H7a2 2 0 01-2-2z" />
      <path d="M5 17.5a2 2 0 012-2h11.5M9 4.5v11" />
    </S>
  ),
  sun: ({ size }: P) => (
    <S size={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" />
    </S>
  ),
  moon: ({ size }: P) => (
    <S size={size}>
      <path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z" />
    </S>
  ),
  auto: ({ size }: P) => (
    <S size={size}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 010 16z" fill="currentColor" />
    </S>
  ),
};
