// Audit sections — scorecard, cohesion, per-surface deep dives, roadmap

function Scorecard() {
  const rows = [
    ['Brand cohesion', 'D', 'd', 'Two themes, no shared system'],
    ['Typography', 'C−', 'c', 'One font, no scale, weak hierarchy'],
    ['Color usage', 'C', 'c', 'Orange is overused as both primary and decoration'],
    ['CTA hierarchy', 'D+', 'd', 'Every button is the same orange pill'],
    ['Spacing & rhythm', 'C', 'c', 'Inconsistent padding, no grid'],
    ['Field usability', 'D', 'd', 'Small targets, dense controls'],
    ['Accessibility', 'D', 'd', 'Contrast, focus, target size issues'],
    ['Motion / feedback', 'C−', 'c', 'Minimal affordance on state changes'],
  ];
  return (
    <section id="scorecard">
      <div className="page">
        <div className="eyebrow"><span className="num">02</span> Scorecard</div>
        <h2>How it grades, <em>by dimension.</em></h2>
        <p className="lede">Grades are earned against the baseline a professional B2B SaaS product is expected to hit in 2026 — not against other fire-suppression software, which is almost universally worse.</p>
        <div className="scorecard">
          {rows.map(([name, grade, cls, sub], i) => (
            <div key={i} className="score">
              <div className="name">{name}</div>
              <div className={`grade ${cls}`}>{grade}</div>
              <div className="sub">{sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cohesion() {
  return (
    <section id="cohesion">
      <div className="page">
        <div className="eyebrow"><span className="num">03</span> Brand cohesion</div>
        <h2>Three surfaces, <em>three identities.</em></h2>
        <p className="lede">The site, the app, and the portal should feel like one company. Right now they read as three acquisitions that haven't been integrated. The portal especially — white background, no visual language carrying over — feels like a default Stripe checkout wearing an orange button.</p>

        {/* Three-up identity comparison */}
        <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:20, marginTop:16}}>
          {[
            {name:'Public website', bg:'#14141E', fg:'#E8E8EE', accent:'#E8601C', sub:'Dark · Bold · Sans stack', vibe:'Confident operator'},
            {name:'Field app', bg:'#1A1A2A', fg:'#E8E8EE', accent:'#E8601C', sub:'Dark · Dense · Utility', vibe:'Half-finished tool'},
            {name:'Customer portal', bg:'#FFFFFF', fg:'#111', accent:'#E8601C', sub:'Light · Sparse · Neutral', vibe:'Generic SaaS form'},
          ].map((s, i) => (
            <div key={i} style={{background:'white', border:'1px solid var(--rule)', borderRadius:4, overflow:'hidden'}}>
              <div style={{background:s.bg, color:s.fg, padding:'36px 24px', textAlign:'center', borderBottom:'1px solid var(--rule)'}}>
                <div style={{fontSize:11, fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.12em', color:s.accent, marginBottom:10}}>SA</div>
                <div style={{fontSize:20, fontWeight:600}}>Stephens Advanced</div>
                <div style={{background:s.accent, color:'white', display:'inline-block', padding:'6px 14px', borderRadius:3, fontSize:11, fontWeight:600, marginTop:14}}>Primary CTA</div>
              </div>
              <div style={{padding:'14px 16px'}}>
                <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:'var(--ink-3)', letterSpacing:'0.1em'}}>{s.name.toUpperCase()}</div>
                <div style={{fontSize:13, fontWeight:500, marginTop:4}}>{s.vibe}</div>
                <div style={{fontSize:12, color:'var(--ink-2)', marginTop:4}}>{s.sub}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="issues">
          <IssueRow
            n="01"
            where="All surfaces"
            severity="crit"
            title="The portal breaks the brand in half."
            desc="The public site and field app are both dark with orange accents. The customer portal is white with an orange button. To a customer who just got a text link, landing on a white page doesn't feel like the same company."
            why="Brand trust in B2B services is 90% consistency. Customers using the portal are paying invoices — the exact moment trust matters most. A visual disconnect at payment time increases support tickets and chargebacks."
            fix="Unify the portal on the dark system. Keep forms high-contrast and readable (white text on #0A0A10, WCAG AA passes at 15:1). If a light version is needed for accessibility or printing, make it a toggle — not the default."
          />
          <IssueRow
            n="02"
            where="All surfaces"
            severity="high"
            title="The orange carries too much weight."
            desc="Orange (#E8601C) is the logo color, the primary CTA, the secondary CTA, the stat emphasis, the calendar day fill, the chat bubble, the tag color, and the link color. It's everywhere. When everything is accented, nothing is."
            why="A single-color brand system needs a disciplined supporting palette. Without one, every orange element competes, and users lose the ability to parse 'this is the primary action on this screen.'"
            fix="Keep orange as the CTA + brand mark only. Introduce two neutral-tinted supporting colors (a warm gray and a cool slate) for tags, stats, and decoration. Use a second accent only for destructive or alert states (muted red)."
          />
          <IssueRow
            n="03"
            where="All surfaces"
            severity="high"
            title="There's no typographic system."
            desc="Based on the live surfaces, there's effectively one sans font at a few sizes, all bold or semibold. No display face, no editorial voice, no mono for technical data."
            why="This is a technical, operator-heavy business — invoices, part numbers, compliance codes. Monospace for structured data and a display serif for headers would instantly elevate perceived professionalism and make dense screens more scannable."
            fix="Adopt a 3-face system: a neutral sans for UI (Inter or similar), a display serif for hero headlines and section titles (Fraunces, Signifier), and a mono for codes/invoices/stats (JetBrains Mono, Berkeley Mono)."
          />
        </div>
      </div>
    </section>
  );
}

function IssueRow({ n, where, severity, title, desc, why, fix }) {
  const sevLabel = severity === 'crit' ? 'Critical' : severity === 'high' ? 'High' : 'Medium';
  return (
    <div className="issue">
      <div className="n">{n}</div>
      <div>
        <div className="where">{where}</div>
        <div className={`severity ${severity}`}>{sevLabel}</div>
        <h3 style={{marginTop:10}}>{title}</h3>
        <p>{desc}</p>
      </div>
      <div>
        <h4>Why it matters</h4>
        <p>{why}</p>
      </div>
      <div className="fix">
        <h4>Specific fix</h4>
        <p>{fix}</p>
      </div>
    </div>
  );
}

function BeforeAfter({ BeforeComp, AfterComp, frame='browser' }) {
  const Frame = ({ children, dark }) => {
    if (frame === 'phone') {
      return (
        <div className="phone-frame">
          <div className="notch"></div>
          <div className="screen">{children}</div>
        </div>
      );
    }
    return (
      <div className="browser-frame">
        <div className="chrome">
          <div className="dot" style={{background:'#ff5f57'}}></div>
          <div className="dot" style={{background:'#febc2e'}}></div>
          <div className="dot" style={{background:'#28c840'}}></div>
          <div className="url">stephensadvanced.com</div>
        </div>
        <div className="screen">{children}</div>
      </div>
    );
  };
  return (
    <div className="two" style={{marginTop:32}}>
      <div className="ba-card before">
        <div className="label">Current <span className="pill">as reconstructed</span></div>
        <div className="frame"><Frame><BeforeComp/></Frame></div>
      </div>
      <div className="ba-card after">
        <div className="label">Redesigned <span className="pill">proposal</span></div>
        <div className="frame"><Frame><AfterComp/></Frame></div>
      </div>
    </div>
  );
}

function WebsiteSection() {
  return (
    <section id="website">
      <div className="page">
        <div className="eyebrow"><span className="num">04</span> Public website</div>
        <h2>Confident operator, <em>muted voice.</em></h2>
        <p className="lede">The site's instincts are right — dark, serious, utilitarian. But the execution leans on a generic B2B template: centered hero, three service cards, stats strip. For a 22-year-old company managing 18,000 systems, the copy should be louder and the type should carry more personality.</p>

        <BeforeAfter BeforeComp={window.WebsiteCurrent} AfterComp={window.WebsiteRedesign} frame="browser" />

        <div className="issues">
          <IssueRow n="04" where="Site · Hero" severity="high"
            title="The hero is a shrug."
            desc="‘Fire Suppression Inspections, Done Right.’ is safe to the point of invisible. Centered layout, small subhead, two equally-weighted buttons. Nothing tells me why I'd pick Stephens over the three competitors I already called."
            why="A hero is 4 seconds. Generic copy + generic layout = a contractor bounces to the next search result. Your operational edge (18K systems, DFW speed, real software) is your actual pitch — put it in the headline."
            fix="Serif display headline, left-aligned, that states a position (‘The fire suppression company that shows up’). One primary CTA, one ghost link. Replace the decorative hero image slot with a real field photo — NFPA-tagged extinguishers, a tech at a hood panel."
          />
          <IssueRow n="05" where="Site · Stats bar" severity="med"
            title="Stats are vague and visually flat."
            desc="‘DFW Coverage Area’ and ‘24/7 Service Available’ read like bullet points on a brochure. ‘18,000+’ with no context is impressive but unanchored."
            why="Specific numbers build trust. Vague superlatives sound like every competitor. A procurement lead scans for proof points — give them proof points that aren't platitudes."
            fix="Replace with ‘18,000 systems under contract · 17 cities · <4 hr emergency SLA · NFPA-certified since 2004.’ Typeset in serif display (Fraunces 28–36), thin rules between cells, no orange fills."
          />
          <IssueRow n="06" where="Site · Services" severity="med"
            title="Service cards are identical boxes."
            desc="Three cards, each with a small orange square, same treatment, same length. No visual hook, no differentiation between suppression (complex, high-margin) and extinguishers (volume, commodity)."
            why="Services are the product. If they all look the same, buyers can't tell what you're known for. Suppression should feel like the flagship."
            fix="Numbered index grid (/01, /02, /03), thin rules, asymmetric — suppression card 2x wider with a real product photo. Remove icon blocks; use typographic numbering instead."
          />
        </div>
      </div>
    </section>
  );
}

function AppSection() {
  return (
    <section id="app">
      <div className="page">
        <div className="eyebrow"><span className="num">05</span> Field app (mobile)</div>
        <h2>Where the <em>real damage</em> is.</h2>
        <p className="lede">Jon is standing on a ladder under a kitchen hood, gloves on, phone in one hand. This app needs to be bigger, bolder, and ruthlessly prioritized. Right now it's a desktop CRM shrunk to a phone — small tap targets, fussy toggles, a month-view calendar when Jon needs to know what's next.</p>

        <h3 style={{fontFamily:'Fraunces, serif', fontSize:26, fontWeight:500, marginTop:48, marginBottom:8}}>Home screen</h3>
        <p style={{color:'var(--ink-2)', maxWidth:640, marginBottom:0}}>The home screen should answer one question: <em>where am I going next?</em> Not nine.</p>
        <BeforeAfter BeforeComp={window.AppHomeCurrent} AfterComp={window.AppHomeRedesign} frame="phone" />

        <h3 style={{fontFamily:'Fraunces, serif', fontSize:26, fontWeight:500, marginTop:72, marginBottom:8}}>Job detail</h3>
        <p style={{color:'var(--ink-2)', maxWidth:640, marginBottom:0}}>This is the hottest path in the whole product. It ends in money leaving a customer's account. Treat it like that.</p>
        <BeforeAfter BeforeComp={window.JobDetailCurrent} AfterComp={window.JobDetailRedesign} frame="phone" />

        <div className="issues">
          <IssueRow n="07" where="App · Home" severity="crit"
            title="The calendar is the wrong primary element."
            desc="The home screen leads with a month grid showing dots on days. A field technician doesn't need a month view to do their job — they need to know what's next, is the truck stocked, and what went wrong yesterday."
            why="Every tap on ‘next job’ that goes through the calendar is a navigation tax on a 50-stop week. Jon will do it 300 times. Shave 2 seconds off and you save him ~10 minutes a day."
            fix="Lead with a full-width ‘Today’ card — next stop name, address, ETA, Navigate CTA. Demote the calendar to a 7-day strip or a separate tab. Month view belongs in ‘Jobs’, not home."
          />
          <IssueRow n="08" where="App · Status tags" severity="high"
            title="Status tags have no visual grammar."
            desc="SUPPRESSION, EXT, E-LIGHTS, OVERDUE, JON — all in the same monospace pill. ‘JON’ is an assigned-tech tag. ‘OVERDUE’ is a status. ‘SUPPRESSION’ is a service type. Same visual treatment for three different categories."
            why="Without visual grammar, Jon has to read every tag to parse it. On a list of 50 jobs, that's a meaningful cognitive load. Overdue should scream; service type should whisper."
            fix="Three tag styles: service type (outlined, neutral), person (small round avatar with initials, not a text pill), status (filled, color-coded — amber overdue, green complete, red emergency). Limit to 2 tags per card, ever."
          />
          <IssueRow n="09" where="App · Home · Overdue banner" severity="med"
            title="The 12-overdue alarm is always on."
            desc="A persistent red alert bar for a state that is essentially permanent trains users to ignore it. If there are always ~12 overdue jobs, red loses all signaling value."
            why="Banner fatigue is real. When the count drops from 12 to 0, nobody notices — because nobody looks anymore. You've burned your alarm channel on noise."
            fix="Amber, not red. Left-bordered accent instead of full-width fill. Show the oldest one's age (‘23 days overdue’) for actionable context. Reserve red for actual emergencies — 911 dispatches, fire-event service calls."
          />
          <IssueRow n="10" where="Job detail · Complete flow" severity="crit"
            title="The complete-job flow is a minefield."
            desc="Build Invoice toggle, Prompt-Pay checkbox, Add Photo, tech notes, work order, and the primary Complete-Job-Generate-Invoice button all live on the same scroll. The relationship between the toggle, the checkbox, and the button is not visually clear. Ambiguity here generates wrong invoices."
            why="Mis-invoicing is the single worst UX failure in a field-service app. It triggers customer disputes, accounting rework, and sometimes chargebacks. The UI should make it impossible to send the wrong thing."
            fix="Group invoicing into one bordered block (‘Invoice on complete’ as a toggle, with sub-controls revealed when on — amount, recipient, discount). Primary CTA becomes explicit: ‘Complete job · Send $349 invoice’ — the literal action spelled out."
          />
          <IssueRow n="11" where="App · Bottom nav" severity="med"
            title="Bottom-nav labels are cryptic and targets are small."
            desc="Cal / Jobs / Clients / Money / Techs — ‘Cal’ is a weirdly truncated ‘Calendar’, ‘Money’ is vague (invoices? payroll?), ‘Techs’ implies Jon manages a team he may not manage. Icons are too small to tap while walking."
            why="Bottom-nav taps are the highest-frequency interactions in a mobile app. Mistap rate compounds across a 10-hour field day."
            fix="Today · Jobs · Clients · Money · Crew — spelled out. Minimum 44×44 touch targets, larger icons, active state uses both color and a filled background to be readable in sunlight."
          />
        </div>
      </div>
    </section>
  );
}

function PortalSection() {
  return (
    <section id="portal">
      <div className="page">
        <div className="eyebrow"><span className="num">06</span> Customer portal</div>
        <h2>A white page where <em>trust should be.</em></h2>
        <p className="lede">This is where customers pay you. It should feel secure, branded, and as considered as the site that convinced them to become customers. Right now it feels like a placeholder.</p>

        <BeforeAfter BeforeComp={window.PortalCurrent} AfterComp={window.PortalRedesign} frame="browser" />

        <div className="issues">
          <IssueRow n="12" where="Portal · Theme" severity="crit"
            title="Light theme breaks the brand."
            desc="Customer just clicked an SMS link from a Stephens invoice. They land on white. No visual continuity with the company they're paying. No trust cues."
            why="Payment pages are phishing targets. The #1 defense against ‘is this legit?’ is visual continuity with the brand the user expects to see. Dark background with the Stephens mark immediately signals ‘yes, this is them.’"
            fix="Port the dark system to the portal. Add a visible lock/shield indicator near the form. Add the support phone number in the footer — real companies show a phone number, scams don't."
          />
          <IssueRow n="13" where="Portal · Forms" severity="high"
            title="Two forms on one screen, no hierarchy."
            desc="‘Sign In’ and ‘Pay an Invoice’ are sibling cards of equal weight. 80% of portal traffic is probably one of these two — which one? Design it that way."
            why="Splitting traffic across two equally-prominent forms doubles decision time and increases mis-clicks. Analytics likely show the vast majority going to one path."
            fix="Make sign-in the default, pay-an-invoice a tab or secondary link. If both are equally common, it's still better as tabs than stacked cards — one task at a time."
          />
          <IssueRow n="14" where="Portal · Trust cues" severity="high"
            title="No indicators that this is a real, secure page."
            desc="No lock icon, no ‘encrypted’ language, no customer support phone, no company address in the footer."
            why="Customers being texted a link with no prior context need signals. Phishing awareness campaigns have trained them to look for these cues, and their absence is itself suspicious."
            fix="Add: lock glyph + ‘encrypted, no password needed’ microcopy, support phone number, real footer with address and last-updated timestamp."
          />
        </div>
      </div>
    </section>
  );
}

function ChatSection() {
  return (
    <section id="chat">
      <div className="page">
        <div className="eyebrow"><span className="num">07</span> Riker chat widget</div>
        <h2>Nobody knows <em>what Riker does.</em></h2>
        <p className="lede">‘Chat with Riker’ is a floating orange bubble with no context. Is Riker a person? An AI? Support? Sales? A Star Trek reference? Customers won't click it because they don't know what they're getting, and technicians won't trust it because it hasn't earned their trust.</p>

        <BeforeAfter BeforeComp={window.ChatCurrent} AfterComp={window.ChatRedesign} frame="browser" />

        <div className="issues">
          <IssueRow n="15" where="Chat · Entry point" severity="high"
            title="The bubble is a mystery box."
            desc="A branded orange CTA bubble in the corner reading ‘Chat with Riker’ asks customers to initiate a conversation with an unnamed entity. First-time users won't click."
            why="Chat is only useful if people use it. A 2% click rate because nobody trusts the entry point means you built an AI the company can't benefit from."
            fix="Replace the bubble with a thin, always-visible support bar at the bottom-right: green dot, ‘Ask us anything’, typical response time. On hover/open, explain who answers — AI-first, with a real person as escalation. Drop the ‘Riker’ name from the entry point; save it as the assistant's self-introduction after open."
          />
          <IssueRow n="16" where="Chat · Opening state" severity="high"
            title="A blank ‘Ask anything...’ is a dead end."
            desc="When opened, the chat shows a generic greeting and an empty input. Most users don't know what to ask, so they close it."
            why="Cold chat interfaces get 5–10x less usage than interfaces that suggest starter actions. This is the single highest-leverage fix in the product."
            fix="Open with 4 tappable starters: ‘Schedule an inspection’, ‘Find a past report’, ‘Pay an invoice’, ‘Request a quote.’ Each should route to a specific AI flow. The text input is a fallback, not the primary action."
          />
          <IssueRow n="17" where="Chat · Persona" severity="med"
            title="‘Riker’ is a fun internal name, a confusing external one."
            desc="Naming an AI ‘Riker’ (presumably a Star Trek reference) is delightful internally but meaningless to customers, and slightly unsettling when combined with ‘AI Assistant’ labeling — feels off-brand for a serious compliance company."
            why="Customers want to know they're talking to either an AI or a human. Not a character. Fire safety is a trust business."
            fix="Rename external-facing chat to ‘Stephens Support’ or similar plain language. Keep Riker as the AI's self-introduction after engagement begins, if you want to keep the personality. Internal/contractor-facing chat can stay Riker."
          />
        </div>
      </div>
    </section>
  );
}

function Roadmap() {
  return (
    <section id="roadmap">
      <div className="page">
        <div className="eyebrow"><span className="num">08</span> Roadmap</div>
        <h2>If you fix nothing else, <em>fix these seven.</em></h2>
        <p className="lede">Ordered by effort-to-impact ratio. Items 1–3 are a week of focused work and will change how the whole product feels.</p>

        <div style={{marginTop:40, display:'grid', gap:0, borderTop:'1px solid var(--rule)'}}>
          {[
            ['Week 1', 'Surface Reports as a real destination', 'Remove the hidden logo-tap gesture. Add Reports to the bottom nav or profile menu. Flag the AR-aging anomaly at the top of the view.', '1 day design + 1 day eng'],
            ['Week 1', 'Unify the portal on the dark system', 'Port the portal to the dark palette with full brand mark, support phone, and security cues. Single highest-impact public-facing fix.', 'Design + 2 days eng'],
            ['Week 2', 'Rebuild the home screen of the field app', 'Replace month-calendar-first layout with Today-card-first. Demote calendar to tab. Ship bigger touch targets and clearer labels.', '3 days design + 3 days eng'],
            ['Week 2', 'Render Riker\'s structured responses as cards, not markdown', 'Detect tabular responses server-side, render as tappable cards. Add 1–3 action buttons when Riker proposes actions.', '2 days design + 4 days eng'],
            ['Week 3', 'Redesign the job-complete flow', 'Group invoicing into one block, spell out the primary action, clarify toggle/checkbox relationships. Stop mis-invoices at the UI level.', '2 days design + 3 days eng'],
            ['Week 3', 'Adopt a type system + supporting palette', 'Add Fraunces (display), keep Inter (UI), add JetBrains Mono (codes/invoices). Introduce 2 neutral-tinted supporting colors so orange can breathe.', '3 days design'],
            ['Week 4', 'Rethink the chat entry point + opening state', 'Replace the bubble with a support bar. Open with 4 tappable starter actions. Split into "Stephens Support" (customer) and "Riker" (operator).', '2 days design + 4 days eng'],
          ].map(([when, title, desc, effort], i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'100px 1fr 200px', gap:32, padding:'24px 0', borderBottom:'1px solid var(--rule)', alignItems:'start'}}>
              <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:11, color:'var(--bad)', letterSpacing:'0.1em'}}>{when.toUpperCase()}</div>
              <div>
                <div style={{fontFamily:'Fraunces, serif', fontSize:22, fontWeight:500, letterSpacing:'-0.015em', marginBottom:6}}>{i+1}. {title}</div>
                <div style={{color:'var(--ink-2)', fontSize:14.5, lineHeight:1.55, maxWidth:620}}>{desc}</div>
              </div>
              <div style={{fontSize:12, color:'var(--ink-3)', fontFamily:'JetBrains Mono, monospace'}}>{effort}</div>
            </div>
          ))}
        </div>

        <div style={{marginTop:56, padding:'36px 40px', background:'white', border:'1px solid var(--rule)', borderRadius:4}}>
          <div className="kicker" style={{marginBottom:10}}>ONE MORE THING</div>
          <div style={{fontFamily:'Fraunces, serif', fontSize:26, fontWeight:500, letterSpacing:'-0.015em', lineHeight:1.2, maxWidth:760}}>
            The product is already better than the design. Fixing the design is how you start getting credit for the product.
          </div>
          <div style={{color:'var(--ink-2)', fontSize:14.5, lineHeight:1.6, maxWidth:680, marginTop:14}}>
            Most fire-suppression competitors don't have a tech-facing app, a customer portal, or an AI assistant. You have all three. They're just wearing a placeholder skin. A week of disciplined design turns Stephens Advanced from ‘impressive for a fire-suppression company' into 'impressive, full stop.'
          </div>
        </div>
      </div>
    </section>
  );
}

window.Scorecard = Scorecard;
window.Cohesion = Cohesion;
window.WebsiteSection = WebsiteSection;
window.AppSection = AppSection;
window.PortalSection = PortalSection;
window.ChatSection = ChatSection;
window.Roadmap = Roadmap;
window.BeforeAfter = BeforeAfter;
window.IssueRow = IssueRow;
