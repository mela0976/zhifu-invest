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
    leadOwnerAttribution: null,
    membershipState,
    qualificationState,
    qualificationApproval: qualificationState === 'approved' ? {
      approver: 'DEMO 持牌合作機構',
      approvedAt: isoOffset(20 - index),
      reference: `DEMO-Q-${String(n).padStart(4, '0')}`,
      expiresAt: '2027-08-18T00:00:00.000Z',
    } : null,
    tier: ['free', 'professional', 'special'][index % 3],
    investmentPreferences: {
      industries: [INDUSTRIES[index % INDUSTRIES.length], INDUSTRIES[(index + 2) % INDUSTRIES.length]],
      ticketMinTwd: 500_000,
      ticketMaxTwd: 1_500_000 + (index % 4) * 500_000,
    },
    projectAccess: Array.from({ length: 3 }, (_, p) => `project-${String(((index + p) % 6) + 1).padStart(2, '0')}`),
    createdAt: isoOffset(30 - index),
    updatedAt: isoOffset(2),
  };
}

function leads(members, referrers) {
  return Array.from({ length: 10 }, (_, index) => {
    const n = index + 1;
    const member = index < 6 ? members[index + 6] : null;
    const owner = member
      ? referrers.find((item) => item.id === member.referralAttribution?.referrerId)
      : referrers[index % referrers.length];
    const id = `lead-${String(n).padStart(3, '0')}`;
    const createdAt = isoOffset(15 - index);
    if (member) {
      member.leadOwnerAttribution = {
        leadId: id,
        referrerId: owner.id,
        referralCode: owner.code,
        sourceReference: `DEMO-LEAD-SOURCE-${String(n).padStart(3, '0')}`,
        evidenceReference: `DEMO-PRIVACY-${String(n).padStart(3, '0')}`,
        linkedAt: createdAt,
        linkedBy: 'admin-referrer-demo',
      };
    }
    return {
      id,
      demo: true,
      ownerReferrerId: owner.id,
      sourceReference: `DEMO-LEAD-SOURCE-${String(n).padStart(3, '0')}`,
      privacyEvidence: {
        reference: `DEMO-PRIVACY-${String(n).padStart(3, '0')}`,
        consentedAt: createdAt,
        noticeVersion: 'demo-privacy-0.1',
      },
      displayName: `DEMO 潛在會員 ${String(n).padStart(2, '0')}`,
      phone: `09${String(20000000 + n).padStart(8, '0')}`,
      email: `lead${n}@example.invalid`,
      companyName: n % 2 === 0 ? `DEMO 企業 ${n}` : '',
      channel: ['LINE 社群', 'OpenChat', '顧問轉介'][index % 3],
      notes: 'DEMO｜僅供產品流程驗證使用。',
      investmentPreferences: {
        industries: [INDUSTRIES[index % INDUSTRIES.length]],
        ticketMinTwd: 500_000,
        ticketMaxTwd: 2_000_000,
      },
      status: member ? 'converted' : ['new', 'contacted', 'qualified', 'archived'][index % 4],
      memberId: member?.id || null,
      convertedAt: member ? createdAt : null,
      importedBy: 'admin-referrer-demo',
      importedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
  });
}

function contentItem(index, projects) {
  const n = index + 1;
  const type = ['video', 'article', 'project_update'][index % 3];
  const status = index === 5 ? 'draft' : 'published';
  return {
    id: `content-${String(n).padStart(3, '0')}`,
    demo: true,
    type,
    title: `DEMO｜投資研究內容 ${n}`,
    summary: '此為示意研究內容，不構成投資建議或邀約。',
    url: type === 'article' ? `https://example.invalid/articles/${n}` : null,
    videoUrl: type === 'video' ? `https://example.invalid/videos/${n}` : null,
    projectId: index < projects.length ? projects[index].id : null,
    visibility: index < 3 ? 'public' : type === 'project_update' ? 'qualified' : 'member',
    status,
    publicSafe: index < 3,
    publishedAt: status === 'published' ? isoOffset(5 - index) : null,
    riskDisclosure: status === 'published' ? 'DEMO｜投資涉及風險，內容僅供研究參考。' : null,
    createdAt: isoOffset(10 - index),
    updatedAt: isoOffset(5 - index),
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
    ...(member.leadOwnerAttribution ? {
      leadId: member.leadOwnerAttribution.leadId,
      attributionSource: 'lead_owner',
    } : {}),
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
    acquisitionAttributionSnapshot: member.leadOwnerAttribution ? {
      leadId: member.leadOwnerAttribution.leadId,
      ownerReferrerId: member.leadOwnerAttribution.referrerId,
      capturedAt,
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
  const leadRecords = leads(members, referrers);
  const subscriptions = Array.from({ length: 25 }, (_, index) => subscription(index, members, projects, referrers));
  const contentItems = Array.from({ length: 6 }, (_, index) => contentItem(index, projects));
  const newsletterPreferences = members.slice(0, 5).map((item, index) => ({
    memberId: item.id,
    dailyDigestConsent: index < 3,
    marketingConsent: index === 0,
    emailDeliveryConsent: false,
    lineDeliveryConsent: index === 0,
    deliveryChannels: index === 0 ? ['in_app', 'line'] : ['in_app'],
    updatedAt: isoOffset(1),
  }));
  const now = new Date().toISOString();
  return {
    meta: { schemaVersion: 6, demo: true, createdAt: now, updatedAt: now },
    projects,
    referrers,
    members,
    subscriptions,
    leads: leadRecords,
    contentItems,
    newsletterPreferences,
    dailyDigests: [],
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
      after: { projects: 6, referrers: 4, members: 30, subscriptions: 25, leads: 10, contentItems: 6 },
      reason: 'Initialize clearly labelled Demo data',
      createdAt: now,
    }],
    idempotency: {},
  };
}
