const STORAGE_KEY = 'zhifu.locale.v1';
const DEFAULT_LOCALE = 'zh-Hant';

const ENGLISH_TEXT = new Map(Object.entries({
  '跳至主要內容': 'Skip to main content',
  '跳至啟用表單': 'Skip to activation form',
  '致富投資首頁': 'Zhifu Investment home',
  '回到致富投資首頁': 'Back to Zhifu Investment home',
  '回到首頁': 'Back to home',
  '主要導覽': 'Primary navigation',
  '頁尾導覽': 'Footer navigation',
  '本頁段落': 'On this page',
  '開啟選單': 'Open menu',
  '關閉選單': 'Close menu',
  '認識平台': 'About',
  '募資研究': 'Fundraising research',
  '資訊分享': 'Insights',
  '聯絡我們': 'Contact',
  'LINE 會員入口': 'LINE member access',
  'Demo 環境｜所有人物、公司與金額均為示意。': 'Demo environment | All people, companies, and amounts are fictional.',
  'Demo 會員 A': 'Demo Member A',
  'Demo 會員 B': 'Demo Member B',
  'LOCAL DEMO｜所有人物、企業與金額均為示意，不構成投資建議': 'LOCAL DEMO | All people, companies, and amounts are fictional and not investment advice.',
  'GITHUB STATIC PREVIEW｜唯讀介面預覽，不會儲存或送出任何資料': 'GITHUB STATIC PREVIEW | Read-only interface; no data will be saved or submitted.',
  'CONNECTED DEMO API｜資料由遠端 Demo 服務提供，不會回退瀏覽器內建會員資料': 'CONNECTED DEMO API | Data comes from the remote demo service; no browser fixture fallback.',
  'SECURE ONLINE SERVICE｜會員資料需登入並通過資格驗證': 'SECURE ONLINE SERVICE | Member data requires login and qualification verification.',
  '讓資金，': 'Let capital',
  '先看懂產業。': 'understand the industry first.',
  '從產業研究、專家審閱到會員專屬資料室，讓投資人與企業在資訊清楚、權限分明的前提下開始對話。': 'From industry research and expert review to member-only data rooms, investors and companies can begin with clear information and explicit access boundaries.',
  '用 LINE 啟用會員': 'Activate with LINE',
  '了解平台如何運作': 'How the platform works',
  '本平台不處理證券交易、契約簽署或金流；所有投資皆有風險，資格與認購接受由合作機構於站外審核。': 'The platform does not execute securities trades, contracts, or payments. All investments involve risk; eligibility and subscription acceptance are reviewed off-platform by partner institutions.',
  '用 LINE 啟用致富投資會員': 'Activate a Zhifu Investment membership with LINE',
  '專業團隊共同檢視產業研究與技術資料的示意影像': 'Illustration of a professional team reviewing industry research and technical materials',
  '不是把標的放上網，': 'We do more than list opportunities.',
  '而是先把判斷方法說清楚。': 'We make the decision process clear first.',
  '致富投資串聯投資會員、產業專家與募資企業，把原本散落在簡報、群組與會議裡的資訊，整理成可審閱、可授權、可追溯的研究流程。': 'Zhifu Investment connects members, industry experts, and fundraising companies, turning scattered decks, group messages, and meetings into a reviewable, permissioned, and traceable research process.',
  '平台作業原則': 'Platform operating principles',
  'LINE 身分綁定': 'LINE identity linking',
  '登入不等於通過，會員來源仍需人工核對。': 'Signing in is not approval; membership sources are still verified manually.',
  'AI 與專家分軌': 'Separate AI and expert tracks',
  '報告標示版本、基準日與審閱狀態。': 'Reports show their version, basis date, and review status.',
  '逐案資料授權': 'Project-level access',
  '資格通過後，只開放獲准查看的專案。': 'After qualification, members only see projects they are authorized to access.',
  '流程異動留痕': 'Auditable workflow',
  '認購、入金、分配與退款分開記錄。': 'Subscriptions, funds received, allocations, and refunds are recorded separately.',
  '查看研究中的產業項目': 'Explore current industry research',
  '把關鍵資源，放進同一條可信流程': 'Bring key resources into one trusted workflow',
  '權限檢核': 'Access checks',
  '層': 'layers',
  '報告路徑': 'Report tracks',
  '軌': 'tracks',
  'LINE 身分': 'LINE identity',
  '綁定': 'linked',
  '認購金額': 'Amount records',
  '類分帳': 'separate fields',
  '募資研究，': 'Fundraising research,',
  '不從口號開始。': 'grounded in evidence.',
  '公開頁只顯示匿名產業摘要。公司、條件、財務與完整報告，須完成會員確認及逐案授權後查看。': 'Public pages show anonymized industry summaries only. Company identity, terms, financials, and full reports require verified membership and project-level access.',
  '申請會員權限': 'Request member access',
  '依產業篩選': 'Filter by industry',
  '全部研究': 'All research',
  '左右滑動查看更多研究': 'Swipe to explore more research',
  '募資研究輪播': 'Fundraising research carousel',
  '正在整理研究索引': 'Preparing the research index',
  '把資訊，整理成能夠追問的問題': 'Turn information into questions worth asking',
  '左右滑動查看更多主題': 'Swipe to explore more topics',
  '資訊分享主題輪播': 'Insight topics carousel',
  '產業拆解 · 03:40': 'Industry briefing · 03:40',
  '先看市場，不急著看標的：生技授權的三個判讀節點': 'Start with the market: three checkpoints for biotech licensing',
  '示意內容｜從市場規模、法規路徑與授權節點建立研究問題。': 'Sample content | Frame research questions around market size, regulatory pathways, and licensing milestones.',
  '討論這個主題 →': 'Discuss this topic →',
  '前往預約顧問討論生技授權研究': 'Book an advisor to discuss biotech licensing research',
  '研究方法 · 02:15': 'Research method · 02:15',
  'AI 報告怎麼讀，才不會把推論當事實？': 'How should an AI report be read without mistaking inference for fact?',
  '示意內容｜區分資料、假設與專家審閱責任。': 'Sample content | Separate data, assumptions, and expert review responsibility.',
  '前往預約顧問討論 AI 報告': 'Book an advisor to discuss AI reports',
  '流程說明 · 01:50': 'Process guide · 01:50',
  '從會員啟用到認購意向，資料如何被確認': 'How data is verified from member activation to subscription interest',
  '示意內容｜了解身分、資格、專案與流程紀錄的邊界。': 'Sample content | Understand the boundaries between identity, qualification, projects, and workflow records.',
  '開始會員啟用 →': 'Start member activation →',
  '結構化擴充': 'Structured expansion',
  '整理公開資料、問題清單與情境推演；清楚標示模型、資料基準日與版本。': 'Organize public data, question lists, and scenarios, with model, basis date, and version clearly identified.',
  '領域專家審閱': 'Domain expert review',
  '生技、半導體與系統領域採不同框架；正式人選須取得授權後公告。': 'Biotech, semiconductor, and systems research use distinct frameworks; named reviewers are announced only with authorization.',
  '發布前留證': 'Evidence before publication',
  '專': 'EX',
  '核': 'OK',
  '涉及募資條件與投顧內容，須登錄合作方核准人、日期與參考編號。': 'Fundraising terms and regulated advisory content require a partner approver, date, and reference number.',
  '先確認真偽，': 'Verify authenticity first.',
  '再回來看資料。': 'Then return to the data.',
  '致富投資不會在 LINE 訊息內要求轉帳，也不會承諾獲利。': 'Zhifu Investment will never request a transfer in a LINE message or promise returns.',
  '只從官方入口登入': 'Sign in only through the official entry point',
  '核對網址及 LINE 官方帳號，不透過陌生短網址輸入資料。': 'Verify the website and official LINE account; never enter data through an unfamiliar short link.',
  '金額只在登入後查看': 'View amounts only after signing in',
  'LINE 通知只提示狀態更新，不顯示認購、入金或分配金額。': 'LINE notifications only indicate a status update and never show subscription, payment, or allocation amounts.',
  '契約與匯款皆在站外確認': 'Confirm contracts and transfers off-platform',
  '平台只記錄流程結果；遇到可疑要求，請停止操作並聯絡官方窗口。': 'The platform records workflow results only. Stop and contact the official channel if a request looks suspicious.',
  '你想先從哪裡開始？': 'Where would you like to begin?',
  '會員申請': 'Member application',
  '募資與顧問申請': 'Fundraising and advisory inquiry',
  '先說你想釐清的問題': 'Tell us what you want to clarify',
  '送出的是聯絡與諮詢需求，不是投資申請或付款指示。營運端確認後，將以正式管道回覆。': 'This submits a contact and consultation request, not an investment application or payment instruction. Operations will respond through an official channel after review.',
  '你的身分': 'Your role',
  '請選擇': 'Please select',
  '投資會員': 'Investor member',
  '募資企業': 'Fundraising company',
  '其他合作': 'Other partnership',
  '諮詢類型': 'Consultation type',
  '會員與投資流程': 'Membership and investment workflow',
  '生技市場研究': 'Biotech market research',
  '半導體／系統策略': 'Semiconductor / systems strategy',
  '企業募資顧問': 'Corporate fundraising advisory',
  '稱呼': 'Name',
  '聯絡電話': 'Phone number',
  '偏好日期': 'Preferred date',
  '偏好時段': 'Preferred time',
  '想先討論的事': 'What would you like to discuss?',
  '請簡短說明目前情況與希望釐清的問題': 'Briefly describe your situation and the questions you would like to clarify.',
  '我同意依': 'I agree to the collection of necessary contact information under the ',
  '隱私權政策草案': 'draft Privacy Policy',
  '蒐集必要聯絡資料，並了解送出後由引薦人人工確認正式時間。': ', and understand that a referrer will manually confirm the final appointment time.',
  '送出預約需求': 'Submit consultation request',
  '手機會員快捷操作': 'Mobile member shortcut',
  '從 LINE 啟用會員': 'Activate membership with LINE',
  '開啟 LINE': 'Open LINE',
  '研究先行、權限清楚、流程留痕的會員服務平台。': 'A member service platform built on research, explicit permissions, and traceable workflows.',
  '法律與安全': 'Legal and safety',
  '投資風險與防詐聲明': 'Investment risk and anti-fraud notice',
  '會員服務條款草案': 'Draft Member Service Terms',
  '引薦人 Demo 後台': 'Referrer demo console',
  '平台品牌：致富投資｜power by 奇華智能投資顧問股份有限公司｜平台營運、持牌投顧及資格審核主體：正式發布前確認': 'Brand: Zhifu Investment | powered by Chi Hua Intelligent Investment Consulting Co., Ltd. | Platform operator, licensed advisor, and qualification reviewer: to be confirmed before launch.',
  '專案摘要': 'Project summary',
  '關閉': 'Close',
  '稍後再看': 'Maybe later',
  '公開匿名摘要': 'Public anonymized summary',
  '查看研究摘要': 'View research summary',
  '研究中': 'In research',
  '專案摘要整理中。': 'Project summary in preparation.',
  '待分類': 'To be classified',
  '待確認': 'To be confirmed',
  '台灣': 'Taiwan',
  '正式會員': 'Verified members',
  '逐案授權': 'Project authorization',
  '此分類尚無研究': 'No research in this category yet',
  '切換其他產業，或稍後回來查看更新。': 'Choose another industry or return later for updates.',
  '公開頁只提供匿名摘要，完整公司資料與募資條件須完成資格及逐案授權。': 'The public site provides anonymized summaries only. Full company information and fundraising terms require qualification and project-level authorization.',
  '研究索引': 'Research index',
  '產業': 'Industry',
  '階段': 'Stage',
  '地區': 'Region',
  '最低認購': 'Minimum subscription',
  '登入並取得權限後查看': 'Available after sign-in and authorization',
  '核心觀察': 'Key observations',
  '一般風險提示': 'General risk notice',
  '新創與未上市投資具有高度不確定性，可能損失全部投入資金。': 'Startup and private-market investments are highly uncertain and may result in a total loss of capital.',
  '研究索引暫時無法載入': 'Research index is temporarily unavailable',
  '連線沒有完成，請確認網路後重試。': 'The connection did not complete. Check your network and try again.',
  '重新載入': 'Reload',
  '正在送出…': 'Submitting…',
  '預約需求已送出，引薦人確認後會通知你。': 'Your consultation request has been submitted. You will be notified after referrer confirmation.',
  '處理中…': 'Processing…',
  '切換中…': 'Switching…',
  '尚未設定': 'Not set',
  '已連結': 'Linked',

  '精準醫療研發計畫': 'Precision Medicine R&D Program',
  '生技醫療': 'Biotech & healthcare',
  '臨床驗證': 'Clinical validation',
  '以伴隨式檢測支持治療決策，現階段聚焦臨床驗證與海外授權準備。': 'Using companion diagnostics to support treatment decisions, currently focused on clinical validation and overseas licensing readiness.',
  '完成多中心前期驗證': 'Completed early multi-center validation',
  '建立醫療通路合作框架': 'Established a healthcare channel partnership framework',
  '規劃國際授權路徑': 'Planning an international licensing pathway',
  '臨床結果、法規核准與商業化時程具有不確定性。': 'Clinical outcomes, regulatory approval, and commercialization timelines are uncertain.',
  '邊緣運算晶片計畫': 'Edge Computing Chip Program',
  '半導體': 'Semiconductor',
  '量產準備': 'Production readiness',
  '低功耗邊緣運算方案，鎖定工業視覺與智慧設備的在地供應鏈機會。': 'A low-power edge computing solution targeting local supply-chain opportunities in industrial vision and smart devices.',
  '完成首版工程樣品': 'Completed the first engineering sample',
  '兩項場域驗證進行中': 'Two field validations in progress',
  '供應鏈以台灣為核心': 'Taiwan-centered supply chain',
  '量產良率、客戶驗證及供應鏈成本可能影響營運成果。': 'Production yield, customer validation, and supply-chain costs may affect operating results.',
  '智慧製造整合計畫': 'Smart Manufacturing Integration Program',
  '系統整合': 'Systems integration',
  '營收成長': 'Revenue growth',
  '整合工廠資料與 AI 品質預測，協助中型製造商縮短導入週期。': 'Integrating factory data with AI quality prediction to shorten deployment cycles for mid-sized manufacturers.',
  '三座工廠驗證完成': 'Validation completed at three factories',
  '訂閱式維運收入': 'Subscription-based maintenance revenue',
  '跨設備資料模型': 'Cross-device data model',
  '專案交付能力及客戶集中度可能影響收入穩定性。': 'Delivery capacity and customer concentration may affect revenue stability.',
  '健康老化服務計畫': 'Healthy Aging Service Program',
  '健康科技': 'Health technology',
  '市場驗證': 'Market validation',
  '結合藥師顧問與數位追蹤，建立社區型健康老化服務。': 'Combining pharmacist consultation and digital tracking to build community-based healthy-aging services.',
  '社區示範據點營運中': 'Community pilot site in operation',
  '藥事專家參與設計': 'Designed with pharmacy experts',
  '可複製的服務流程': 'Repeatable service workflow',
  '服務採用率與合作據點拓展速度仍待驗證。': 'Service adoption and partner-site expansion remain to be validated.',
  '工業節能控制計畫': 'Industrial Energy Control Program',
  '能源管理': 'Energy management',
  '商業擴張': 'Commercial expansion',
  '以即時控制降低製程能耗，依節能成果提供持續服務。': 'Using real-time controls to reduce process energy use and provide ongoing services based on verified savings.',
  '可量化節能基準': 'Measurable energy-saving baseline',
  '既有工業客戶續約': 'Renewals from existing industrial customers',
  '能源資料稽核機制': 'Energy data audit mechanism',
  '節能成果受場域條件、設備維護與能源價格影響。': 'Energy-saving results depend on site conditions, equipment maintenance, and energy prices.',
  '服務型機器人計畫': 'Service Robotics Program',
  '智慧機器': 'Intelligent machines',
  '產品驗證': 'Product validation',
  '針對照護與商用場域的模組化服務型機器人解決方案。': 'A modular service-robotics solution for care and commercial settings.',
  '模組化硬體平台': 'Modular hardware platform',
  '兩類服務場域試運行': 'Pilots in two service settings',
  '建立合作維修網路': 'Partner maintenance network established',
  '硬體量產、售後維護與場域法規均可能增加成本。': 'Hardware production, after-sales maintenance, and site regulations may increase costs.',
  '募集中': 'Fundraising open',
  '接近額滿': 'Near capacity',
  '資料審閱': 'Under data review',
  '即將開放': 'Opening soon',
  'DEMO｜生技醫療成長計畫 1': 'DEMO | Biotech & Healthcare Growth Program 1',
  'DEMO｜半導體成長計畫 2': 'DEMO | Semiconductor Growth Program 2',
  'DEMO｜系統整合成長計畫 3': 'DEMO | Systems Integration Growth Program 3',
  'DEMO｜智慧製造成長計畫 4': 'DEMO | Smart Manufacturing Growth Program 4',
  'DEMO｜綠色科技成長計畫 5': 'DEMO | Green Technology Growth Program 5',
  'DEMO｜數位健康成長計畫 6': 'DEMO | Digital Health Growth Program 6',
  '智慧製造': 'Smart manufacturing',
  '綠色科技': 'Green technology',
  '數位健康': 'Digital health',
  '種子輪': 'Seed round',
  'A 輪': 'Series A',
  '此為產品操作驗證用的虛構募資摘要，不代表任何投資邀約。': 'This fictional fundraising summary is for product validation only and is not an investment solicitation.',
  '具驗證里程碑': 'Defined validation milestones',
  '清楚的資金用途': 'Clear use of funds',
  '產業專家覆核': 'Industry expert review',

  'LOCAL DEMO｜正式 LINE Channel 設定前，登入步驟由 Demo 身分取代': 'LOCAL DEMO | Demo identity replaces LINE Login until the production channel is configured.',
  '把社群身分，': 'Bring your community identity',
  '安全帶進會員中心。': 'securely into the member portal.',
  'LINE 群組與 OpenChat 只用來導流，不自動視為會員。啟用申請仍由引薦人人工核對。': 'LINE groups and OpenChat are acquisition channels, not automatic proof of membership. A referrer still reviews every activation request.',
  '啟用進度': 'Activation progress',
  'LINE 登入': 'LINE Login',
  '加入官方帳號': 'Add official account',
  '填寫身分與來源': 'Enter identity and source',
  '等待人工確認': 'Await manual review',
  '啟用既有會員資格': 'Activate an existing membership',
  '登入、加入官方帳號，再填寫引薦人社群來源；三件事完成後才送出審核。': 'Sign in, add the official account, and enter your referrer community source before submitting for review.',
  '尚未連結 LINE 身分': 'LINE identity not linked',
  '正式環境將前往 LINE Login；Demo 可選擇測試會員。': 'Production opens LINE Login; demo mode lets you choose a test member.',
  '使用 LINE 登入': 'Sign in with LINE',
  'Demo 會員登入': 'Demo member login',
  '真實姓名': 'Legal name',
  '僅供人工核對，不會顯示於公開頁。': 'Used only for manual verification and never shown publicly.',
  '手機號碼': 'Mobile number',
  '社群來源碼': 'Community source code',
  '例如 REFERRER-NORTH': 'e.g. REFERRER-NORTH',
  '你加入的群組／OpenChat': 'Your group / OpenChat',
  '例如：北區投資班': 'e.g. North District Investor Group',
  '加入致富投資 LINE 官方帳號': 'Add the Zhifu Investment official LINE account',
  '我已加入官方帳號，並了解封鎖官方帳號後將無法收到狀態通知。': 'I have added the official account and understand that blocking it prevents status notifications.',
  '我已閱讀並同意': 'I have read and agree to the ',
  '及必要的 LINE 交易通知。': ' and necessary LINE transaction notifications.',
  '送出會員啟用申請': 'Submit membership activation',
  '防詐提醒：我們不會在此流程要求匯款、信用卡或銀行密碼。若收到可疑訊息，請停止操作。': 'Anti-fraud reminder: we will never request a transfer, card details, or banking password in this flow. Stop if you receive a suspicious message.',
  'LINE 會員': 'LINE member',
  '接著加入官方帳號並填寫社群來源。': 'Next, add the official account and enter your community source.',
  '正式 LINE 官方帳號尚待設定；Demo 可勾選完成流程。': 'The production LINE official account is not configured yet; demo mode can complete the flow.',
  'LINE 設定暫時無法讀取，仍可使用 Demo 流程。': 'LINE configuration is temporarily unavailable; you can still use the demo flow.',
  '目前尚未連結 LINE 身分。': 'LINE identity is not linked yet.',
  '登入中…': 'Signing in…',
  '申請已送出': 'Application submitted',
  '引薦人將核對你的社群來源。確認完成後，LINE 只會通知「狀態已更新」，請回到會員中心查看內容。': 'A referrer will verify your community source. When complete, LINE will only say that your status changed; return to the member portal for details.',
  '查看會員中心': 'View member portal',

  '隱私權政策草案': 'Draft Privacy Policy',
  '只蒐集完成會員、資格與服務流程必要的資料。': 'We collect only the data needed for membership, qualification, and service workflows.',
  '蒐集資料': 'Data collected',
  '使用目的': 'Purposes',
  'LINE 與分析': 'LINE and analytics',
  '會員權利': 'Member rights',
  '待法律審閱': 'Pending legal review',
  '營運主體、聯絡窗口、保存年限與跨境處理資訊須在正式上線前補齊。': 'The operating entity, contact point, retention periods, and cross-border processing details must be completed before launch.',
  '｜營運主體、聯絡窗口、保存年限與跨境處理資訊須在正式上線前補齊。': ' | The operating entity, contact point, retention periods, and cross-border processing details must be completed before launch.',
  '可能蒐集的資料': 'Data we may collect',
  '會員啟用時可能蒐集 LINE userId、顯示名稱、真實姓名、手機、Email、社群來源碼、官方帳號好友狀態及同意紀錄。資格流程僅保存狀態、審核機構、審核人、日期、參考編號與有效期限；第一版不在平台上傳身分證或財力證明。': 'Member activation may collect a LINE user ID, display name, legal name, phone, email, community source code, official-account friendship status, and consent records. Qualification stores only status, reviewing institution, reviewer, date, reference, and expiry; the first release does not upload identity or financial documents.',
  '認購作業保存專案、申請／核准／入金／分配／退款金額、各流程狀態、時間、操作者與更正原因。這些紀錄不會公開，也不會顯示給其他會員。': 'Subscription operations store the project, requested, approved, received, allocated, and refunded amounts, plus workflow states, times, actors, and correction reasons. These records are not public or visible to other members.',
  '處理目的與權限': 'Purposes and access',
  '驗證社群來源與啟用會員服務。': 'Verify community source and activate member services.',
  '依資格與專案白名單控制資料室存取。': 'Control data-room access by qualification and project allowlist.',
  '記錄認購意向及站外核准、入金與分配結果。': 'Record subscription interest and off-platform approval, payment, and allocation outcomes.',
  '發送必要狀態通知、處理顧問預約及建立稽核歷程。': 'Send required status notifications, handle advisor bookings, and maintain an audit trail.',
  '引薦人可操作營運後台；涉及資格或受監管內容時，仍須保存合作方站外核准證據。技術管理權不等於合規核准權。': 'Referrers may operate the administration console, but partner approval evidence is still required for qualification or regulated content. Technical administration is not compliance approval.',
  'LINE 與網站分析': 'LINE and website analytics',
  'LINE Login 與 Messaging API Channel 應置於同一 Provider。必要交易通知只提示狀態更新，不在 LINE 訊息顯示認購或財務金額。行銷通知使用獨立同意，可隨時取消。': 'LINE Login and Messaging API channels should be under the same Provider. Required transaction notices only indicate status changes and never show subscription or financial amounts. Marketing notices require separate, revocable consent.',
  'GA4 僅可記錄不含個資的頁面與轉換事件；姓名、手機、Email、LINE userId、會員編號及任何認購金額不得傳送至分析工具。': 'GA4 may record only page and conversion events without personal data. Names, phone numbers, email, LINE user IDs, member IDs, and subscription amounts must never be sent to analytics.',
  '查詢、更正與停用': 'Access, correction, and deactivation',
  '會員可要求查詢或更正個人資料、停止非必要行銷通知或停用帳戶。帳戶停用後，非必要個資將依正式政策刪除或去識別；依法或依合作方規則須保存的認購與稽核紀錄將封存，而不是直接硬刪除。': 'Members may request access to or correction of personal data, stop non-essential marketing, or deactivate their account. Non-essential data will be deleted or de-identified under the final policy; required subscription and audit records will be archived rather than hard-deleted.',
  '草案版本：0.1｜最後更新：2026-08-18｜個資聯絡窗口待正式營運主體確認': 'Draft v0.1 | Last updated: 2026-08-18 | Privacy contact pending confirmation of the operating entity',

  '先理解可能損失什麼，再決定是否繼續。': 'Understand what you could lose before deciding whether to continue.',
  '服務邊界': 'Service boundary',
  '主要風險': 'Key risks',
  '防詐辨識': 'Fraud prevention',
  'AI 內容': 'AI content',
  '法律草案': 'Legal draft',
  '正式發布前須由持牌合作方及律師確認。內容不構成法律、稅務或投資建議。': 'A licensed partner and legal counsel must approve this before publication. It is not legal, tax, or investment advice.',
  '｜正式發布前須由持牌合作方及律師確認。內容不構成法律、稅務或投資建議。': ' | A licensed partner and legal counsel must approve this before publication. It is not legal, tax, or investment advice.',
  '致富投資 MVP 提供產業教育、會員資料室、顧問預約與認購意向的作業紀錄。平台不在線上成立證券交易、不代收投資款、不在站內完成契約。投資人資格、受監管內容與可接受金額，由持牌合作機構於站外審核，平台僅保存核准參考資料與後續作業結果。': 'The Zhifu Investment MVP provides industry education, member data rooms, advisor bookings, and operational records of subscription interest. It does not execute securities trades, receive investment funds, or conclude contracts online. A licensed partner reviews investor eligibility, regulated content, and acceptable amounts off-platform; the platform stores approval references and subsequent workflow outcomes only.',
  '未上市投資主要風險': 'Key private-market investment risks',
  '投資可能損失全部投入資金，且不保證任何報酬。': 'You may lose all invested capital, and no return is guaranteed.',
  '未上市股權通常缺乏流動性，可能長期無法轉讓或退出。': 'Private shares are generally illiquid and may not be transferable or exit-able for a long period.',
  '募資企業的技術、法規、市場、團隊及財務假設都可能改變。': 'A fundraising company’s technology, regulation, market, team, and financial assumptions may change.',
  '估值與績效資料可能採非市場即時價格，應核對資料基準日與來源。': 'Valuation and performance data may not use live market prices; verify the basis date and source.',
  '超額認購可能只獲部分分配，最終分配不等於申請或核准金額。': 'Oversubscription may lead to partial allocation; final allocation differs from requested or approved amounts.',
  '官方防詐原則': 'Official anti-fraud principles',
  'LINE 通知只提示狀態更新，不會包含個人認購、入金或分配金額。': 'LINE notices only indicate status changes and never include personal subscription, payment, or allocation amounts.',
  '官方不會透過陌生短網址要求輸入銀行密碼、簡訊驗證碼或遠端控制裝置。': 'We never use unfamiliar short links to request banking passwords, SMS codes, or remote device access.',
  '平台不會以保證獲利、穩賺不賠或限時匯款施壓。': 'The platform never pressures users with guaranteed returns, no-loss claims, or urgent transfer demands.',
  '如訊息與會員中心紀錄不一致，應停止操作並從官方入口聯絡引薦人。': 'If a message conflicts with the member portal, stop and contact your referrer through the official entry point.',
  'AI 生成內容': 'AI-generated content',
  'AI 報告用於資料整理、問題建構與情境分析，可能包含錯誤、遺漏或推論。平台將 AI 與專家報告分開標示，保存版本與資料基準日；涉及發布的 AI 內容仍須經專家審閱。': 'AI reports support data organization, question framing, and scenario analysis, and may contain errors, omissions, or inference. AI and expert reports are labeled separately with version and basis date; published AI content still requires expert review.',
  '草案版本：0.1｜最後更新：2026-08-18｜正式營運與持牌合作主體待確認': 'Draft v0.1 | Last updated: 2026-08-18 | Operating and licensed partner entities pending confirmation',

  '定義平台能做什麼、不能做什麼，以及會員使用資料室的責任。': 'Defines what the platform can and cannot do, and member responsibilities when using the data room.',
  '會員帳戶': 'Member account',
  '資料權限': 'Data access',
  '認購紀錄': 'Subscription records',
  '文件使用': 'Document use',
  '正式營運主體、持牌合作機構、準據法與爭議處理條款尚待確認。': 'The operating entity, licensed partner, governing law, and dispute terms remain to be confirmed.',
  '｜正式營運主體、持牌合作機構、準據法與爭議處理條款尚待確認。': ' | The operating entity, licensed partner, governing law, and dispute terms remain to be confirmed.',
  '會員帳戶與身分': 'Member account and identity',
  '使用 LINE 登入不代表會員已啟用。會員須提供正確的姓名、手機與社群來源，經引薦人人工確認後才成為正式會員。帳戶限本人使用，不得轉交、共用或冒用他人身分。': 'LINE Login does not mean membership is active. Members must provide an accurate name, phone, and community source and become verified only after manual referrer review. Accounts are personal and may not be transferred, shared, or used to impersonate another person.',
  '資格與資料權限': 'Qualification and data access',
  '一般會員只能查看公開或會員內容。合格投資人資格由合作機構於站外審核；資格通過後，平台仍依專案白名單逐案授權。平台得因資格到期、專案結束、安全事件或法規要求暫停存取。': 'General members may view public or member content only. A partner reviews qualified-investor status off-platform; even after approval, access is granted project by project. Access may be suspended due to expiry, project closure, security incidents, or regulatory requirements.',
  '認購意向不是交易': 'Subscription interest is not a transaction',
  '網站送出的金額只是認購意向，不構成契約、付款指示或保證分配。申請金額、合作方核准金額、實際入金、最終分配及退款金額是五個不同欄位，應以合作方與站外正式文件為準。若資料不一致，會員應先聯絡營運確認，不應重複送出。': 'An amount submitted on the site is only an expression of interest, not a contract, payment instruction, or guaranteed allocation. Requested, partner-approved, received, finally allocated, and refunded amounts are five separate fields; official partner and off-platform documents control. Contact operations if records differ rather than submitting again.',
  '受限文件': 'Restricted documents',
  'Pitch Deck 與報告只供指定會員於授權期間閱覽。下載連結可能有時效並記錄會員、專案、時間與結果；文件可加入會員編號與下載時間浮水印。未經同意不得轉傳、公開、重製或用於其他目的。': 'Pitch decks and reports are available only to specified members during an authorization period. Download links may expire and record member, project, time, and outcome; documents may be watermarked with member ID and download time. They may not be forwarded, published, reproduced, or reused without consent.',
  '禁止行為': 'Prohibited conduct',
  '繞過權限、測試他人帳戶或擷取其他會員資料。': 'Bypassing access controls, testing another account, or extracting another member’s data.',
  '移除浮水印、分享短效連結或大量下載受限內容。': 'Removing watermarks, sharing short-lived links, or bulk-downloading restricted content.',
  '使用自動工具干擾服務、偽造資料或冒用合作機構名義。': 'Using automation to disrupt service, falsify data, or impersonate a partner institution.',
  '將平台內容描述為保證獲利或經主管機關背書。': 'Describing platform content as guaranteed profit or regulator-endorsed.',
  '草案版本：0.1｜最後更新：2026-08-18': 'Draft v0.1 | Last updated: 2026-08-18',
}));

