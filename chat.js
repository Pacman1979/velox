/* ===========================================================================
 * Studio Velox — site assistant
 * ---------------------------------------------------------------------------
 * A scripted assistant. There is no AI in this file and no model behind it.
 * Every sentence it can say is written below, by hand, in FACTS and TOPICS.
 * That is deliberate: it cannot invent a price, a turnaround or a promise,
 * because it has no way to generate a sentence that is not already here.
 *
 * The one thing it does that an FAQ cannot: it runs a real check on the
 * visitor's own website through /api/quickaudit and tells them what it found.
 *
 * ── To change what it says ─────────────────────────────────────────────────
 * Edit FACTS (prices, phone, timings) and TOPICS (the answers). Nothing else
 * in this file needs touching. If an answer is not in TOPICS, the assistant
 * says it does not know and hands the visitor to Phil. That is the design.
 *
 * ── To put it on another site ──────────────────────────────────────────────
 * Replace FACTS and TOPICS, change BRAND, drop the file in, add one line:
 *     <script src="/chat.js" defer></script>
 *
 * ── Going live ─────────────────────────────────────────────────────────────
 * CFG.publicLaunch is false, so right now the assistant only appears if the
 * address ends in ?chat=1. Set it to true when the prices below match
 * pricing.html. Until they match, a visitor who reads both will not believe
 * either, so this stays off.
 * ======================================================================== */

