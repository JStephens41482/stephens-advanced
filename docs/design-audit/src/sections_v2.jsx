// Additional audit sections: Reports, Riker agentic, Hidden nav, Corrections, updated Roadmap

function ReportsSection() {
  return (
    <section id="reports">
      <div className="page">
        <div className="eyebrow"><span className="num">08</span> Business reports</div>
        <h2>Data's all there. <em>Nobody can see it.</em></h2>
        <p className="lede">Reports is the unsung hero of the product — lifetime revenue, completion rate, AR aging, weekly/monthly breakdowns, all in one view. But it's laid out as raw key-value rows with zero visualization. The most important insight on the screen — <b>100% of $7,090 outstanding is 90+ days old</b> — is buried in a row that looks identical to "31-60 days: $0.00."</p>

        <window.BeforeAfter BeforeComp={window.ReportsCurrent} AfterComp={window.ReportsRedesign} frame="phone" />

        <div className="issues">
          <window.IssueRow n="18" where="Reports · AR aging" severity="crit"
            title="The AR anomaly isn't flagged."
            desc="Every outstanding dollar — $7,090.12 — sits in the 90+ day bucket. Current, 31-60, and 61-90 are all $0. This is the single most important operational signal in the whole reports view, and the UI treats it as just another row."
            why="Either collections has completely stopped (a crisis) or there's a data pipeline issue where recent invoices aren't counting as receivables (also a crisis, just a different one). Either way, the reports view should be screaming."
            fix="Detect this pattern and surface it at the top of reports: red left-border card, plain English ('100% of receivables are 90+ days old — review collections'). Add a horizontal stacked bar for the aging buckets so the distribution is visible at a glance."
          />
          <window.IssueRow n="19" where="Reports · KPI hero" severity="high"
            title="The orange KPI block is doing too much."
            desc="Four KPIs inside a solid orange card with white text. Works as a header treatment; fails as a dashboard. No trend, no comparison, no context. $29.77 avg job value could be great or terrible — you can't tell."
            why="A dashboard's job is to answer 'are things going well?' in under 3 seconds. Raw numbers without trend context can't do that."
            fix="Drop the orange fill (reserve orange for CTAs). KPI cards on dark background with: large number, label, a small trend delta ('+14% vs prior YTD' in green, '−$2.10 vs Q4' in amber). Add sparklines when vertical space allows."
          />
          <window.IssueRow n="20" where="Reports · Monthly breakdown" severity="med"
            title="Monthly rows are billed-vs-collected without a visual."
            desc="April: $11,171 billed / $5,971 collected. March: $16,147 / $12,294. Feb: $946 / $946. The gap between billed and collected is the whole story — and it's invisible in row form."
            why="Collection rate per month is a real operational metric. You can see at a glance April is at 53% collected vs March at 76% — but only if you do the math yourself in your head, every time."
            fix="Each month gets a small progress bar: filled to the collected ratio, color-coded (green >80%, orange 60-80%, red <60%). Billed and collected still shown as dollars but the bar is what the eye reads first."
          />
        </div>
      </div>
    </section>
  );
}

function RikerAgenticSection() {
  return (
    <section id="riker-agentic">
      <div className="page">
        <div className="eyebrow"><span className="num">09</span> Riker — the agentic layer</div>
        <h2>Riker is <em>the best thing you have.</em> The UI hides it.</h2>
        <p className="lede">A real Riker exchange: "show me my overdue jobs" returns a formatted table of 12 jobs with flags (Brycer filings, travel charges, resistant customers, duplicate overdue), ending with "Want me to start rescheduling any of these?" — this is genuine agentic behavior. But it's rendered as a dumped markdown table in a chat bubble, which fails as both chat and as a data view.</p>

        <window.BeforeAfter BeforeComp={window.RikerAgenticCurrent} AfterComp={window.RikerAgenticRedesign} frame="phone" />

        <div className="issues">
          <window.IssueRow n="21" where="Riker · Tabular responses" severity="crit"
            title="A markdown table in a chat bubble is the worst of both worlds."
            desc="The table is too wide for the bubble, too narrow for the data, uses monospace for alignment (which fights the rest of the type system), and tiny cells that can't be tapped."
            why="Riker's most useful responses are data queries. If the data view is unusable, the feature is unusable — and the sophistication of the backend is wasted."
            fix="Detect tabular responses server-side and render them as a list of cards (one per row) with structured fields — client, location, service tag, days overdue, flag. Each card is tappable to open the job. Only fall back to a real table when the user explicitly asks for one."
          />
          <window.IssueRow n="22" where="Riker · Action suggestions" severity="high"
            title="'Want me to start rescheduling?' is text, not action."
            desc="Riker is offering to do something — reschedule jobs — but the offer is plain text in a bubble. The user has to type back 'yes, start with the oldest 4' or similar, which is slower and more error-prone than tapping a button."
            why="Agentic AI only delivers on its promise when commitment is one tap away. Every 'yes, but' the user types is friction."
            fix="When Riker proposes an action, render it as 1-3 tappable action buttons directly under the message ('Reschedule all 12', 'Just the 4 flagged', 'Start with oldest'). Tapping commits to the subtask; a follow-up can still be typed."
          />
          <window.IssueRow n="23" where="Riker · Website vs app parity" severity="med"
            title="Riker behaves differently on the website than in the app."
            desc="Website Riker does lead-style scheduling ('found no Taqueria Test in Arlington… Jon's 10:30 slot works?'). App Riker does operations ('12 overdue, want to reschedule?'). Same entity, different jobs, no visible mode indicator."
            why="A single persona doing two very different jobs confuses customers (who get operator-style responses) and operators (who get customer-style responses) the moment context is ambiguous."
            fix="Two explicit surfaces: 'Stephens Support' (customer-facing, scheduling + questions, lives on website) and 'Riker' (operator-facing, full database access, lives in app). Same model underneath, different persona + permissions + examples in the opening state."
          />
        </div>
      </div>
    </section>
  );
}

