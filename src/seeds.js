const INDUSTRIES = ['生技醫療', '半導體', '系統整合', '智慧製造', '綠色科技', '數位健康'];

function isoOffset(days, hour = 9) {
  return new Date(Date.UTC(2026, 7, 18 - days, hour)).toISOString();
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

function member(index) {
  const n = index + 1;
  const id = `member-${String(n).padStart(3, '0')}`;
  const membershipState = n <= 24 ? 'active' : n <= 28 ? 'pending' : 'rejected';
  const qualificationState = n <= 18 ? 'approved' : n <= 23 ? 'reviewing' : n <= 27 ? 'needs_information' : 'not_applied';
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

function subscription(index, members, projects) {
  const n = index + 1;
  const member = members[index % 18];
  const accessible = projects.find((item) => member.projectAccess.includes(item.id));
  const requestedAmountTwd = 500_000 + (index % 6) * 100_000;
  const approved = index % 5 === 0 ? 0 : requestedAmountTwd;
  const received = index % 4 === 0 ? 0 : index % 4 === 1 ? Math.floor(approved / 2) : approved;
  const refunded = index % 11 === 0 ? received : 0;
  const allocated = refunded > 0 || received === 0 ? 0 : index % 3 === 0 ? Math.floor(received / 2) : received;
  return {
    id: `subscription-${String(n).padStart(3, '0')}`,
    demo: true,
    memberId: member.id,
    projectId: accessible.id,
    membershipState: member.membershipState,
    qualificationState: member.qualificationState,
    subscriptionState: approved === 0 ? 'partner_review' : 'approved',
    fundingState: refunded > 0 ? 'refunded' : received === 0 ? 'unpaid' : received < approved ? 'partial' : 'paid',
    allocationState: allocated === 0 ? 'pending' : allocated < received - refunded ? 'partial' : 'final',
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
    createdAt: isoOffset(20 - (index % 20)),
    updatedAt: isoOffset(index % 5),
  };
}

export function createSeedData() {
  const projects = Array.from({ length: 6 }, (_, index) => project(index));
  const members = Array.from({ length: 30 }, (_, index) => member(index));
  const subscriptions = Array.from({ length: 25 }, (_, index) => subscription(index, members, projects));
  const now = new Date().toISOString();
  return {
    meta: { schemaVersion: 1, demo: true, createdAt: now, updatedAt: now },
    projects,
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
      after: { projects: 6, members: 30, subscriptions: 25 },
      reason: 'Initialize clearly labelled Demo data',
      createdAt: now,
    }],
    idempotency: {},
  };
}
