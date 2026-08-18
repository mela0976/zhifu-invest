import { calculateCommissionAmount } from './domain.js';

const INDUSTRIES = ['生技醫療', '半導體', '系統整合', '智慧製造', '綠色科技', '數位健康'];

const REFERRER_DEFINITIONS = [
  ['REFERRER', '引薦人', '引薦人顧問團隊', '引薦人', 'referrer@example.invalid', 300],
  ['ALPHA-CIRCLE', '高階投資人 Alpha 會', 'Alpha 資本顧問股份有限公司', '林顧問', 'alpha@example.invalid', 250],
  ['BIO-PARTNER', '生技產業夥伴網', '生技產業夥伴有限公司', '陳顧問', 'bio@example.invalid', 350],
  ['CHIP-LEADERS', '半導體領袖圈', '領芯策略顧問有限公司', '王顧問', 'chip@example.invalid', 280],
];

function isoOffset(days, hour = 9) {
  return new Date(Date.UTC(2026, 7, 18 - days, hour)).toISOString();
}

function referrer(definition, index) {
  const [code, displayName, legalName, contactName, contactEmail, rate] = definition;
  const createdAt = '2026-01-01T00:00:00.000Z';
  return {
    id: `referrer-${String(index + 1).padStart(2, '0')}`,
    demo: true,
    code,
    displayName,
    legalName,
    contactName,
    contactEmail,
    status: 'active',
    defaultCommissionRateBps: rate,
    commissionBasis: 'allocated_amount',
    agreementReference: `DEMO-AGR-${String(index + 1).padStart(3, '0')}`,
    effectiveAt: createdAt,
    expiresAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function project(index) {
  const n = index + 1;
  const id = `project-${String(n).padStart(2, '0')}`;
  return {
    id,
    slug: `demo-project-${n}`,
    demo: true,
    publicVisibility: index % 3 === 0 ? 'teaser' : 'anonymous',
    displayName: `DEMO｜${INDUSTRIES[index]}成長計畫 ${n}`,
    industry: INDUSTRIES[index],
    stage: ['種子輪', 'Pre-A', 'A 輪'][index % 3],
    region: '台灣',
    summary: '此為產品操作驗證用的虛構募資摘要，不代表任何投資邀約。',
    highlights: ['具驗證里程碑', '清楚的資金用途', '產業專家覆核'],
    videoUrl: '',
    updatedAt: isoOffset(index),
    memberAllowlist: Array.from({ length: 8 }, (_, memberIndex) => `member-${String(((memberIndex + index * 3) % 30) + 1).padStart(3, '0')}`),
    protected: {
      companyName: `示意企業股份有限公司 ${n}`,
      taxId: `DEMO${String(1000 + n)}`,
      round: ['Seed', 'Pre-A', 'Series A'][index % 3],
      targetAmountTwd: (30 + index * 10) * 1_000_000,
      minimumAmountTwd: 500_000,
      incrementAmountTwd: 100_000,
      deadline: `2026-${String(10 + (index % 2)).padStart(2, '0')}-30`,
      valuationNote: 'DEMO｜估值待持牌合作機構核准後揭露',
      useOfFunds: ['產品驗證', '法規與品質', '市場拓展'],
      teamSummary: 'DEMO｜跨產業產品與營運團隊。',
      financialSummary: 'DEMO｜財務資料僅用於介面與權限測試。',
      risks: ['技術驗證風險', '市場採用風險', '資金流動性風險'],
      reports: [
        { id: `report-ai-${n}`, type: 'ai', version: 1, approved: true, reviewedBy: '示意專家', basisDate: '2026-08-01' },
        { id: `report-expert-${n}`, type: 'expert', version: 1, approved: true, reviewedBy: '示意專家', basisDate: '2026-08-01' },
      ],
      deck: { id: `deck-${n}`, title: `DEMO｜${INDUSTRIES[index]} Pitch Deck` },
    },
  };
}

function member(index, referrers) {
  const n = index + 1;
  const id = `member-${String(n).padStart(3, '0')}`;
  const membershipState = n <= 24 ? 'active' : n <= 28 ? 'pending' : 'rejected';
  const qualificationState = n <= 18 ? 'approved' : n <= 23 ? 'reviewing' : n <= 27 ? 'needs_information' : 'not_applied';
  const assignedReferrer = referrers[index % referrers.length];
  const referralState = n <= 24 ? 'verified' : n <= 28 ? 'claimed' : 'rejected';
  const claimedAt = isoOffset(32 - index);
  return {
    id,
    demo: true,
    displayName: `示意會員 ${String(n).padStart(2, '0')}`,
    legalName: `DEMO 測試姓名 ${String(n).padStart(2, '0')}`,
    phone: `09${String(10000000 + n).padStart(8, '0')}`,
    email: `demo${n}@example.invalid`,
    lineUserId: `demo-line-user-${String(n).padStart(3, '0')}`,
    lineFriendshipState: n % 5 === 0 ? 'unknown' : 'friend',
    sourceGroup: `DEMO-社群-${(index % 4) + 1}`,
    referralAttribution: {
      referrerId: assignedReferrer.id,
      referralCode: assignedReferrer.code,
      state: referralState,
      evidenceReference: referralState === 'verified' ? `DEMO-REF-${String(n).padStart(4, '0')}` : null,
      claimedAt,
      verifiedAt: referralState === 'verified' ? isoOffset(30 - index) : null,
      verifiedBy: referralState === 'verified' ? 'admin-referrer-demo' : null,
    },
    membershipState,
    qualificationState,
    qualificationApproval: qualificationState === 'approved' ? {
      approver: 'DEMO 持牌合作機構',
      approvedAt: isoOffset(20 - index),
      reference: `DEMO-Q-${String(n).padStart(4, '0')}`,
      expiresAt: '2027-08-18T00:00:00.000Z',
    } : null,
    tier: ['free', 'professional', 'special'][index % 3],
    projectAccess: Array.from({ length: 3 }, (_, p) => `project-${String(((index + p) % 6) + 1).padStart(2, '0')}`),
    createdAt: isoOffset(30 - index),
    updatedAt: isoOffset(2),
  };
}

function subscription(index, members, projects, referrers) {
  const n = index + 1;
  const member = members[index % 18];
  const accessible = projects.find((item) => member.projectAccess.includes(item.id));
  const requestedAmountTwd = 500_000 + (index % 6) * 100_000;
  const approved = index % 5 === 0 ? 0 : requestedAmountTwd;
  const received = index % 4 === 0 ? 0 : index % 4 === 1 ? Math.floor(approved / 2) : approved;
  const refunded = index % 11 === 0 ? received : 0;
  const allocated = refunded > 0 || received === 0 ? 0 : index % 3 === 0 ? Math.floor(received / 2) : received;
  const referrer = referrers.find((item) => item.id === member.referralAttribution?.referrerId);
  const capturedAt = isoOffset(20 - (index % 20));
  const referralSnapshot = member.referralAttribution?.state === 'verified' && referrer ? {
    referrerId: referrer.id,
    referrerName: referrer.displayName,
    referralCode: referrer.code,
    commissionRateBps: referrer.defaultCommissionRateBps,
    commissionBasis: referrer.commissionBasis,
    agreementReference: referrer.agreementReference,
    capturedAt,
  } : null;
  const commissionAmount = referralSnapshot
    ? calculateCommissionAmount(allocated, referralSnapshot.commissionRateBps)
    : 0;
  const allocationState = allocated === 0 ? 'pending' : allocated < received - refunded ? 'partial' : 'final';
  const commissionState = !referralSnapshot
    ? 'not_applicable'
    : commissionAmount === 0 || allocationState !== 'final'
      ? 'pending'
      : index % 7 === 0
        ? 'paid'
        : index % 5 === 0
          ? 'approved'
          : 'accrued';
  const approval = ['approved', 'paid'].includes(commissionState) ? {
    approvedBy: 'DEMO 財務覆核人',
    reference: `DEMO-COM-APP-${String(n).padStart(4, '0')}`,
    approvedAt: isoOffset(4),
  } : null;
  return {
    id: `subscription-${String(n).padStart(3, '0')}`,
    demo: true,
    memberId: member.id,
    projectId: accessible.id,
    membershipState: member.membershipState,
    qualificationState: member.qualificationState,
    subscriptionState: approved === 0 ? 'partner_review' : 'approved',
    fundingState: refunded > 0 ? 'refunded' : received === 0 ? 'unpaid' : received < approved ? 'partial' : 'paid',
    allocationState,
    requestedAmountTwd,
    approvedAmountTwd: approved,
    receivedAmountTwd: received,
    allocatedAmountTwd: allocated,
    refundedAmountTwd: refunded,
    riskAcknowledged: true,
    riskAcknowledgedAt: isoOffset(20 - (index % 20)),
    riskDisclosureVersion: 'demo-draft-0.1',
    partnerApproval: approved > 0 ? {
      approver: 'DEMO 持牌合作機構',
      approvedAt: isoOffset(10 - (index % 10)),
      reference: `DEMO-S-${String(n).padStart(4, '0')}`,
    } : null,
    referralSnapshot,
    commissionState,
    commissionBasisAmountTwd: referralSnapshot ? allocated : 0,
    commissionAccruedAmountTwd: commissionAmount,
    commissionApproval: approval,
    commissionPayment: commissionState === 'paid' ? {
      paidBy: 'DEMO 財務付款人',
      reference: `DEMO-COM-PAY-${String(n).padStart(4, '0')}`,
      paidAt: isoOffset(2),
    } : null,
    commissionVoidReason: null,
    createdAt: capturedAt,
    updatedAt: isoOffset(index % 5),
  };
}

export function createSeedData() {
  const referrers = REFERRER_DEFINITIONS.map(referrer);
  const projects = Array.from({ length: 6 }, (_, index) => project(index));
  const members = Array.from({ length: 30 }, (_, index) => member(index, referrers));
  const subscriptions = Array.from({ length: 25 }, (_, index) => subscription(index, members, projects, referrers));
  const now = new Date().toISOString();
  return {
    meta: { schemaVersion: 3, demo: true, createdAt: now, updatedAt: now },
    projects,
    referrers,
    members,
    subscriptions,
    activations: [],
    bookings: [],
    notifications: [],
    audits: [{
      id: 'audit-seed-001',
      entityType: 'system',
      entityId: 'seed',
      action: 'seed.initialized',
      actor: { type: 'system', id: 'seed' },
      before: null,
      after: { projects: 6, referrers: 4, members: 30, subscriptions: 25 },
      reason: 'Initialize clearly labelled Demo data',
      createdAt: now,
    }],
    idempotency: {},
  };
}
