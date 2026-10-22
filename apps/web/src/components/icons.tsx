/** Yard Board's own 1.5px stroke icon set (ported from the design sprite). No stock icon library. */
import type { SVGProps } from 'react';

const PATHS = {
  mark: (
    <>
      <path d="M4 3.5h16a1 1 0 0 1 1 1V8a1 1 0 0 1-1 1h-4.75v11a.75.75 0 0 1-.75.75h-5a.75.75 0 0 1-.75-.75V9H4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
      <path d="M3 15h18" />
    </>
  ),
  rack: (
    <>
      <path d="M3 4h5v3H3zM9.5 4h5v3h-5zM16 4h5v3h-5z" />
      <path d="M4.5 7v6h2V7M11 7v6h2V7M17.5 7v6h2V7" />
      <path d="M2 16.5h20M2 20h20" />
    </>
  ),
  hires: (
    <>
      <path d="M6 3.5h9l3.5 3.5v13a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" />
      <path d="M14.5 3.5V7.5h4M8.5 11h7M8.5 14h7M8.5 17h4" />
    </>
  ),
  approve: (
    <>
      <path d="M3.5 3.5h17v7h-6v10h-5v-10h-6z" />
      <path d="M8.5 7l2 2 4-3.5" />
    </>
  ),
  signals: (
    <>
      <path d="M4 10h16v10.5H4z" />
      <path d="M6 7h12M8 4h8" />
      <path d="M4.5 10.5l7.5 5 7.5-5" />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
      <path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
    </>
  ),
  note: (
    <>
      <path d="M5 5.5h14v9.5l-5 5H5z" />
      <path d="M14 20v-5h5" />
      <circle cx="12" cy="4.5" r="1.5" />
      <path d="M8.5 9.5h7M8.5 12.5h4" />
    </>
  ),
  call: (
    <>
      <path d="M6.5 3.5h2.5l1.5 4-2 1.5a10 10 0 0 0 5 5l1.5-2 4 1.5V16a2 2 0 0 1-2 2A13 13 0 0 1 4.5 5.5a2 2 0 0 1 2-2z" />
      <path d="M14 3.5h6.5M14 6.5h4.5" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20l1-4L15.5 5.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8 19z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
  flag: (
    <>
      <path d="M6 21V3.5" />
      <path d="M6 4h11.5l-2.5 4 2.5 4H6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />,
  inspect: (
    <>
      <path d="M8 4H4.5v16H8M16 4h3.5v16H16" />
      <path d="M8.5 9h7M8.5 12h7M8.5 15h4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  reset: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4v4h4" />
    </>
  ),
  next: (
    <>
      <path d="M5 5.5l8 6.5-8 6.5z" />
      <path d="M17.5 5.5v13" />
    </>
  ),
  chev: <path d="M6 15l6-6 6 6" />,
  sent: (
    <>
      <path d="M3.5 11.5l17-7-6 16-3-6.5z" />
      <path d="M11.5 14l9-9.5" />
    </>
  ),
  /** A document with a fold: damage waivers and other documents fetched as evidence. */
  doc: (
    <>
      <path d="M6 3.5h8.5L18.5 7.5V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" />
      <path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h5" />
    </>
  ),
  /** A worker unplugged from its slot: the crash control. */
  crash: (
    <>
      <path d="M4 4h16v5H4z" />
      <path d="M9 9v4l-2 3M15 9v3l2 4" />
      <path d="M5.5 19.5l13-13" />
    </>
  ),
  /** A phone frame: the mobile approval view. */
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M10.5 18.5h3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = '', ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg className={`icon ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      {PATHS[name]}
    </svg>
  );
}

/** The T-head: step markers, the user glyph, status words. */
export function THead({ className = 'statusword__glyph', ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true" focusable="false" {...rest}>
      <path d="M1 1h10v4H7.5v6h-3V5H1z" />
    </svg>
  );
}

export const SOURCE: Record<string, { label: string; icon: IconName }> = {
  email: { label: 'Email', icon: 'email' },
  note: { label: 'Note', icon: 'note' },
  transcript: { label: 'Call transcript', icon: 'call' },
  document: { label: 'Document', icon: 'doc' },
  field_edit: { label: 'Field edit', icon: 'edit' },
  status_change: { label: 'Status change', icon: 'flag' },
  approval: { label: 'Approval', icon: 'approve' },
  schedule: { label: 'Schedule', icon: 'clock' },
};
