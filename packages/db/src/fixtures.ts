/** Seed data for Northgate Plant & Access Hire. NH-5520 is the hero hire; the rest keep the Control Room busy. */

export const STAFF = [
  { id: 'gary', name: 'Gary Dunn', role: 'approver', title: 'Hire desk lead', avatar: 'GD' },
  { id: 'jo', name: 'Jo Barrett', role: 'staff', title: 'Transport planner', avatar: 'JB' },
  { id: 'aisha', name: 'Aisha Khan', role: 'approver', title: 'Depot manager', avatar: 'AK' },
  { id: 'tom', name: 'Tom Reid', role: 'staff', title: 'Hire controller', avatar: 'TR' },
] as const;

export const CUSTOMERS = [
  {
    key: 'halden',
    name: 'Halden Build Ltd',
    accountRef: 'HAL-0142',
    contacts: [
      { key: 'sam', name: 'Sam Fletcher', email: 'sam.fletcher@haldenbuild.co.uk', role: 'Site manager', phone: '07700 900412' },
      { key: 'leanne', name: 'Leanne Price', email: 'accounts@haldenbuild.co.uk', role: 'Accounts payable', phone: null },
    ],
  },
  { key: 'wharfside', name: 'Wharfside Interiors', accountRef: 'WHI-0210', contacts: [{ key: 'meg', name: 'Meg Alder', email: 'meg@wharfsideinteriors.co.uk', role: 'Fit-out manager', phone: null }] },
  { key: 'moorcroft', name: 'Moorcroft Groundworks', accountRef: 'MGW-0077', contacts: [{ key: 'dan', name: 'Dan Okafor', email: 'site@moorcroftgw.co.uk', role: 'Site office', phone: null }] },
  { key: 'pennine', name: 'Pennine Highways', accountRef: 'PNH-0033', contacts: [{ key: 'raj', name: 'Raj Patel', email: 'raj.patel@penninehighways.co.uk', role: 'Night works supervisor', phone: null }] },
  { key: 'ashworth', name: 'Ashworth Conservation', accountRef: 'ASC-0158', contacts: [{ key: 'chris', name: 'Chris Hale', email: 'chris@ashworthconservation.co.uk', role: 'Project manager', phone: null }] },
  { key: 'kestrel', name: 'Kestrel Logistics', accountRef: 'KEL-0091', contacts: [{ key: 'bev', name: 'Bev Sutton', email: 'bev.sutton@kestrellogistics.co.uk', role: 'Facilities buyer', phone: null }] },
] as const;

export type SeedLine = {
  kind: string;
  model: string;
  description: string;
  spec: string;
  fleetNo: string;
  weeklyRatePence: number;
  status?: 'booked' | 'on_hire' | 'cancelled';
};
export type SeedHire = {
  ref: string;
  customer: string;
  siteContact: string;
  site: string;
  siteArea: string;
  deliveryDate: string;
  durationDays: number;
  status: 'enquiry' | 'confirmed' | 'on_hire' | 'off_hire' | 'cancelled';
  lines: SeedLine[];
  transportPence: number;
  waiverSigned: boolean;
  poNumber?: string;
};

export const HERO_REF = 'NH-5520';