const CHINESE_TEXT = new Map([...ENGLISH_TEXT].map(([zh, en]) => [en, zh]));

const PAGE_META = {
  index: {
    'zh-Hant': ['致富投資｜讓資金，先看懂產業', '致富投資——串聯產業研究、專家審閱、會員服務與可追溯的投資流程。'],
    en: ['Zhifu Investment | Understand the industry first', 'Zhifu Investment connects industry research, expert review, member services, and traceable investment workflows.'],
  },
  activate: {
    'zh-Hant': ['啟用會員｜致富投資', '使用 LINE 登入、加入致富投資官方帳號，送出既有會員啟用申請。'],
    en: ['Member Activation | Zhifu Investment', 'Sign in with LINE, add the official account, and submit an existing-member activation request.'],
  },
  privacy: {
    'zh-Hant': ['隱私權政策草案｜致富投資', '致富投資隱私權政策草案。'],
    en: ['Draft Privacy Policy | Zhifu Investment', 'Draft privacy policy for Zhifu Investment.'],
  },
  risk: {
    'zh-Hant': ['投資風險與防詐聲明｜致富投資', '致富投資的投資風險與防詐聲明。'],
    en: ['Investment Risk & Anti-Fraud Notice | Zhifu Investment', 'Investment risk and anti-fraud notice for Zhifu Investment.'],
  },
  terms: {
    'zh-Hant': ['會員服務條款草案｜致富投資', '致富投資會員服務條款草案。'],
    en: ['Draft Member Service Terms | Zhifu Investment', 'Draft member service terms for Zhifu Investment.'],
  },
};

