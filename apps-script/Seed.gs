/** Explicit Demo seed. Never called by setupWorkbook or a web entry point. */

function seedDemoData() {
  return withStoreLock_(function () {
    ['Members', 'Projects', 'Subscriptions', 'Referrers', 'Bookings', 'Activations', 'Notifications', 'Audits']
      .forEach(function (sheetName) {
        if (storeList_(sheetName).length) {
          throw domainError_('Demo seed refused because ' + sheetName + ' already contains data', 'seed_requires_empty_workbook', 409);
        }
      });
    var industries = ['生技醫療', '半導體', '系統整合', '智慧製造', '綠色科技', '數位健康'];
    var now = nowIso_();
    var referrers = Array.from({ length: 4 }, function (_, index) {
      return createReferrerRecord_({
        demo: true,
        code: 'DEMO-GROUP-' + (index + 1),
        displayName: 'DEMO｜社群 ' + (index + 1),
        legalName: 'DEMO｜示意引薦法人 ' + (index + 1),
        contactName: 'DEMO｜引薦窗口 ' + (index + 1),
        contactEmail: 'referrer' + (index + 1) + '@example.invalid',
        status: 'active',
        defaultCommissionRateBps: 250 + index * 50,
        commissionBasis: 'allocated_amount',
        agreementReference: 'DEMO-AGREEMENT-' + String(index + 1).padStart(3, '0'),
        effectiveAt: now,
        expiresAt: '2028-01-01T00:00:00.000Z'
      }, 'referrer-' + String(index + 1).padStart(2, '0'), now);
    });
    var projects = industries.map(function (industry, index) {
      var number = index + 1;
      var id = 'project-' + String(number).padStart(2, '0');
      return {
        id: id, demo: true, slug: 'demo-project-' + number,
        publicVisibility: index % 3 === 0 ? 'teaser' : 'anonymous',
        displayName: 'DEMO｜' + industry + '成長計畫 ' + number,
        industry: industry, stage: ['種子輪', 'Pre-A', 'A 輪'][index % 3], region: '台灣',
        summary: 'DEMO｜虛構募資摘要，僅供介面與流程驗證，不代表任何投資邀約。',
        highlights: ['DEMO｜具驗證里程碑', 'DEMO｜資金用途示意', 'DEMO｜產業專家覆核'],
        videoUrl: '', updatedAt: now,
        companyName: 'DEMO｜示意企業股份有限公司 ' + number,
        taxId: 'DEMO' + (1000 + number), round: ['Seed', 'Pre-A', 'Series A'][index % 3],
        targetAmountTwd: (30 + index * 10) * 1000000,
        minimumAmountTwd: 500000, incrementAmountTwd: 100000,
        deadline: '2027-12-31', valuationNote: 'DEMO｜估值待持牌合作機構核准後揭露',
        useOfFunds: ['DEMO｜產品驗證', 'DEMO｜法規與品質', 'DEMO｜市場拓展'],
        teamSummary: 'DEMO｜虛構跨產業團隊。',
        financialSummary: 'DEMO｜虛構財務資料，僅用於權限測試。',
        risks: ['DEMO｜技術驗證風險', 'DEMO｜市場採用風險', 'DEMO｜流動性風險'],
        reports: [
          { id: 'report-ai-' + number, type: 'ai', version: 1, approved: true, reviewedBy: 'DEMO｜示意專家' },
          { id: 'report-expert-' + number, type: 'expert', version: 1, approved: true, reviewedBy: 'DEMO｜示意專家' }
        ],
        deck: {
          id: 'deck-' + number,
          objectKey: 'decks/' + id + '/deck-' + number + '.pdf',
          filename: 'DEMO-' + id + '-pitch-deck.pdf',
          contentType: 'application/pdf'
        },
        memberAllowlist: []
      };
    });
    var members = Array.from({ length: 30 }, function (_, index) {
      var number = index + 1;
      var id = 'member-' + String(number).padStart(3, '0');
      var membershipState = number <= 24 ? 'active' : number <= 28 ? 'pending' : 'rejected';
      var qualificationState = number <= 18 ? 'approved' : number <= 23 ? 'reviewing' : 'not_applied';
      var referrer = referrers[index % referrers.length];
      return {
        id: id, demo: true, displayName: 'DEMO｜示意會員 ' + String(number).padStart(2, '0'),
        legalName: 'DEMO｜測試姓名 ' + String(number).padStart(2, '0'),
        phone: '09' + String(10000000 + number), email: 'demo' + number + '@example.invalid',
        lineUserId: 'demo-line-user-' + String(number).padStart(3, '0'),
        lineFriendshipState: number % 5 === 0 ? 'unknown' : 'friend',
        sourceGroup: referrer.displayName, membershipState: membershipState,
        qualificationState: qualificationState,
        qualificationApproval: qualificationState === 'approved' ? {
          approver: 'DEMO｜持牌合作機構', approvedAt: now,
          reference: 'DEMO-Q-' + String(number).padStart(4, '0'), expiresAt: '2027-12-31T00:00:00.000Z'
        } : null,
        tier: ['free', 'professional', 'special'][index % 3],
        projectAccess: [
          'project-' + String((index % 6) + 1).padStart(2, '0'),
          'project-' + String(((index + 1) % 6) + 1).padStart(2, '0')
        ],
        referralAttribution: {
          referrerId: referrer.id, referralCode: referrer.code, state: 'verified',
          evidenceReference: 'DEMO-R-' + String(number).padStart(4, '0'),
          claimedAt: now, verifiedBy: 'DEMO｜admin', verifiedAt: now
        },
        createdAt: now, updatedAt: now
      };
    });
    referrers.forEach(function (referrer) { storeAppend_('Referrers', referrer); });
    projects.forEach(function (project, index) {
      project.memberAllowlist = members.filter(function (member, memberIndex) {
        return memberIndex < 18 && memberIndex % 6 === index;
      }).map(function (member) { return member.id; });
      storeAppend_('Projects', project);
    });
    members.forEach(function (member) { storeAppend_('Members', member); });
    Array.from({ length: 25 }, function (_, index) {
      var member = members[index % 18];
      var projectId = member.projectAccess[0];
      var requested = 500000 + (index % 6) * 100000;
      var received = index % 4 === 0 ? 0 : index % 4 === 1 ? Math.floor(requested / 2) : requested;
      var refunded = index % 11 === 0 ? received : 0;
      var allocated = refunded || !received ? 0 : index % 3 === 0 ? Math.floor(received / 2) : received;
      var subscription = {
        id: 'subscription-' + String(index + 1).padStart(3, '0'), demo: true,
        memberId: member.id, projectId: projectId,
        membershipState: 'active', qualificationState: 'approved', subscriptionState: 'approved',
        fundingState: refunded ? 'refunded' : !received ? 'unpaid' : received < requested ? 'partial' : 'paid',
        allocationState: !allocated ? 'pending' : allocated < received - refunded ? 'partial' : 'final',
        requestedAmountTwd: requested, approvedAmountTwd: requested,
        receivedAmountTwd: received, allocatedAmountTwd: allocated, refundedAmountTwd: refunded,
        riskAcknowledged: true, riskAcknowledgedAt: now, riskDisclosureVersion: 'demo-draft-0.1',
        partnerApproval: {
          approver: 'DEMO｜持牌合作機構', approvedAt: now,
          reference: 'DEMO-S-' + String(index + 1).padStart(4, '0')
        },
        createdAt: now, updatedAt: now
      };
      initializeCommissionFields_(
        subscription,
        referralSnapshotForMember_(member, referrers, now),
        now
      );
      validateAmounts_(subscription);
      subscription.commissionBasisAmountTwd = subscription.allocatedAmountTwd;
      subscription.commissionAccruedAmountTwd = calculateCommissionAmount_(
        subscription.allocatedAmountTwd,
        subscription.referralSnapshot.commissionRateBps
      );
      if (subscription.allocationState === 'final' && subscription.allocatedAmountTwd > 0) {
        subscription.commissionState = 'accrued';
      }
      storeAppend_('Subscriptions', subscription);
    });
    appendAudit_({
      entityType: 'system', entityId: 'demo-seed', action: 'seed.demo_initialized',
      actor: { type: 'admin', id: Session.getEffectiveUser().getEmail() || 'setup-user' },
      before: null, after: { demo: true, projects: 6, members: 30, subscriptions: 25, referrers: 4 },
      reason: 'Explicitly initialize clearly labelled Demo records'
    });
    return { demo: true, projects: 6, members: 30, subscriptions: 25, referrers: 4 };
  });
}