/** Mirrors directions/shared/engine.js and CHOSEN.md "Seeded content the UI copy assumes". */
export const HIRES: SeedHire[] = [
  {
    ref: HERO_REF,
    customer: 'halden',
    siteContact: 'sam',
    site: 'Riverside Yard',
    siteArea: 'Kirkstall, Leeds',
    // The brief says "Mon 3 Nov" / "Wed 5 Nov" (2025 weekdays); in 2026 Monday is the 2nd.
    deliveryDate: '2026-11-02',
    durationDays: 14,
    status: 'confirmed',
    transportPence: 18000,
    waiverSigned: false,
    lines: [
      { kind: 'boom', model: 'JLG 600AJ', description: '19m articulated boom lift', spec: 'Diesel 4x4 · 230kg platform', fleetNo: 'AB19-07', weeklyRatePence: 118000 },
      { kind: 'telehandler', model: 'Manitou MT 1440', description: '14m telehandler', spec: '4t lift capacity', fleetNo: 'TH14-22', weeklyRatePence: 79000 },
    ],
  },
  {
    ref: 'NH-5512', customer: 'wharfside', siteContact: 'meg', site: 'Canal Wharf fit-out', siteArea: 'Holbeck, Leeds', deliveryDate: '2026-10-26', durationDays: 14, status: 'on_hire', transportPence: 14000, waiverSigned: true, poNumber: 'WI-0932',
    lines: [{ kind: 'scissor', model: 'Genie GS-2632', description: '10m electric scissor lift x2', spec: 'Non-marking tyres', fleetNo: 'SC10-03/04', weeklyRatePence: 41000, status: 'on_hire' }],
  },
  {
    ref: 'NH-5498', customer: 'moorcroft', siteContact: 'dan', site: 'Moor Lane drainage', siteArea: 'Garforth', deliveryDate: '2026-10-12', durationDays: 21, status: 'on_hire', transportPence: 12000, waiverSigned: true, poNumber: 'MG-7781',
    lines: [
      { kind: 'dumper', model: 'Thwaites 3t', description: '3t forward-tipping dumper', spec: 'Swivel skip', fleetNo: 'DP03-11', weeklyRatePence: 16500, status: 'on_hire' },
      { kind: 'excavator', model: 'Kubota U17-3', description: '1.5t mini excavator', spec: '3 buckets', fleetNo: 'MX15-04', weeklyRatePence: 21000, status: 'on_hire' },
    ],
  },
  {
    ref: 'NH-5507', customer: 'pennine', siteContact: 'raj', site: 'A64 resurfacing, nights', siteArea: 'Seacroft', deliveryDate: '2026-10-19', durationDays: 28, status: 'on_hire', transportPence: 21000, waiverSigned: true, poNumber: 'PH-31007',
    lines: [
      { kind: 'lighting', model: 'Towerlight VB9', description: 'LED tower light x4', spec: '9m mast', fleetNo: 'TL09-21..24', weeklyRatePence: 8500, status: 'on_hire' },
      { kind: 'generator', model: 'SDMO R110', description: '100kVA generator', spec: 'Bunded', fleetNo: 'GN100-02', weeklyRatePence: 29500, status: 'on_hire' },
    ],
  },
  {
    ref: 'NH-5524', customer: 'ashworth', siteContact: 'chris', site: "St Anne's roof repairs", siteArea: 'Headingley', deliveryDate: '2026-11-04', durationDays: 14, status: 'confirmed', transportPence: 16000, waiverSigned: false,
    lines: [{ kind: 'spider', model: 'Hinowa 17.75', description: '17m spider lift', spec: 'Tracked, 0.8m wide', fleetNo: 'SP17-01', weeklyRatePence: 64000 }],
  },
  {
    ref: 'NH-5491', customer: 'kestrel', siteContact: 'bev', site: 'Hunslet distribution centre', siteArea: 'Hunslet, Leeds', deliveryDate: '2026-10-05', durationDays: 56, status: 'on_hire', transportPence: 22000, waiverSigned: true, poNumber: 'KL-2210',
    lines: [{ kind: 'boom', model: 'Genie Z-80/60', description: '26m articulated boom lift', spec: 'Bi-energy', fleetNo: 'AB26-02', weeklyRatePence: 149000, status: 'on_hire' }],
  },
];

/** The telehandler Jo swaps to in beat 4 (hire v5). */
export const SWAP_TELEHANDLER = { model: 'Manitou MT 1840', description: '17m telehandler', spec: '4t lift capacity', fleetNo: 'TH17-05', weeklyRatePence: 86000 };

export const HERO_THREADS = [
  { label: 'T1', contact: 'sam', subject: 'NH-5520 Riverside Yard – boom + telehandler' },
  { label: 'T2', contact: 'leanne', subject: 'NH-5520 PO and invoicing' },
] as const;