function HiddenNavSection() {
  return (
    <section id="hidden">
      <div className="page">
        <div className="eyebrow"><span className="num">10</span> Hidden navigation & access patterns</div>
        <h2>A product <em>only the founder</em> can navigate.</h2>
        <p className="lede">The logo on the homepage is the entry point to the field app. The logo <em>inside</em> the app is the entry point to Reports. The pin 264526 gates the field app. None of this is discoverable — if the founder is hit by a bus, nobody else can get into the operational layer of their own product.</p>

        <div style={{marginTop:40, display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16}}>
          {[
            {label:'PUBLIC SITE', step:'Tap logo →', reveals:'Field App gate'},
            {label:'FIELD APP', step:'Enter pin: 264526', reveals:'Calendar / Jobs / Clients'},
            {label:'FIELD APP', step:'Tap logo again →', reveals:'Business Reports'},
          ].map((s, i) => (
            <div key={i} style={{background:'white', border:'1px solid var(--rule)', borderRadius:4, padding:'18px 20px'}}>
              <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:'var(--bad)', letterSpacing:'0.12em', marginBottom:12}}>STEP {i+1}</div>
              <div style={{fontSize:10.5, color:'var(--ink-3)', fontFamily:'JetBrains Mono, monospace', marginBottom:5}}>{s.label}</div>
              <div style={{fontFamily:'Fraunces, serif', fontSize:20, fontWeight:500, letterSpacing:'-0.01em', marginBottom:8, lineHeight:1.15}}>{s.step}</div>
              <div style={{fontSize:13, color:'var(--ink-2)', lineHeight:1.5}}>Reveals: <b>{s.reveals}</b></div>
            </div>
          ))}
        </div>

        <div className="issues">
          <window.IssueRow n="24" where="Site → App · Logo gesture" severity="crit"
            title="Tapping the logo to enter the field app is invisible."
            desc="There's no visual affordance that the logo is interactive beyond returning to home. A new employee or contractor cannot discover the field app exists without being told."
            why="A pin-gated, hidden-entry-point operational app is a bus-factor-1 system. It also makes onboarding new technicians a manual ritual: 'tap here, enter this number.' That doesn't scale past two people."
            fix="Dedicated /app route with its own sign-in page. Keep the pin for speed if you like (a single-field numeric keypad is fast), but the entry point should be a real URL and a real button. Logo stays as 'go home.'"
          />
          <window.IssueRow n="25" where="App · Logo-tap-to-reports" severity="crit"
            title="Reports hidden behind a second logo tap is a bug, not a feature."
            desc="Once in the field app, tapping the logo again opens Business Reports. There is no menu item, no nav entry, no indication this view exists. The only way to find it is to accidentally tap the logo — or be told."
            why="Reports contain $25k in revenue data, 100% of AR at 90+ days, and the operational KPIs. This is probably the most valuable view in the whole product, and it's orphaned."
            fix="Add Reports as an explicit destination. Either: (a) a sixth bottom-nav slot if you can reduce density elsewhere, or (b) a profile-menu item accessible from the avatar in the top-right, or (c) a dedicated 'Business' tab that replaces 'Techs' for solo operators."
          />
          <window.IssueRow n="26" where="App · Pin gate" severity="high"
            title="The pin is a speed bump wearing a security costume."
            desc="264526 is a 6-digit numeric pin with no lockout (presumably), no device binding, and is entered on a public URL. If treated as security, it's weak; if treated as speed-up, it's friction."
            why="Either it protects customer data (in which case it needs to be real auth: device-bound session, rate-limited, phishable-key-resistant), or it's convenience (in which case it should be a remembered session + biometric unlock)."
            fix="First launch: SMS-link sign-in tied to Jon's number, bind a device cookie for 30 days, unlock with Face ID/fingerprint after that. No pin. Faster and safer than the current flow."
          />
        </div>
      </div>
    </section>
  );
}

