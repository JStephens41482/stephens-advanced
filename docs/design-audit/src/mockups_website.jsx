// Stephens Advanced website — current state reconstruction + redesign
// Reconstructed from founder description; not a pixel copy of the live site.

const SA_ORANGE = '#E8601C';
const SA_DARK = '#14141E';
const SA_DARK_2 = '#1A1A2A';
const SA_DARK_3 = '#232334';
const SA_TEXT = '#E8E8EE';
const SA_MUTED = '#9A9AA8';

// ——— CURRENT ———
function WebsiteCurrent() {
  return (
    <div style={{
      width: '100%', height: '100%', background: SA_DARK, color: SA_TEXT,
      fontFamily: 'Inter, system-ui, sans-serif', position:'relative', overflow:'hidden'
    }}>
      {/* nav */}
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 24px', borderBottom:'1px solid #2a2a38'}}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <div style={{width:24, height:24, background:SA_ORANGE, borderRadius:3}}></div>
          <div style={{fontWeight:700, fontSize:13, letterSpacing:'0.02em'}}>STEPHENS ADVANCED</div>
        </div>
        <div style={{display:'flex', gap:18, fontSize:11, color:SA_MUTED}}>
          <span>Portal</span><span>Shop</span><span>Our Edge</span><span>Services</span><span>Contractors</span><span>Apply</span>
          <span style={{background:SA_ORANGE, color:'white', padding:'5px 10px', borderRadius:3, fontWeight:600}}>Request Service</span>
        </div>
      </div>

      {/* hero */}
      <div style={{padding:'44px 24px 32px', textAlign:'center'}}>
        <div style={{fontSize:11, color:SA_ORANGE, letterSpacing:'0.12em', fontWeight:600, marginBottom:10}}>FIRE SUPPRESSION · DFW</div>
        <div style={{fontSize:40, fontWeight:700, lineHeight:1.05, letterSpacing:'-0.02em', marginBottom:14}}>
          Fire Suppression Inspections,<br/>Done Right.
        </div>
        <div style={{fontSize:12, color:SA_MUTED, maxWidth:380, margin:'0 auto 18px'}}>
          Serving the Dallas–Fort Worth metroplex 24/7 with annual inspections, repairs, and compliance.
        </div>
        <div style={{display:'flex', gap:10, justifyContent:'center'}}>
          <div style={{background:SA_ORANGE, color:'white', padding:'10px 18px', borderRadius:3, fontWeight:600, fontSize:12}}>Request Service</div>
          <div style={{border:'1px solid #3a3a48', padding:'10px 18px', borderRadius:3, fontSize:12}}>Learn More</div>
        </div>
      </div>

      {/* stats bar */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:0, background:SA_DARK_2, borderTop:'1px solid #2a2a38', borderBottom:'1px solid #2a2a38'}}>
        {[['18,000+','Systems Managed'],['DFW','Coverage Area'],['24/7','Service Available']].map(([n,l],i)=>(
          <div key={i} style={{padding:'18px 12px', textAlign:'center', borderRight: i<2 ? '1px solid #2a2a38' : 'none'}}>
            <div style={{fontSize:22, fontWeight:700, color:SA_ORANGE}}>{n}</div>
            <div style={{fontSize:10, color:SA_MUTED, marginTop:3}}>{l}</div>
          </div>
        ))}
      </div>

      {/* service cards */}
      <div style={{padding:'28px 24px'}}>
        <div style={{fontSize:14, fontWeight:600, marginBottom:14}}>Services</div>
        <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10}}>
          {['Suppression','Extinguishers','Emergency Lights'].map((t,i)=>(
            <div key={i} style={{background:SA_DARK_2, border:'1px solid #2a2a38', padding:14, borderRadius:4}}>
              <div style={{width:24, height:24, background:SA_ORANGE, borderRadius:2, marginBottom:10, opacity:0.9}}></div>
              <div style={{fontSize:12, fontWeight:600, marginBottom:4}}>{t}</div>
              <div style={{fontSize:10, color:SA_MUTED, lineHeight:1.4}}>Annual inspections & repairs per NFPA code.</div>
            </div>
          ))}
        </div>
      </div>

      {/* chat bubble */}
      <div style={{position:'absolute', bottom:16, right:16, background:SA_ORANGE, color:'white', padding:'10px 14px', borderRadius:24, fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:8, boxShadow:'0 8px 20px rgba(0,0,0,0.4)'}}>
          💬 Chat with Riker
      </div>
    </div>
  );
}