const originalText = new WeakMap();
const originalAttributes = new WeakMap();
let activeLocale = DEFAULT_LOCALE;
let observer;

export function normalizeLocale(value = '') {
  const locale = String(value).trim().replaceAll('_', '-').toLowerCase();
  if (!locale) return '';
  if (locale === 'en' || locale.startsWith('en-')) return 'en';
  if (locale === 'zh' || locale.startsWith('zh-')) return 'zh-Hant';
  return '';
}

export function resolveLocale({ search = '', stored = '', languages = [] } = {}) {
  const query = normalizeLocale(new URLSearchParams(String(search).replace(/^\?/, '')).get('lang'));
  if (query) return { locale: query, source: 'url' };
  const saved = normalizeLocale(stored);
  if (saved) return { locale: saved, source: 'saved' };
  for (const language of languages || []) {
    const browser = normalizeLocale(language);
    if (browser) return { locale: browser, source: 'browser' };
  }
  return { locale: DEFAULT_LOCALE, source: 'default' };
}

export function getLocale() {
  return activeLocale;
}

export function t(zhText) {
  return activeLocale === 'en' ? ENGLISH_TEXT.get(zhText) || zhText : zhText;
}

function pageName() {
  if (document.body?.classList.contains('landing-page')) return 'index';
  const name = window.location.pathname.split('/').filter(Boolean).at(-1) || 'index';
  return name.replace(/\.html$/, '');
}

