// Riker chat widget — current + redesign

const RIKER_ORANGE = '#E8601C';

function ChatCurrent() {
  return (
    <div style={{width:'100%', height:'100%', background:'#14141E', position:'relative', fontFamily:'Inter, sans-serif', padding:20}}>
      {/* fake page behind */}
      <div style={{position:'absolute', inset:20, background:'repeating-linear-gradient(135deg, #1a1a24, #1a1a24 8px, #13131c 8px, #13131c 16px)', borderRadius:4, opacity:0.6}}></div>

      {/* chat panel */}
      <div style={{position:'absolute', right:20, bottom:20, width:260, background:'#1A1A2A', border:'1px solid #2a2a38', borderRadius:8, overflow:'hidden', boxShadow:'0 20px 40px rgba(0,0,0,0.5)'}}>
        <div style={{background:RIKER_ORANGE, padding:'10px 12px', display:'flex', alignItems:'center', gap:8}}>
          <div style={{width:24, height:24, borderRadius:'50%', background:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12}}>🤖</div>
          <div>
            <div style={{fontSize:12, color:'white', fontWeight:700}}>Riker</div>
            <div style={{fontSize:9, color:'rgba(255,255,255,0.8)'}}>AI Assistant</div>
          </div>
          <div style={{marginLeft:'auto', color:'white', fontSize:14}}>×</div>
        </div>
        <div style={{padding:'12px', height:180, display:'flex', flexDirection:'column', gap:8}}>
          <div style={{background:'#232334', padding:'8px 10px', borderRadius:10, fontSize:11, color:'#E8E8EE', alignSelf:'flex-start', maxWidth:'80%'}}>
            Hi! I'm Riker, your AI assistant. How can I help?
          </div>
        </div>
        <div style={{borderTop:'1px solid #2a2a38', padding:'8px 10px', display:'flex', gap:6, alignItems:'center'}}>
          <div style={{flex:1, fontSize:11, color:'#666'}}>Ask anything...</div>
          <div style={{fontSize:14, color:RIKER_ORANGE}}>↑</div>
        </div>
      </div>
    </div>
  );
}

function ChatRedesign() {
  return (
    <div style={{width:'100%', height:'100%', background:'#0A0A10', position:'relative', fontFamily:'Inter, sans-serif', padding:20}}>
      {/* fake page behind */}
      <div style={{position:'absolute', inset:20, background:'repeating-linear-gradient(135deg, #12121a, #12121a 8px, #0e0e16 8px, #0e0e16 16px)', borderRadius:4, opacity:0.5}}></div>

      {/* chat panel */}
      <div style={{position:'absolute', right:20, bottom:20, width:280, background:'#14141E', border:'1px solid rgba(255,255,255,0.08)', borderRadius:3, overflow:'hidden', boxShadow:'0 24px 48px rgba(0,0,0,0.55)'}}>
        <div style={{padding:'14px 16px', borderBottom:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'flex-start', gap:10}}>
          <div style={{width:28, height:28, borderRadius:3, background:'rgba(232,96,28,0.12)', border:`1px solid ${RIKER_ORANGE}`, display:'flex', alignItems:'center', justifyContent:'center'}}>
            <div style={{width:8, height:8, background:RIKER_ORANGE, borderRadius:'50%'}}></div>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:12.5, color:'#E8E8EE', fontWeight:600}}>Service questions</div>
            <div style={{fontSize:10.5, color:'#9A9AA8', marginTop:1}}>Typically answers in under 30 seconds · Answered by AI + our team</div>
          </div>
          <div style={{color:'#9A9AA8', fontSize:13}}>×</div>
        </div>

        <div style={{padding:'14px 16px', display:'flex', flexDirection:'column', gap:10}}>
          <div style={{fontSize:11, color:'#9A9AA8', lineHeight:1.5}}>
            We handle scheduling, invoices, inspection reports, and repair quotes. What do you need?
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:5, marginTop:4}}>
            {['Schedule an inspection','Find a past report','Pay an invoice','Request a quote'].map((t,i)=>(
              <div key={i} style={{background:'#1a1a24', border:'1px solid #22222C', padding:'8px 11px', borderRadius:2, fontSize:11.5, color:'#E8E8EE'}}>
                {t} <span style={{color:'#9A9AA8', float:'right'}}>→</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{borderTop:'1px solid rgba(255,255,255,0.06)', padding:'10px 14px', display:'flex', gap:8, alignItems:'center'}}>
          <div style={{flex:1, fontSize:11.5, color:'#6A6A78'}}>Or type a question…</div>
          <div style={{width:24, height:24, borderRadius:2, background:RIKER_ORANGE, color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700}}>→</div>
        </div>
      </div>
    </div>
  );
}

window.ChatCurrent = ChatCurrent;
window.ChatRedesign = ChatRedesign;
