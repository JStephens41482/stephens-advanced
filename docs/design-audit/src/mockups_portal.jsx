// Customer portal — current + redesign

const PORTAL_ORANGE = '#E8601C';

function PortalCurrent() {
  return (
    <div style={{width:'100%', height:'100%', background:'#FFFFFF', color:'#111', fontFamily:'Inter, sans-serif', padding:'28px 24px', display:'flex', flexDirection:'column', gap:16}}>
      <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:8}}>
        <div style={{width:28, height:28, background:PORTAL_ORANGE, borderRadius:3}}></div>
        <div style={{fontWeight:700, fontSize:13}}>STEPHENS ADVANCED</div>
      </div>
      <div style={{fontSize:22, fontWeight:700, lineHeight:1.15, letterSpacing:'-0.01em'}}>Customer Portal</div>
      <div style={{border:'1px solid #e0e0e0', borderRadius:6, padding:16}}>
        <div style={{fontSize:13, fontWeight:600, marginBottom:6}}>Sign In</div>
        <div style={{fontSize:11, color:'#666', marginBottom:10}}>Enter your phone number and we'll text you a link.</div>
        <div style={{border:'1px solid #ccc', borderRadius:4, padding:'8px 10px', fontSize:11, color:'#999'}}>(817) 555-0100</div>
        <div style={{background:PORTAL_ORANGE, color:'white', padding:'9px', textAlign:'center', fontSize:12, fontWeight:600, borderRadius:4, marginTop:10}}>Send Link</div>
      </div>
      <div style={{border:'1px solid #e0e0e0', borderRadius:6, padding:16}}>
        <div style={{fontSize:13, fontWeight:600, marginBottom:6}}>Pay an Invoice</div>
        <div style={{fontSize:11, color:'#666', marginBottom:10}}>Look up your invoice number.</div>
        <div style={{border:'1px solid #ccc', borderRadius:4, padding:'8px 10px', fontSize:11, color:'#999'}}>INV-123456</div>
        <div style={{background:PORTAL_ORANGE, color:'white', padding:'9px', textAlign:'center', fontSize:12, fontWeight:600, borderRadius:4, marginTop:10}}>Look Up</div>
      </div>
    </div>
  );
}

function PortalRedesign() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0A0A10', color:'#E8E8EE', fontFamily:'Inter, sans-serif', padding:'28px 24px', display:'flex', flexDirection:'column', gap:18, position:'relative', overflow:'hidden'}}>
      <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:6}}>
        <div style={{width:22, height:22, border:`2px solid ${PORTAL_ORANGE}`, borderRadius:3, position:'relative'}}>
          <div style={{position:'absolute', inset:3, background:PORTAL_ORANGE, borderRadius:1}}></div>
        </div>
        <div style={{fontFamily:'Fraunces, serif', fontSize:14, fontWeight:500}}>Stephens Advanced</div>
        <div style={{marginLeft:'auto', fontSize:10, color:'#9A9AA8', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.1em'}}>CUSTOMER PORTAL</div>
      </div>

      <div style={{marginTop:6}}>
        <div style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:PORTAL_ORANGE, letterSpacing:'0.12em', marginBottom:10}}>SECURE SIGN-IN</div>
        <div style={{fontFamily:'Fraunces, serif', fontSize:26, fontWeight:500, lineHeight:1.08, letterSpacing:'-0.02em'}}>
          Welcome back.
        </div>
        <div style={{fontSize:12.5, color:'#B8B8C4', marginTop:6, lineHeight:1.5, maxWidth:300}}>
          Text yourself a sign-in link, or pay an invoice directly with the invoice number.
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:'flex', gap:0, borderBottom:'1px solid rgba(255,255,255,0.1)'}}>
        <div style={{padding:'9px 2px', marginRight:18, fontSize:12, fontWeight:600, borderBottom:`2px solid ${PORTAL_ORANGE}`, marginBottom:-1}}>Sign in</div>
        <div style={{padding:'9px 2px', fontSize:12, color:'#9A9AA8'}}>Pay an invoice</div>
      </div>

      <div>
        <div style={{fontSize:10.5, color:'#9A9AA8', fontFamily:'JetBrains Mono, monospace', letterSpacing:'0.1em', marginBottom:6}}>MOBILE NUMBER</div>
        <div style={{background:'#15151E', border:'1px solid #22222C', borderRadius:2, padding:'11px 14px', fontSize:14, fontWeight:500, display:'flex', alignItems:'center', gap:10}}>
          <span style={{color:'#9A9AA8'}}>🇺🇸</span>
          <span>(817) 555-0100</span>
        </div>
        <div style={{background:PORTAL_ORANGE, color:'white', padding:'12px', textAlign:'center', fontSize:12.5, fontWeight:600, borderRadius:2, marginTop:10, letterSpacing:'0.02em'}}>Text me a sign-in link →</div>
        <div style={{fontSize:10.5, color:'#9A9AA8', marginTop:10, display:'flex', alignItems:'center', gap:6}}>
          <span style={{width:6, height:6, borderRadius:'50%', background:'#4ADE80'}}></span>
          <span>Encrypted · No password needed</span>
        </div>
      </div>

      <div style={{marginTop:'auto', paddingTop:14, borderTop:'1px solid rgba(255,255,255,0.06)', fontSize:10.5, color:'#9A9AA8', display:'flex', justifyContent:'space-between'}}>
        <span>Need help? (817) 555-FIRE</span>
        <span>stephensadvanced.com</span>
      </div>
    </div>
  );
}

window.PortalCurrent = PortalCurrent;
window.PortalRedesign = PortalRedesign;