function translateTextNode(node) {
  if (!originalText.has(node)) originalText.set(node, node.nodeValue);
  const original = originalText.get(node);
  const trimmed = original.trim();
  if (!trimmed) return;
  const translated = activeLocale === 'en' ? ENGLISH_TEXT.get(trimmed) : CHINESE_TEXT.get(trimmed);
  node.nodeValue = translated
    ? `${original.match(/^\s*/)?.[0] || ''}${translated}${original.match(/\s*$/)?.[0] || ''}`
    : original;
}

function translateAttributes(element) {
  const names = ['aria-label', 'placeholder', 'title'];
  let saved = originalAttributes.get(element);
  if (!saved) {
    saved = new Map();
    originalAttributes.set(element, saved);
  }
  names.forEach((name) => {
    if (!saved.has(name) && element.hasAttribute(name)) saved.set(name, element.getAttribute(name));
    if (!saved.has(name)) return;
    const original = saved.get(name);
    element.setAttribute(name, activeLocale === 'en' ? ENGLISH_TEXT.get(original) || original : CHINESE_TEXT.get(original) || original);
  });
}

function translateTree(root = document.body) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
    else translateAttributes(node);
    node = walker.nextNode();
  }
}

function updateMetadata() {
  const meta = PAGE_META[pageName()]?.[activeLocale];
  if (!meta) return;
  document.title = meta[0];
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = meta[1];
}

