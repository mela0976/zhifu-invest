# 致富投資 MVP — confirmed product baseline

## Outcome

Build a mobile-first Taiwan investment-membership MVP for 引薦人 and other approved high-net-worth investor referral networks. The first measurable outcome is converting referral traffic into verified LINE members, advisory bookings, traceable subscription-interest operations, and evidence-backed referral commission records.

The product is not an online securities transaction or payment system. Contracts, qualification evidence, and money movement remain outside the MVP. The system records approval references and operational results.

## Roles

- Visitor: sees public education, videos, advisors, and anonymized project teasers.
- Member: LINE-authenticated, manually confirmed by 引薦人, sees only their own records.
- Qualified member: gains access only to specifically authorized projects.
- Referrer: an approved introducer or partner whose source code may be attached to a member; the MVP does not expose investor identities, amounts, or portfolio data to this role.
- 引薦人 / operations: confirms community membership, records subscription and financial milestones, operates notifications and exports.
- Licensed partner: approves regulated content, investor qualification, and accepted amounts outside the system; operations must record the approver, date, and reference number.
- Finance: represented as an auditable operation when actual receipt, allocation, or refund is recorded.

## Independent workflows

1. Membership: pending → active / rejected / disabled.
2. Qualification: not applied → reviewing → needs information → approved / rejected / expired.
3. Subscription: draft → submitted → operations confirmed → partner review → approved / rejected / cancelled.
4. Funding: unpaid → partial → paid / refunded.
5. Allocation: pending → partial → final.
6. Referral attribution: claimed → verified / rejected. A source code creates only a claim; operations must verify evidence before it can be snapshotted into a subscription.
7. Commission: not applicable / pending → accrued → approved → paid, or void. Approval and payment require separate evidence, and paid records are immutable.

Each subscription stores requested, approved, received, allocated, and refunded TWD amounts. Every mutation appends an application-level append-only audit event with actor, time, before/after values, and reason. Google Sheets is not a WORM store; a regulated retention lock requires a separate production audit service.

When a member submits a subscription, the system copies the verified referrer, agreement reference, commission basis, and rate into an immutable referral snapshot. Later changes to a referrer or member affect only future subscriptions. The MVP calculates accrued commission from the final allocated amount using integer basis points and rounds down to whole TWD; this operational estimate is not legal entitlement to payment.

## Surfaces

### Public and member web

- Landing page, public project teasers, advisors, expert content, video library, advisory booking, legal/privacy pages.
- LINE member activation and official-account friendship path.
- Member home, permitted projects, project detail, report and Pitch Deck access, subscription application, personal portfolio, qualification state, appointments, settings and membership tier.
- Mobile bottom navigation: Home, Projects, My investments, More.

### 引薦人 dashboard

- KPI overview and action queue.
- Member confirmation and LINE friendship state.
- Qualification approval-reference recording.
- Project, subscription, received amount, allocation and refund management.
- Referrer registry, member attribution verification, immutable subscription referral snapshots, projected commission, approval evidence and payment evidence.
- Content/video/report administration, appointments, notifications, CSV export and audit history.

## LINE

- Add Friend, LINE Login, LIFF, transactional push notifications and webhook-ready gateway.
- Login and Messaging channels must share one LINE Provider.
- Existing LINE groups and OpenChat are acquisition sources, not identity databases.
- Activation path: Snowfen/partner group link → LINE Login → add OA → submit identity/source code → operations manually confirms both membership and, separately, any referral claim.
- Member messages reveal only that a status changed and deep-link back to the authenticated site. Amounts remain inside the member portal.
- Routine transactional events may send automatically. Rejection, refund and bulk sends require manual confirmation. Failed sends retry three times, then enter the operations queue.

## Content and access

- Four access layers: visitor, member, qualified member, administrator, plus per-project allowlists.
- Project visibility is configurable; the default public view is anonymized.
- AI and expert reports remain distinct, versioned, dated and reviewer-labelled. AI material requires expert approval before release.
- Short videos are produced externally and embedded or published by URL in the MVP.
- Secure Pitch Deck access uses expiring authorization, personalized watermarking and an audit log.
- All current companies, people, amounts and performance values are clearly labelled Demo content until authorized assets arrive.

## Architecture

- Local first: one Docker-served JavaScript application with provider adapters and fully functional Demo auth/data/notifications.
- Production target: GitHub Pages for public/member UI; Cloudflare Worker for LINE auth, secure cookie session, protected API/webhook and R2 documents; Apps Script + Google Sheets for the operations dashboard and automation.
- Repository target: public `mela0976/zhifu-invest`; no credentials or personal/investment data in GitHub.

## Visual direction

深海軍藍、象牙白、低彩度香檳金，結合引薦人日後提供的正式人物素材。The interface should feel like a precise private-market research ledger, not a black-and-gold get-rich promotion. Typography, status stamps, ledger lines and restrained motion carry the identity.

## Acceptance

Completion requires real mobile/browser validation, LINE login and OA delivery, manual membership confirmation, gated project access, end-to-end subscription amount tracking, immutable referral snapshots, evidence-gated commission approval/payment, expiring document access, per-member/referrer privacy, auditable admin exports, privacy-safe analytics, deployed GitHub Pages, and proof that no secrets or real member data entered the repository.