// ——— REDESIGN ———
function WebsiteRedesign() {
  return (
    <div style={{
      width: '100%', height: '100%', background: '#0B0B12', color: SA_TEXT,
      fontFamily: 'Inter, system-ui, sans-serif', position:'relative', overflow:'hidden'
    }}>
      {/* nav */}
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 28px', borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <div style={{width:22, height:22, border:`2px solid ${SA_ORANGE}`, borderRadius:3, position:'relative'}}>
            <div style={{position:'absolute', inset:3, background:SA_ORANGE, borderRadius:1}}></div>
          </div>
          <div style={{fontFamily:'Fraunces, serif', fontWeight:500, fontSize:15, letterSpacing:'-0.01em'}}>Stephens Advanced</div>
        </div>
        <div style={{display:'flex', gap:22, fontSize:12, color:'#C8C8D4', alignItems:'center'}}>
          <span>Services</span><span>Our Edge</span><span>For Contractors</span><span>Shop</span>
          <span style={{color:SA_MUTED}}>·</span>
          <span style={{color:SA_MUTED}}>Portal</span>
          <span style={{background:SA_ORANGE, color:'white', padding:'7px 14px', borderRadius:2, fontWeight:500, letterSpacing:'0.01em'}}>Request Service</span>
        </div>
      </div>

      {/* hero */}
      <div style={{padding:'52px 28px 24px', display:'grid', gridTemplateColumns:'1.2fr 1fr', gap:28, alignItems:'end'}}>
        <div>
          <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:SA_ORANGE, letterSpacing:'0.16em', marginBottom:16}}>DFW · NFPA CERTIFIED · EST. 2004</div>
          <div style={{fontFamily:'Fraunces, serif', fontSize:44, fontWeight:500, lineHeight:0.98, letterSpacing:'-0.025em', marginBottom:16}}>
            The fire suppression<br/>company that<br/><em style={{fontStyle:'italic', color:SA_ORANGE}}>shows up.</em>
          </div>
          <div style={{fontSize:13, color:'#B8B8C4', maxWidth:340, marginBottom:20, lineHeight:1.5}}>
            18,000 systems across the metroplex, inspected on schedule. No missed windows. No chasing paperwork.
          </div>
          <div style={{display:'flex', gap:10}}>
            <div style={{background:SA_ORANGE, color:'white', padding:'11px 18px', borderRadius:2, fontWeight:500, fontSize:12, letterSpacing:'0.01em'}}>Request Service →</div>
            <div style={{color:'#C8C8D4', padding:'11px 8px', fontSize:12, borderBottom:'1px solid #444'}}>See how we work</div>
          </div>
        </div>
        {/* hero visual placeholder — stripes for "imagery goes here" */}
        <div style={{aspectRatio:'4/3', borderRadius:3, backgroundImage:'repeating-linear-gradient(135deg, #1a1a24, #1a1a24 6px, #13131c 6px, #13131c 12px)', border:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'flex-end', padding:12}}>
          <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:9, color:SA_MUTED}}>FIELD PHOTO · TECHNICIAN AT PANEL</div>
        </div>
      </div>

      {/* stats bar — refined */}
      <div style={{margin:'0 28px', padding:'18px 0', borderTop:'1px solid rgba(255,255,255,0.08)', borderBottom:'1px solid rgba(255,255,255,0.08)', display:'grid', gridTemplateColumns:'repeat(3,1fr)'}}>
        {[['18,000','Systems under contract'],['17 cities','DFW service radius'],['< 4 hrs','Emergency response SLA']].map(([n,l],i)=>(
          <div key={i} style={{padding:'0 16px', borderRight: i<2 ? '1px solid rgba(255,255,255,0.06)' : 'none'}}>
            <div style={{fontFamily:'Fraunces, serif', fontSize:28, fontWeight:500, letterSpacing:'-0.02em'}}>{n}</div>
            <div style={{fontSize:10.5, color:SA_MUTED, marginTop:2, letterSpacing:'0.04em'}}>{l}</div>
          </div>
        ))}
      </div>

      {/* service grid — tighter hierarchy */}
      <div style={{padding:'24px 28px 28px'}}>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:14}}>
          <div style={{fontFamily:'Fraunces, serif', fontSize:18, fontWeight:500}}>What we inspect.</div>
          <div style={{fontSize:11, color:SA_MUTED, fontFamily:'JetBrains Mono, monospace'}}>03 SERVICES →</div>
        </div>
        <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:1, background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.06)'}}>
          {[['01','Kitchen suppression','Ansul, Pyro-Chem, Range Guard'],['02','Extinguishers','Annual + hydro per NFPA 10'],['03','Emergency lighting','Monthly + 90-min annual']].map(([n,t,s],i)=>(
            <div key={i} style={{background:'#0B0B12', padding:'18px 14px'}}>
              <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:SA_ORANGE, marginBottom:12}}>/{n}</div>
              <div style={{fontSize:14, fontWeight:500, marginBottom:5, letterSpacing:'-0.005em'}}>{t}</div>
              <div style={{fontSize:11, color:SA_MUTED, lineHeight:1.5}}>{s}</div>
            </div>
          ))}
        </div>
      </div>

      {/* chat — rethought as support bar */}
      <div style={{position:'absolute', bottom:14, right:14, background:'rgba(20,20,30,0.92)', border:'1px solid rgba(255,255,255,0.1)', padding:'8px 12px', borderRadius:2, fontSize:11, display:'flex', alignItems:'center', gap:10, backdropFilter:'blur(12px)'}}>
        <div style={{width:7, height:7, borderRadius:'50%', background:'#4ADE80'}}></div>
        <span style={{color:'#C8C8D4'}}>Ask us anything</span>
        <span style={{color:SA_MUTED, fontSize:10}}>·</span>
        <span style={{color:SA_ORANGE, fontWeight:500}}>Open chat</span>
      </div>
    </div>
  );
}

window.WebsiteCurrent = WebsiteCurrent;
window.WebsiteRedesign = WebsiteRedesign;