function languageQuery(locale) {
  return locale === 'en' ? 'en' : 'zh-TW';
}

function localizeLinks() {
  document.querySelectorAll('a[href]').forEach((link) => {
    const raw = link.getAttribute('href') || '';
    if (!raw || raw.startsWith('#') || raw.startsWith('/api/') || link.hasAttribute('download')) return;
    try {
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
      url.searchParams.set('lang', languageQuery(activeLocale));
      link.href = url.toString();
    } catch {
      // Keep an existing link intact if the browser cannot parse it.
    }
  });
}

function renderSwitcher() {
  let switcher = document.querySelector('[data-locale-switcher]');
  if (!switcher) {
    switcher = document.createElement('div');
    switcher.className = 'locale-switcher';
    switcher.dataset.localeSwitcher = '';
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', activeLocale === 'en' ? 'Language' : '語言');
    switcher.innerHTML = '<button type="button" data-locale="zh-Hant">中</button><span aria-hidden="true">/</span><button type="button" data-locale="en">EN</button>';
    const header = document.querySelector('.landing-header .header__inner');
    const menuToggle = header?.querySelector('[data-menu-toggle]');
    if (header) header.insertBefore(switcher, menuToggle || header.lastElementChild);
    else document.body.append(switcher);
  }
  switcher.setAttribute('aria-label', activeLocale === 'en' ? 'Language' : '語言');
  switcher.querySelectorAll('[data-locale]').forEach((button) => {
    const selected = button.dataset.locale === activeLocale;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', button.dataset.locale === 'en' ? 'English' : '繁體中文');
  });
}