function CorrectionsSection() {
  return (
    <section id="corrections">
      <div className="page">
        <div className="eyebrow"><span className="num">11</span> Corrections from the live product</div>
        <h2>Things I got wrong, <em>and what they mean.</em></h2>
        <p className="lede">After reviewing the real screenshots, several findings changed. Leaving the trail visible instead of silently editing — the deltas are themselves useful.</p>

        <div style={{marginTop:40, borderTop:'1px solid var(--rule)'}}>
          {[
            {
              had: 'Job detail "Date / Status" header is flat',
              real: 'Date is green, status is right-aligned, with a blue "Add to Today\'s Schedule" CTA.',
              takeaway: 'The blue CTA is off-palette. Brand uses dark + orange everywhere else — a lone blue button breaks cohesion and competes with the main orange Complete-Job button. Make it orange-outline or ghost.'
            },
            {
              had: 'Overdue banner is red',
              real: 'Red-on-red persistent bar with 12-job count. Exactly as reconstructed.',
              takeaway: 'My critique stands — amber + accent border, not red fill. But also: Riker already knows how to explain the 12 overdue in context. The banner could tap through to "Ask Riker to handle these" instead of a generic list.'
            },
            {
              had: 'Status tags all look the same',
              real: 'Each tag is a different color (SUPPRESSION, EXT, E-LIGHTS, OVERDUE, JON). Better than I assumed, but the colors appear arbitrary, not systematic.',
              takeaway: 'Color-per-tag without a taxonomy is tag-soup. Establish three tag classes (service-type, status, person), each with its own visual treatment — shape + color together, not color alone.'
            },
            {
              had: 'Jobs list is a flat list',
              real: 'Jobs list has an "OVERDUE - 12" section header, swipe-to-reveal Delete + All, and a "SERVICE REQUEST" white badge.',
              takeaway: 'The grouping is good. Swipe actions labeled "Delete" and "All" are unclear — "All" doesn\'t say what it does. Rename. SERVICE REQUEST vs. scheduled-job needs a clearer visual distinction than a badge.'
            },
            {
              had: 'Prompt-pay is a generic checkbox',
              real: '"Customer paying now?" checkbox with subtext "10% prompt-pay discount applied if paid within 24 hours."',
              takeaway: 'The copy is good. Placement is bad — this is a pricing decision buried below notes. It should be inside the invoice block as a conditional option, not a sibling of the photo button.'
            },
            {
              had: 'Chat FAB is orange',
              real: 'The real Riker FAB is purple/blue with an orange "+" beneath it, not a single orange bubble.',
              takeaway: 'Two FABs stacked in the corner is worse than one. The orange + is a quick-create (new job?); Riker is chat. They\'re different actions, but stacking them without labels creates a "which one do I tap?" moment every time.'
            },
          ].map((c, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'50px 1fr 1fr 1fr', gap:24, padding:'22px 0', borderBottom:'1px solid var(--rule)'}}>
              <div style={{fontFamily:'Fraunces, serif', fontSize:22, color:'var(--ink-3)'}}>{i+1}</div>
              <div>
                <div style={{fontSize:10, color:'var(--bad)', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.1em', marginBottom:5}}>I ASSUMED</div>
                <div style={{fontSize:13.5, color:'var(--ink-2)', lineHeight:1.5}}>{c.had}</div>
              </div>
              <div>
                <div style={{fontSize:10, color:'var(--good)', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.1em', marginBottom:5}}>ACTUAL</div>
                <div style={{fontSize:13.5, color:'var(--ink-2)', lineHeight:1.5}}>{c.real}</div>
              </div>
              <div>
                <div style={{fontSize:10, color:'var(--ink-3)', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.1em', marginBottom:5}}>SO:</div>
                <div style={{fontSize:13.5, color:'var(--ink)', lineHeight:1.5}}>{c.takeaway}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Expose BeforeAfter + IssueRow to window since they live in sections.jsx
window.ReportsSection = ReportsSection;
window.RikerAgenticSection = RikerAgenticSection;
window.HiddenNavSection = HiddenNavSection;
window.CorrectionsSection = CorrectionsSection;
