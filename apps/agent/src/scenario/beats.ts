import { HERO_REF, SWAP_TELEHANDLER } from '@switchboard/db';
import type { Services } from '../services';

/**
 * The hero story as data + small functions over the services. The scenario
 * runner (M6), the simulator rail and the integration tests all use these.
 */
export const SAM = 'sam.fletcher@haldenbuild.co.uk';
export const LEANNE = 'accounts@haldenbuild.co.uk';

export const BEAT_EMAILS = {
  discountAsk: {
    hireRef: HERO_REF,
    threadLabel: 'T1',
    from: SAM,
    subject: 'Re: NH-5520 Riverside Yard – boom + telehandler',
    messageId: '<sam-discount-ask@haldenbuild.co.uk>',
    body: "Hi Gary,\n\nCan you knock something off NH-5520? We've got three more sites this year and I'd like to keep it all with Northgate.\n\nCheers,\nSam",
  },
  poAndInvoice: {
    hireRef: HERO_REF,
    threadLabel: 'T2',
    from: LEANNE,
    subject: 'NH-5520 PO and invoicing',
    messageId: '<leanne-po@haldenbuild.co.uk>',
    body: 'Hello,\n\nOur PO number for NH-5520 is HAL-PO-88213.\n\nInvoice address:\nHalden Build Ltd, Accounts Payable\n4 Canal Wharf, Leeds LS11 5PY\n\nThanks,\nLeanne Price',
  },
  cancelTelehandler: {
    hireRef: HERO_REF,
    threadLabel: 'T1',
    from: SAM,
    subject: 'Re: NH-5520 Riverside Yard – boom + telehandler',
    messageId: '<sam-cancel-telehandler@haldenbuild.co.uk>',
    body: "Gary – change of plan on Riverside, please cancel the telehandler, keep the boom. Sorry for the faff.\n\nSam",
  },
} as const;

export const GARY_NOTE = '@assistant 10% off NH-5520, final – see my call with Sam this morning. He’s committed to two more hires this quarter.';

export const JO_EDIT = {
  hireRef: HERO_REF,
  staffId: 'jo',
  changes: { deliveryDate: '2026-11-04' }, // Wednesday
  lines: [{ lineNo: 2, ...SWAP_TELEHANDLER }],
};

export function beats(svc: Services) {
  return {
    1: () => svc.ingestEmail(BEAT_EMAILS.discountAsk),
    2: () => svc.ingestEmail(BEAT_EMAILS.poAndInvoice),
    3: () => svc.addNote({ hireRef: HERO_REF, authorId: 'gary', body: GARY_NOTE }),
    4: () => svc.editHire(JO_EDIT),
    5: () => svc.decideApproval({ draftRef: 'D-7', staffId: 'gary', decision: 'approved', channel: 'mobile' }),
    6: () => svc.decideApproval({ draftRef: 'D-8', staffId: 'gary', decision: 'approved', channel: 'mobile' }),
    7: () => svc.fireSweep(HERO_REF),
    8: async () => {
      const a = await svc.ingestEmail(BEAT_EMAILS.cancelTelehandler);
      const b = await svc.setLineStatus({ hireRef: HERO_REF, staffId: 'jo', lineNo: 2, status: 'cancelled' });
      return { email: a, status: b };
    },
  } as const;
}