function applyLocale() {
  document.documentElement.lang = activeLocale;
  document.documentElement.dataset.activeLocale = activeLocale;
  translateTree(document.body);
  updateMetadata();
  renderSwitcher();
  localizeLinks();
}

export function localeUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    if (url.origin === window.location.origin) url.searchParams.set('lang', languageQuery(activeLocale));
    return url.toString();
  } catch {
    return value;
  }
}

export function setLocale(locale, { historyMode = 'push', persist = true } = {}) {
  const next = normalizeLocale(locale) || DEFAULT_LOCALE;
  activeLocale = next;
  if (persist) {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage may be blocked. */ }
  }
  if (historyMode !== 'none') {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', languageQuery(next));
    window.history[historyMode === 'replace' ? 'replaceState' : 'pushState']({}, '', url);
  }
  applyLocale();
  document.dispatchEvent(new CustomEvent('zhifu:localechange', { detail: { locale: next } }));
}

export function initI18n() {
  let stored = '';
  try { stored = window.localStorage.getItem(STORAGE_KEY) || ''; } catch { /* Storage may be blocked. */ }
  const resolved = resolveLocale({ search: window.location.search, stored, languages: navigator.languages || [navigator.language] });
  activeLocale = resolved.locale;
  setLocale(activeLocale, { historyMode: resolved.source === 'url' ? 'none' : 'replace', persist: false });

  document.querySelector('[data-locale-switcher]')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-locale]');
    if (button) setLocale(button.dataset.locale);
  });

  window.addEventListener('popstate', () => {
    const query = normalizeLocale(new URLSearchParams(window.location.search).get('lang'));
    if (query) setLocale(query, { historyMode: 'none', persist: false });
  });

  if (!observer) {
    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => translateTree(node)));
      localizeLinks();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  return resolved;
}