export const HERO_HISTORY_EMAIL = {
  thread: 'T1',
  direction: 'out' as const,
  messageId: '<nh5520-confirm-1@northgate-hire.co.uk>',
  from: 'hiredesk@northgate-hire.co.uk',
  subject: 'NH-5520 Riverside Yard – boom + telehandler',
  body:
    'Hi Sam,\n\nConfirming NH-5520: AB19-07 19m articulated boom lift and TH14-22 14m telehandler, delivered to Riverside Yard on Monday 2 November (AM), two weeks, £4,120.00 including transport, plus damage waiver and VAT.\n\nPlease sign and return the damage waiver before delivery.\n\nThanks,\nGary Dunn\nNorthgate Plant & Access Hire',
};

export const HERO_TRANSCRIPT = {
  title: 'Call: Gary Dunn ↔ Sam Fletcher (NH-5520 pricing)',
  participants: ['Gary Dunn', 'Sam Fletcher'],
  occurredAt: '2026-10-20T09:40:00Z',
  body: [
    'Gary: Morning Sam, I saw your email about the price on the Riverside job.',
    'Sam: Yeah, we’ve got three more sites coming this year and I’d rather keep it all with you.',
    'Gary: What’s firm?',
    'Sam: Two of them are definite this quarter – Hunslet Mill in November and the Elland Road car park in December. Both need a boom and a telehandler.',
    'Gary: If you put both of those through us I can do 10% off NH-5520. That’s final from me.',
    'Sam: Deal. Send it over in writing and I’ll get the PO sorted.',
  ].join('\n'),
};

export const waiverDoc = (ref: string, signed: boolean) => ({
  kind: 'damage_waiver',
  title: `Damage waiver – ${ref}`,
  body: signed
    ? `Damage waiver for ${ref}. Signed by the customer. Covers accidental damage at 6% of hire value; excess £500 per machine.`
    : `Damage waiver for ${ref}. Issued, awaiting customer signature. Covers accidental damage at 6% of hire value; excess £500 per machine. Not valid until signed.`,
  signed,
});

/** Work already waiting on the other desks (explicit refs; new drafts start at D-7). */
export const OTHER_DRAFTS = [
  { ref: 'D-31', hire: 'NH-5498', kind: 'update', title: 'Off-hire confirmation OH-30117', summary: 'Collect dumper + mini excavator Fri 30 Oct, AM', status: 'pending' },
] as const;

/**
 * Fleet register. LOLER 1998 reg. 9: equipment for lifting persons (MEWPs: booms, scissors, spiders)
 * needs a thorough examination at least every 6 months; other lifting equipment (telehandlers) every
 * 12 months. IPAF PAL categories: 3a static/scissor, 3b boom (incl. spider lifts).
 */
export const FLEET = [
  { fleetNo: 'AB19-07', kind: 'boom', ipafCategory: '3b', lolerDue: '2027-03-18', lolerIntervalMonths: 6 },
  { fleetNo: 'TH14-22', kind: 'telehandler', ipafCategory: null, lolerDue: '2027-06-02', lolerIntervalMonths: 12 },
  { fleetNo: 'TH17-05', kind: 'telehandler', ipafCategory: null, lolerDue: '2027-01-26', lolerIntervalMonths: 12 },
  { fleetNo: 'SC10-03/04', kind: 'scissor', ipafCategory: '3a', lolerDue: '2027-02-09', lolerIntervalMonths: 6 },
  { fleetNo: 'DP03-11', kind: 'dumper', ipafCategory: null, lolerDue: null, lolerIntervalMonths: null },
  { fleetNo: 'MX15-04', kind: 'excavator', ipafCategory: null, lolerDue: '2027-05-11', lolerIntervalMonths: 12 },
  { fleetNo: 'TL09-21..24', kind: 'lighting', ipafCategory: null, lolerDue: null, lolerIntervalMonths: null },
  { fleetNo: 'GN100-02', kind: 'generator', ipafCategory: null, lolerDue: null, lolerIntervalMonths: null },
  { fleetNo: 'SP17-01', kind: 'spider', ipafCategory: '3b', lolerDue: '2026-12-14', lolerIntervalMonths: 6 },
  { fleetNo: 'AB26-02', kind: 'boom', ipafCategory: '3b', lolerDue: '2027-04-01', lolerIntervalMonths: 6 },
] as const;