(function () {
  'use strict';

  /* ========================================================================
   * 1. CONFIGURATION
   * ===================================================================== */

  var CFG = {
    publicLaunch: false,        // false = only shows with ?chat=1 in the address
    auditEndpoint: '/api/quickaudit',
    leadEndpoint: '/api/chatlead',
    logEndpoint: '/api/chatlog',
    // Which assistant this is, for the monthly "what your customers asked"
    // report. On a client's site, set this to their name.
    site: 'studiovelox.com',
    maxAudits: 3,               // per visit — stops the endpoint being hammered
    maxTurns: 60,               // then it suggests a phone call instead
    teaserAfterMs: 14000,       // one nudge, once, then never again
    typingMs: 420,              // pause before a reply, so it reads as a reply
    beatMs: 540                 // pause between parts of the audit result
  };

  /* ========================================================================
   * 2. THE FACTS — the only numbers the assistant knows
   * ===================================================================== */

  var FACTS = {
    owner: 'Phil',
    phone: '0422 777 865',
    phoneHref: 'tel:+61422777865',
    email: 'phil@studiovelox.com',
    conceptHours: 24,
    liveDays: 7,
    hourly: 80,
    area: 'Gold Coast',
    // Paid to the registrar, not to Studio Velox. Checked Oct 2026.
    domainLow: 20,
    domainHigh: 40,
    // Payable only if the free one-page build is cancelled inside 3 months.
    freeBuildFee: 294,
    freeBuildMonths: 3,

    tiers: [
      {
        id: 'one',
        name: 'One-page site',
        build: 0,
        monthly: 47,
        annual: 470,
        trialDays: 14,
        changes: 1,
        what: 'One scrolling page with everything on it — who you are, what you do, and how to book you. The build costs nothing.',
        who: 'Right for sole traders and anyone just getting started.'
      },
      {
        id: 'five',
        name: 'Five-page website',
        build: 497,
        monthly: 97,
        annual: 970,
        trialDays: 7,
        changes: 3,
        what: 'Five pages, plus email on your own name — adam@yourbusiness.com.au — through the inbox you already use.',
        who: "Right when one page can't carry the whole story."
      },
      {
        id: 'assistant',
        name: 'Five pages + assistant',
        build: 997,
        monthly: 147,
        annual: 1470,
        trialDays: 7,
        changes: 3,
        what: 'The five-page site, plus an assistant like this one built on your business — and a monthly list of what your customers actually asked it.',
        who: 'Right if you lose work to questions nobody ever got to ask you.'
      }
    ],

    // Said verbatim whenever money is mentioned.
    terms: 'You see the finished site before you pay for it. Where there is a build fee it is due within 7 days of completion, and the monthly starts when your free trial ends.'
  };

  /* ========================================================================
   * 3. THE ANSWERS
   *
   * Each topic:  chip   — the button label
   *              match  — words that route free typing here
   *              say    — what it replies (array = separate bubbles)
   *              next   — the buttons offered afterwards
   * ===================================================================== */

  function money(n) { return '$' + String(n).replace(/\B(?=(\d{3})+$)/g, ','); }

  function tierLines() {
    return FACTS.tiers.map(function (t) {
      return '<b>' + t.name + '</b> — '
        + (t.build ? money(t.build) + ' to build' : 'free to build')
        + ', then ' + money(t.monthly) + ' a month.'
        + '<br><span class="sv-sub">' + t.what + '</span>';
    }).join('<hr class="sv-hr">');
  }

  /** Annual is always ten months for twelve, so the saving is two months. */
  function annualLines() {
    return FACTS.tiers.map(function (t) {
      return '<b>' + t.name + '</b> — ' + money(t.annual) + ' a year'
        + ' <span class="sv-sub">(saves ' + money(t.monthly * 2) + ')</span>';
    }).join('<br>');
  }

  var TOPICS = {

    price: {
      chip: 'What does it cost?',
      match: ['price', 'pricing', 'cost', 'how much', 'expensive', 'cheap', 'quote', 'budget', 'afford', 'rate', 'fee', 'charge', '$'],
      say: [
        'Three options, and the number is the number — no discovery call before you are allowed to hear it.',
        tierLines,
        FACTS.terms,
        'Every option includes changes to make it yours before it goes live — '
          + FACTS.tiers[0].changes + ' round on the one-page site, '
          + FACTS.tiers[1].changes + ' on the other two. '
          + 'Want something outside those three? ' + FACTS.owner
          + ' will quote it — nothing is off the table.'
      ],
      next: ['monthly', 'trial', 'howlong', 'audit']
    },

    monthly: {
      chip: 'What is the monthly for?',
      match: ['monthly', 'month', 'ongoing', 'subscription', 'recurring', 'what am i paying', 'per month'],
      say: [
        'It is what stops a website quietly going stale, breaking, or sending enquiries nowhere. Each tier includes everything in the one before it.',
        '<b>' + money(FACTS.tiers[0].monthly) + ' — looked after</b><br>'
          + '· Hosting, your domain connection and the security certificate<br>'
          + '· Small changes — prices, hours, photos, wording<br>'
          + '· Anything that breaks, fixed<br>'
          + '· Daily backups and uptime monitoring<br>'
          + '· Security and software updates<br>'
          + '· Changes live within three working days',
        '<b>' + money(FACTS.tiers[1].monthly) + ' — all of that, plus</b><br>'
          + '· Email on your own name, through the inbox you already use<br>'
          + '· A health check on your site every month, emailed to you<br>'
          + '· Who visited and where they came from, in plain English<br>'
          + '· Changes live the same day<br>'
          + '· Your Google listing kept current',
        '<b>' + money(FACTS.tiers[2].monthly) + ' — all of that, plus</b><br>'
          + '· Your assistant, answering customers at eleven at night<br>'
          + '· <b>What your customers actually asked</b> — sent to you monthly<br>'
          + '· One new page a year<br>'
          + '· A seasonal refresh twice a year',
        'A small change is anything ' + FACTS.owner + ' can do in well under an hour. Anything bigger, he tells you the cost before doing it — never after.'
      ],
      next: ['trial', 'bigger', 'cancel', 'price']
    },

    trial: {
      chip: 'Is there a free trial?',
      match: ['trial', 'free trial', 'try it', 'try before', 'risk', 'guarantee',
        'money back', 'refund', 'what if i hate it', "don't like it", 'commit'],
      say: [
        'Yes, and it starts when the site is finished rather than when you enquire — so what you are deciding about is a real website with your business on it, not a promise.',
        '<b>One-page site</b> — ' + FACTS.tiers[0].trialDays + ' days<br>'
          + '<b>Five-page website</b> — ' + FACTS.tiers[1].trialDays + ' days<br>'
          + '<b>Five pages + assistant</b> — ' + FACTS.tiers[2].trialDays + ' days',
        'Nothing is charged until it ends, and you get a reminder first. Cancel in the trial and you owe nothing at all, build fee included. During the trial the site sits on a Studio Velox address and moves to your own domain once the first payment clears.'
      ],
      next: ['price', 'cancel', 'concept']
    },

    annual: {
      chip: 'Can I pay yearly?',
      match: ['annual', 'annually', 'yearly', 'year', 'upfront', 'pay in advance',
        'discount for paying', 'cheaper if'],
      say: [
        'Yes, on all three — twelve months for the price of ten.',
        annualLines,
        'The build fee, where there is one, is the same either way. Annual plans are not refundable, but if you cancel you keep the site.'
      ],
      next: ['price', 'trial', 'own']
    },

    howlong: {
      chip: 'How long does it take?',
      match: ['how long', 'when', 'timeline', 'turnaround', 'fast', 'quick', 'soon', 'deadline', 'time frame', 'timeframe', 'days', 'weeks', 'rush', 'urgent'],
      say: [
        'A concept within ' + FACTS.conceptHours + ' hours, and live within ' + FACTS.liveDays + ' days.',
        'The concept comes first and costs you nothing. You see your actual business on an actual page before you decide anything — not a template with your logo dropped on it.'
      ],
      next: ['audit', 'price', 'talk']
    },

    own: {
      chip: 'Do I own it?',
      match: ['own', 'ownership', 'mine', 'belongs', 'hostage', 'locked in', 'lock in', 'keep the site', 'my property'],
      say: [
        'You do. The domain is registered in your name and the website is yours.',
        'If you ever leave, you take it with you. I am not interested in holding anyone\'s business hostage to a monthly fee.'
      ],
      next: ['cancel', 'domain', 'price']
    },

    cancel: {
      chip: 'Can I cancel?',
      match: ['cancel', 'contract', 'lock', 'commit', 'minimum term', 'get out', 'leave', 'quit', 'stop paying', 'notice period'],
      say: [
        'Yes, and there is no minimum term. Tell ' + FACTS.owner + ' and it stops.',
        'One fair condition on the free one-page build: cancel inside the first '
          + FACTS.freeBuildMonths + ' months and a ' + money(FACTS.freeBuildFee)
          + ' build fee becomes payable, which covers the work already done. '
          + 'After that there is nothing to pay, and you keep the site either way.'
      ],
      next: ['trial', 'own', 'talk']
    },

    changes: {
      chip: 'What if I want it changed?',
      match: ['change', 'revision', 'edit', 'update', 'amend', 'tweak', 'adjust', 'redo',
        'how many changes', 'rounds', "don't like", 'dont like', 'happy with'],
      say: [
        'Before it goes live you get rounds of changes to make it suit you — '
          + FACTS.tiers[0].changes + ' on the one-page site, '
          + FACTS.tiers[1].changes + ' on the other two.',
        'After it is live, small changes are part of the monthly. You message me, I change it, usually the same day. No ticket system and no portal to learn.'
      ],
      next: ['monthly', 'bigger', 'price']
    },

    domain: {
      chip: 'Do I need a domain?',
      match: ['domain', 'url', 'web address', 'name', '.com', '.com.au', 'godaddy', 'register'],
      say: [
        'No. It works either way.',
        'If you already own one, I connect it. If you do not, I can set the site up without one and we add it later, or I can walk you through registering one — that is paid to the registrar, not to me, and it is usually '
          + money(FACTS.domainLow) + ' to ' + money(FACTS.domainHigh) + ' a year.'
      ],
      next: ['own', 'price', 'talk']
    },

    bigger: {
      chip: 'Something bigger than a website',
      match: ['shop', 'ecommerce', 'e-commerce', 'store', 'sell online', 'booking', 'ads', 'advertising', 'seo', 'logo', 'app', 'members', 'login', 'payment', 'integration', 'custom'],
      say: [
        'An online shop, a booking system, extra pages, ad campaigns, a logo — all possible, and nothing is off the table. None of it is covered by the three prices above.',
        'It is charged at ' + money(FACTS.hourly) + ' an hour, or as a fixed price quoted before any work starts so you know the number up front.',
        'I will not guess at a figure for something like that. Tell ' + FACTS.owner + ' what you are after and he will give you a real one.'
      ],
      next: ['talk', 'price']
    },

    who: {
      chip: 'Who am I dealing with?',
      match: ['who are you', 'who is', 'about you', 'phil', 'experience', 'portfolio', 'examples', 'previous', 'clients', 'reviews', 'team', 'agency', 'qualified', 'trust', 'just you'],
      say: [
        FACTS.owner + ' Campbell. One person on the ' + FACTS.area + ', not an agency and not a reseller — the person who builds your site is the person who answers the phone.',
        'There is work to look at on the <a href="/portfolio.html">portfolio page</a> — real businesses, built and live.'
      ],
      next: ['price', 'audit', 'talk']
    },

    nosite: {
      chip: "I haven't got a website yet",
      match: ['no website', 'no site', 'not got a website', "haven't got a website",
        'havent got a website', "haven't got one", 'havent got one', "don't have a website",
        'dont have a website', "don't have a site", 'dont have a site', 'never had a website',
        'starting out', 'new business', 'just started', 'from scratch', 'brand new',
        'only instagram', 'only facebook', 'just facebook', 'just instagram', 'only a facebook page'],
      say: [
        'That is the easy version, honestly. Nothing to undo and nobody to argue with about why the old one has to go.',
        'The one-page site is where most people in that spot start, and the build costs nothing — '
          + money(FACTS.tiers[0].monthly) + ' a month after that, with the first '
          + FACTS.tiers[0].trialDays + ' days free. Concept in ' + FACTS.conceptHours
          + ' hours, live in ' + FACTS.liveDays + ' days.'
      ],
      next: ['trial', 'price', 'concept']
    },

    talk: {
      chip: 'Talk to ' + FACTS.owner,
      match: ['talk', 'call', 'phone', 'ring', 'speak', 'contact', 'email', 'human', 'person', 'real person', 'number'],
      say: [
        '<b><a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a></b><br>'
          + '<a href="mailto:' + FACTS.email + '">' + FACTS.email + '</a>',
        'Or leave your number here and he will call you — usually same day.'
      ],
      next: ['leave', 'price']
    }
  };

  /* Routing phrases that are not topics — handled as flows. */
  var FLOW_MATCH = {
    audit: ['check my site', 'audit', 'review my site', 'look at my site', 'whats wrong', "what's wrong", 'my website is', 'my site is', 'check it'],
    concept: ['concept', 'mock', 'mockup', 'design one', 'show me', 'free', 'see what', 'example of mine'],
    leave: ['my number is', 'call me', 'here is my number', 'leave my details', 'contact me']
  };

  /* What it says when it does not know. This is a feature. */
  var DONT_KNOW = [
    "I don't want to guess at that one — a wrong answer from me becomes a promise "
      + FACTS.owner + ' has to keep.',
    'He will know straight away. <b><a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a></b>, or leave your number below and he will call you.'
  ];

  /* ========================================================================
   * 4. STYLES
   * ===================================================================== */

  var CSS = [
    '.sv-chat,.sv-chat *{box-sizing:border-box;margin:0;padding:0}',
    '.sv-chat{position:fixed;right:20px;bottom:20px;z-index:2147483000;',
    "font-family:'Lato',system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6}",

    /* launcher */
    '.sv-launch{display:flex;align-items:center;gap:10px;background:#e8a020;color:#0a1628;',
    'border:0;border-radius:4px;padding:13px 20px;cursor:pointer;',
    "font-family:'Oswald',system-ui,sans-serif;font-size:13px;font-weight:500;letter-spacing:.1em;",
    'font-weight:600;text-transform:uppercase;box-shadow:0 6px 26px rgba(0,0,0,.34);',
    'transition:transform .18s,box-shadow .18s,background .18s}',
    '.sv-launch:hover{background:#f5b732;transform:translateY(-2px);box-shadow:0 10px 32px rgba(0,0,0,.42)}',
    '.sv-dot{width:7px;height:7px;border-radius:50%;background:#0a1628;flex:none;animation:sv-pulse 2.4s infinite}',
    '@keyframes sv-pulse{0%,100%{opacity:1}50%{opacity:.25}}',

    /* teaser */
    '.sv-teaser{position:absolute;right:0;bottom:62px;width:252px;background:#fff;color:#0a1628;',
    'border-left:3px solid #e8a020;border-radius:4px;padding:14px 34px 14px 16px;font-size:14px;line-height:1.5;',
    'box-shadow:0 8px 30px rgba(10,22,40,.2);cursor:pointer;text-align:left}',
    '.sv-teaser-x{position:absolute;top:5px;right:7px;border:0;background:0;color:#9aa5b4;',
    'font-size:17px;line-height:1;cursor:pointer;padding:4px}',
    '.sv-teaser-x:hover{color:#0a1628}',

    /* panel */
    '.sv-panel{display:none;flex-direction:column;width:382px;max-width:calc(100vw - 32px);',
    'height:548px;max-height:calc(100vh - 40px);background:#f8f6f1;border-radius:6px;overflow:hidden;',
    'box-shadow:0 20px 64px rgba(10,22,40,.38)}',
    '.sv-chat.sv-open .sv-panel{display:flex}',
    '.sv-chat.sv-open .sv-launch,.sv-chat.sv-open .sv-teaser{display:none}',

    '.sv-head{background:#0a1628;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;flex:none}',
    ".sv-head b{font-family:'Oswald',system-ui,sans-serif;font-size:15px;font-weight:500;",
    'letter-spacing:.08em;text-transform:uppercase;color:#fff}',
    '.sv-head b i{color:#e8a020;font-style:normal}',
    '.sv-head small{display:block;font-size:11.5px;letter-spacing:.04em;color:#7d8ca3;',
    "text-transform:none;font-family:'Lato',sans-serif;margin-top:3px}",
    '.sv-x{border:0;background:0;color:#7d8ca3;font-size:22px;line-height:1;cursor:pointer;padding:4px 2px}',
    '.sv-x:hover{color:#e8a020}',

    '.sv-log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:18px 16px 6px;',
    'display:flex;flex-direction:column;gap:11px}',

    '.sv-msg{max-width:88%;padding:11px 14px;border-radius:4px;animation:sv-in .3s ease both}',
    '@keyframes sv-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}',
    '.sv-bot{align-self:flex-start;background:#fff;border-left:2px solid #e8a020;color:#0a1628;',
    'box-shadow:0 1px 3px rgba(10,22,40,.07)}',
    '.sv-me{align-self:flex-end;background:#0a1628;color:#fff;border-radius:4px}',
    '.sv-msg a{color:inherit;text-decoration:underline;text-underline-offset:2px}',
    '.sv-bot a{color:#9a6a00}',
    '.sv-sub{color:#667;font-size:13.5px}',
    '.sv-hr{border:0;border-top:1px solid #e6e2d8;margin:9px 0}',
    '.sv-msg b{font-weight:700}',

    /* audit result */
    '.sv-find{margin-top:9px;padding-top:9px;border-top:1px solid #e6e2d8}',
    '.sv-find:first-child{margin:0;padding:0;border:0}',
    '.sv-find b{display:block;font-size:14.5px}',
    '.sv-find span{display:block;color:#667;font-size:13.5px;margin-top:2px}',

    /* typing */
    '.sv-typing{align-self:flex-start;display:flex;gap:4px;padding:13px 14px;background:#fff;',
    'border-left:2px solid #e8a020;border-radius:4px}',
    '.sv-typing i{width:6px;height:6px;border-radius:50%;background:#b9c2cf;animation:sv-bob 1.3s infinite}',
    '.sv-typing i:nth-child(2){animation-delay:.18s}.sv-typing i:nth-child(3){animation-delay:.36s}',
    '@keyframes sv-bob{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-4px);opacity:1}}',

    /* chips */
    '.sv-chips{display:flex;flex-wrap:wrap;gap:7px;padding:4px 16px 12px}',
    '.sv-chip{border:1px solid #d6c9ab;background:#fff;color:#0a1628;border-radius:3px;',
    'padding:8px 13px;font-size:13.5px;font-family:inherit;cursor:pointer;line-height:1.35;text-align:left;',
    'transition:border-color .15s,background .15s}',
    '.sv-chip:hover{border-color:#e8a020;background:#fffdf7}',
    '.sv-chip-go{background:#e8a020;border-color:#e8a020;color:#0a1628;font-weight:700}',
    '.sv-chip-go:hover{background:#f5b732;border-color:#f5b732}',

    /* composer */
    '.sv-foot{flex:none;border-top:1px solid #e6e2d8;background:#fff;padding:10px 12px;display:flex;gap:8px}',
    '.sv-in{flex:1;border:1px solid #dfd9cc;border-radius:3px;padding:10px 12px;font:inherit;',
    'font-size:14.5px;color:#0a1628;background:#fff;min-width:0}',
    '.sv-in:focus{outline:2px solid #e8a020;outline-offset:-1px;border-color:#e8a020}',
    '.sv-send{border:0;background:#0a1628;color:#fff;border-radius:3px;padding:0 15px;cursor:pointer;',
    "font-family:'Oswald',system-ui,sans-serif;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase}",
    '.sv-send:hover{background:#122040}',
    '.sv-send:disabled{opacity:.4;cursor:default}',
    '.sv-note{flex:none;text-align:center;font-size:11px;color:#8a93a3;padding:0 12px 9px;background:#fff}',

    ':where(.sv-chat) :focus-visible{outline:2px solid #e8a020;outline-offset:2px}',

    '@media (max-width:440px){',
    '.sv-chat{right:12px;bottom:12px;left:12px}',
    '.sv-panel{width:100%;height:min(76vh,560px)}',
    '.sv-launch{margin-left:auto}',
    '.sv-teaser{width:auto;left:0}}',

    '@media (prefers-reduced-motion:reduce){',
    '.sv-chat *,.sv-chat *::before{animation:none!important;transition:none!important}}'
  ].join('');

  /* ========================================================================
   * 5. STATE
   * ===================================================================== */

  var S = {
    open: false,
    anchorNext: false,
    turns: 0,
    audits: 0,
    awaiting: null,     // 'url' | 'name' | 'contact' | null
    lead: { name: '', contact: '', url: '', interest: '' },
    transcript: [],
    sent: false,
    booted: false
  };

  var el = {};

  /* ========================================================================
   * 6. HELPERS
   * ===================================================================== */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function store(k, v) {
    try {
      if (v === undefined) return window.sessionStorage.getItem(k);
      window.sessionStorage.setItem(k, v);
    } catch (e) { /* private mode — the widget still works, it just nags once more */ }
    return null;
  }

  function scroll() {
    if (el.log) el.log.scrollTop = el.log.scrollHeight;
  }

  function node(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  /* ========================================================================
   * 7. RENDERING
   * ===================================================================== */

  function mine(text) {
    S.transcript.push('> ' + text);
    el.log.appendChild(node('div', 'sv-msg sv-me', esc(text)));
    scroll();   // their own message belongs at the bottom, where they expect it
  }

  function says(html) {
    S.transcript.push(String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    var bubble = node('div', 'sv-msg sv-bot', html);

    // Anything that navigates away opens in a new tab, so the conversation is
    // still here when they come back. tel: and mailto: are left alone — a new
    // tab for those just leaves an empty window behind.
    bubble.querySelectorAll('a[href]').forEach(function (a) {
      if (/^(tel:|mailto:)/i.test(a.getAttribute('href') || '')) return;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });

    el.log.appendChild(bubble);

    // The first bubble of an answer goes to the TOP of the view, so a long
    // answer is read from its beginning. Scrolling to the bottom and making
    // someone scroll back up to start reading is the thing to avoid.
    if (S.anchorNext) {
      S.anchorNext = false;
      bubble.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    return bubble;
  }

  function typing(on) {
    var t = el.log.querySelector('.sv-typing');
    if (on) {
      if (!t) { el.log.appendChild(node('div', 'sv-typing', '<i></i><i></i><i></i>')); scroll(); }
    } else if (t) { t.remove(); }
  }

  /** Say a list of things one after another, with a human pause between. */
  function saga(lines, done) {
    var i = 0;
    // The next bubble starts an answer, so anchor it at the top of the view.
    S.anchorNext = true;
    (function step() {
      if (i >= lines.length) { if (done) done(); return; }
      var line = lines[i++];
      typing(true);
      window.setTimeout(function () {
        typing(false);
        says(typeof line === 'function' ? line() : line);
        step();
      }, i === 1 ? CFG.typingMs : CFG.typingMs + 180);
    })();
  }

  function chips(list) {
    el.chips.innerHTML = '';
    list.forEach(function (c) {
      var b = node('button', 'sv-chip' + (c.go ? ' sv-chip-go' : ''), esc(c.label));
      b.type = 'button';
      b.addEventListener('click', function () {
        mine(c.label);
        el.chips.innerHTML = '';
        c.run();
      });
      el.chips.appendChild(b);
    });
    scroll();
  }

  /** Turn a list of topic/flow ids into chips. */
  function offer(ids) {
    chips(ids.map(function (id) {
      if (id === 'audit') return { label: 'Check my site', go: true, run: startAudit };
      if (id === 'concept') return { label: 'I want a free concept', go: true, run: startConcept };
      if (id === 'leave') return { label: 'Leave my number', go: true, run: startConcept };
      return { label: TOPICS[id].chip, run: function () { answer(id); } };
    }));
  }

  var HOME = ['audit', 'price', 'trial', 'who'];

  function answer(id) {
    var t = TOPICS[id];
    if (!t) return;
    if (!S.lead.interest) S.lead.interest = t.chip;
    saga(t.say, function () { offer(t.next); });
  }

  /* ========================================================================
   * 8. THE AUDIT — the part an FAQ cannot do
   * ===================================================================== */

  function startAudit() {
    if (S.audits >= CFG.maxAudits) {
      saga(["That's three checks this visit, which is my limit — it costs real money to run. "
        + 'If you want more, ' + FACTS.owner + ' will do them with you on '
        + '<a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a>.'],
        function () { offer(['price', 'talk']); });
      return;
    }
    saga(["What's the web address? Just the domain is fine — <span class=\"sv-sub\">yourbusiness.com.au</span>"],
      function () {
        S.awaiting = 'url';
        el.in.placeholder = 'yourbusiness.com.au';
        el.in.focus();
        chips([{ label: "I haven't got one", run: function () { S.awaiting = null; answer('nosite'); } }]);
      });
  }

  function runAudit(url) {
    S.audits++;
    S.lead.url = url;
    typing(true);

    window.fetch(CFG.auditEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        typing(false);
        if (!d || d.ok !== true) {
          says(esc((d && d.headline) || "I couldn't reach that address.")
            + '<br><span class="sv-sub">'
            + esc((d && d.detail) || 'Worth checking the spelling — or it may be down, which is its own problem.')
            + '</span>');
          offer(['price', 'talk']);
          return;
        }
        showAudit(d);
      })
      .catch(function () {
        typing(false);
        says('Something went wrong at my end running that check — not your site\'s fault.'
          + '<br><span class="sv-sub">' + FACTS.owner + ' can run it manually: '
          + '<a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a></span>');
        offer(['price', 'talk']);
      });
  }

  function showAudit(d) {
    var bad = d.findings || [];
    var watch = d.worth_a_look || [];
    var picked = bad.concat(watch).slice(0, 4);

    says('<b>' + esc(d.headline) + '</b><br><span class="sv-sub">' + esc(d.detail) + '</span>');

    if (picked.length) {
      window.setTimeout(function () {
        says(picked.map(function (f) {
          return '<div class="sv-find"><b>' + esc(f.title) + '</b>'
            + (f.detail ? '<span>' + esc(f.detail) + '</span>' : '') + '</div>';
        }).join(''));

        var good = (d.counts && d.counts.good) || 0;
        window.setTimeout(function () {
          saga([(good ? good + ' other things on it are already right. ' : '')
            + 'Want to see what it could look like instead? '
            + FACTS.owner + ' builds the concept first and you decide after — '
            + 'no charge and no obligation.'],
            function () {
              chips([
                { label: 'Yes — show me', go: true, run: startConcept },
                { label: 'What would it cost?', run: function () { answer('price'); } },
                { label: 'Not right now', run: function () { closingOff(); } }
              ]);
            });
        }, CFG.beatMs - 20);
      }, CFG.beatMs);
    } else {
      saga(['Nothing for me to pick on. If it still is not bringing you work, '
        + 'the problem is what the page says rather than how it is built — and that is '
        + 'worth a conversation.'],
        function () { offer(['price', 'talk']); });
    }
  }

  /* ========================================================================
   * 9. LEAD CAPTURE
   * ===================================================================== */

  function startConcept() {
    if (S.sent) {
      saga(['Already got your details — ' + FACTS.owner + ' will be in touch.'], function () { offer(['price', 'who']); });
      return;
    }
    saga(["Good. Two things and I'll pass it over.", "What's your name?"], function () {
      S.awaiting = 'name';
      el.in.placeholder = 'Your name';
      el.in.focus();
    });
  }

  function askContact() {
    saga(['Thanks ' + esc(S.lead.name.split(' ')[0]) + '. Best number or email for you?'],
      function () {
        S.awaiting = 'contact';
        el.in.placeholder = 'Mobile or email';
        el.in.focus();
      });
  }

  function sendLead() {
    S.awaiting = null;
    el.in.placeholder = 'Type your question…';
    typing(true);

    window.fetch(CFG.leadEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: S.lead.name,
        contact: S.lead.contact,
        url: S.lead.url,
        interest: S.lead.interest,
        page: window.location.pathname,
        transcript: S.transcript.slice(-40).join('\n')
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        typing(false);
        S.sent = !!(d && d.ok);
        if (S.sent) {
          says('Got it. ' + FACTS.owner + ' will be in touch — usually the same day, '
            + 'and you will have something to look at within ' + FACTS.conceptHours + ' hours.');
        } else {
          says('My end did not save that, and I would rather tell you than pretend.'
            + '<br><span class="sv-sub">Ring ' + FACTS.owner + ' directly: '
            + '<a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a></span>');
        }
        offer(['price', 'howlong', 'who']);
      })
      .catch(function () {
        typing(false);
        says('That did not go through, and I would rather tell you than pretend.'
          + '<br><span class="sv-sub">Ring ' + FACTS.owner + ' directly: '
          + '<a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a></span>');
        offer(['price', 'talk']);
      });
  }

  function closingOff() {
    saga(['Fair enough. The number is <a href="' + FACTS.phoneHref + '">' + FACTS.phone
      + '</a> whenever you want it.'], function () { offer(['price', 'who']); });
  }

  /* ========================================================================
   * 10. FREE TEXT
   * ===================================================================== */

  /**
   * Record a question, and whether we knew the answer.
   *
   * Only ever called with something the visitor typed as a QUESTION. Names,
   * phone numbers and email addresses are handled in startConcept/askContact
   * and never reach this function — see the guard in submit().
   *
   * Fire and forget: a failed log must never interrupt the conversation.
   */
  function logQuestion(text, topicId) {
    try {
      window.fetch(CFG.logEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          site: CFG.site,
          question: String(text).slice(0, 300),
          topic: topicId || null,
          answered: Boolean(topicId),
          page: window.location.pathname
        })
      }).catch(function () {});
    } catch (e) { /* older browser, no logging, no harm */ }
  }

  function looksLikeUrl(s) {
    return /^(https?:\/\/)?([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(\/|$)/i.test(s.trim());
  }

  /** Score every topic against what they typed and take the best, if any. */
  function route(text) {
    var t = ' ' + text.toLowerCase().replace(/[^a-z0-9$'\s.-]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var best = null, bestScore = 0;

    function consider(id, words) {
      var score = 0;
      words.forEach(function (w) {
        if (t.indexOf(w.toLowerCase()) !== -1) score += w.length;
      });
      if (score > bestScore) { bestScore = score; best = id; }
    }

    Object.keys(FLOW_MATCH).forEach(function (id) { consider(id, FLOW_MATCH[id]); });
    Object.keys(TOPICS).forEach(function (id) { consider(id, TOPICS[id].match); });

    return bestScore >= 3 ? best : null;
  }

  function submit() {
    var text = el.in.value.trim();
    if (!text) return;
    el.in.value = '';
    mine(text);
    el.chips.innerHTML = '';

    S.turns++;
    if (S.turns > CFG.maxTurns) {
      saga(['We have gone a long way round. This is the point where a two-minute '
        + 'call beats me: <a href="' + FACTS.phoneHref + '">' + FACTS.phone + '</a>.'], function () {});
      return;
    }

    /* Mid-flow answers come first. */
    if (S.awaiting === 'url') {
      S.awaiting = null;
      el.in.placeholder = 'Type your question…';
      if (!looksLikeUrl(text)) {
        saga(["That doesn't look like a web address to me. Try it as <span class=\"sv-sub\">yourbusiness.com.au</span>"],
          function () { offer(['audit', 'nosite', 'price']); });
        return;
      }
      runAudit(text);
      return;
    }
    if (S.awaiting === 'name') {
      S.awaiting = null;
      S.lead.name = text.slice(0, 80);
      askContact();
      return;
    }
    if (S.awaiting === 'contact') {
      S.lead.contact = text.slice(0, 120);
      sendLead();
      return;
    }

    /* Someone pasting a URL unprompted means one thing. */
    if (looksLikeUrl(text)) {
      if (S.audits >= CFG.maxAudits) { startAudit(); return; }
      saga(['Let me take a look at that.'], function () { runAudit(text); });
      return;
    }

    // Everything above this line was a name, a number or a web address, and
    // is never logged. From here down it is a question, so it is.
    var id = route(text);
    logQuestion(text, id);

    if (id === 'audit') { startAudit(); return; }
    if (id === 'concept' || id === 'leave') { startConcept(); return; }
    if (id) { answer(id); return; }

    saga(DONT_KNOW, function () { offer(['leave', 'price', 'audit']); });
  }

  /* ========================================================================
   * 11. BUILD AND BOOT
   * ===================================================================== */

  function build() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var root = node('div', 'sv-chat');
    root.innerHTML =
      '<div class="sv-panel" role="dialog" aria-modal="false" aria-label="Studio Velox assistant">'
      + '<div class="sv-head">'
      + '<b>STUDIO VELOX<i>.</i><small>Answers in plain English</small></b>'
      + '<button class="sv-x" type="button" aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="sv-log" role="log" aria-live="polite"></div>'
      + '<div class="sv-chips"></div>'
      + '<div class="sv-foot">'
      + '<input class="sv-in" type="text" placeholder="Type your question…" aria-label="Type your question" '
      + 'autocomplete="off" maxlength="300">'
      + '<button class="sv-send" type="button">Send</button>'
      + '</div>'
      + '<div class="sv-note">No AI guesswork — if it is not something I know, I will say so.</div>'
      + '</div>'
      + '<button class="sv-launch" type="button"><span class="sv-dot"></span>Free site check</button>';

    document.body.appendChild(root);

    el.root = root;
    el.log = root.querySelector('.sv-log');
    el.chips = root.querySelector('.sv-chips');
    el.in = root.querySelector('.sv-in');
    el.launch = root.querySelector('.sv-launch');

    el.launch.addEventListener('click', open);
    root.querySelector('.sv-x').addEventListener('click', close);
    root.querySelector('.sv-send').addEventListener('click', submit);
    el.in.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.open) close();
    });

    teaseOnce();
  }

  function teaseOnce() {
    if (store('sv-teased')) return;
    window.setTimeout(function () {
      if (S.open || !el.root || el.root.querySelector('.sv-teaser')) return;
      var t = node('div', 'sv-teaser',
        'Want to know what your current site is costing you? '
        + 'I will check it in about ten seconds.'
        + '<button class="sv-teaser-x" type="button" aria-label="Dismiss">&times;</button>');
      t.addEventListener('click', function (e) {
        if (e.target.classList.contains('sv-teaser-x')) { t.remove(); store('sv-teased', '1'); return; }
        t.remove(); store('sv-teased', '1'); open();
      });
      el.root.appendChild(t);
    }, CFG.teaserAfterMs);
  }

  function open() {
    S.open = true;
    store('sv-teased', '1');
    var t = el.root.querySelector('.sv-teaser');
    if (t) t.remove();
    el.root.classList.add('sv-open');

    if (!S.booted) {
      S.booted = true;
      saga([
        "Hello. I'm the Studio Velox assistant — I can only tell you things "
          + FACTS.owner + ' has actually written down, which is the point of me.',
        'The useful thing I do: give me your web address and I will run a real check on it '
          + 'and tell you what is costing you customers.'
      ], function () { offer(HOME); });
    }
    window.setTimeout(function () { el.in.focus(); }, 120);
  }

  function close() {
    S.open = false;
    el.root.classList.remove('sv-open');
    el.launch.focus();
  }

  function visible() {
    if (CFG.publicLaunch) return true;
    try { return new URLSearchParams(window.location.search).get('chat') === '1'; }
    catch (e) { return false; }
  }

  if (visible()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', build);
    } else {
      build();
    }
  }
})();
